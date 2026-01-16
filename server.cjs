/**
 * anim5s server (spec 2026-01-15) — Phase4 Step2 hardening (V42)
 * Policy updates:
 *  - Rooms do NOT expire by time; unfinished rooms can be edited anytime.
 *  - Completed rooms (all frames committed) are NOT editable and are excluded from random/ID-join.
 *  - Room data is persisted to disk; only touched rooms are cached in memory (idle rooms are unloaded).
 *
 * WebSocket endpoint: /ws
 * Messages:
 *  - create_public_and_submit {theme, dataUrl} -> created_public + frame_committed
 *  - join_random -> room_joined
 *  - join_by_id {roomId} -> room_joined
 *  - join_room {roomId, view?, reservationToken?} -> room_state
 *  - resync {roomId?} -> room_state
 *  - get_frame {roomId, frameIndex} -> frame_data
 *  - submit_frame {roomId, frameIndex, reservationToken, dataUrl} -> submitted + frame_committed (+ start_playback when completed)
 */
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// Persist/cache
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const INDEX_FILE = path.join(DATA_DIR, "rooms_index.json");
fs.mkdirSync(ROOMS_DIR, { recursive: true });

// Backups (incremental snapshots)
const BACKUP_DIR = path.join(DATA_DIR, "backups");
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 30 * 60 * 1000); // 30 min
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 24);

// Track changed rooms for incremental backups
const dirtyRoomIds = new Set();
let lastBackupAt = 0;

const ROOM_CACHE_MAX = Number(process.env.ROOM_CACHE_MAX || 80);
const ROOM_CACHE_IDLE_MS = Number(process.env.ROOM_CACHE_IDLE_MS || 5 * 60 * 1000); // 5 min

// Reservation
const RESERVATION_MS = Number(process.env.RESERVATION_MS || 3 * 60 * 1000);

const THEME_POOL = [
  "走る犬","くるま","宇宙人","おにぎり","雨の日","ジャンプ","落下","変身","ねこパンチ",
  "通勤時間","料理","かくれんぼ","風船","雪だるま","電車","魔法","釣り","ダンス"
];

function now(){ return Date.now(); }
function randTheme(){ return THEME_POOL[Math.floor(Math.random()*THEME_POOL.length)]; }
function id7(){ return Math.random().toString(36).slice(2,9).toUpperCase(); }
function token(){ return Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2); }

const ROOM_ID_RE = /^[A-Z0-9]{6,12}$/;
function normalizeRoomId(x){
  const id = String(x || "").trim().toUpperCase();
  if (!ROOM_ID_RE.test(id)) return "";
  return id;
}

function validatePngDataUrl(s){
  if (typeof s !== "string") return false;
  if (!s.startsWith("data:image/")) return false;
  if (s.length > 1_500_000) return false;
  return true;
}

function safeReadJson(fp){
  try{ return JSON.parse(fs.readFileSync(fp, "utf8")); }catch(e){ return null; }
}

function atomicWriteFile(fp, data){
  const dir = path.dirname(fp);
  try{ fs.mkdirSync(dir, { recursive: true }); }catch(e){}
  const tmp = fp + ".tmp_" + process.pid + "_" + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function loadIndex(){
  const obj = safeReadJson(INDEX_FILE);
  return (obj && typeof obj === "object") ? obj : {};
}
let index = loadIndex();

function rebuildIndexFromDisk(){
  const out = {};
  let files = [];
  try{ files = fs.readdirSync(ROOMS_DIR); }catch(e){ return out; }

  for (const f of files){
    if (!f.endsWith(".json")) continue;
    const fp = path.join(ROOMS_DIR, f);
    const obj = safeReadJson(fp);
    if (!obj) continue;

    const rid = normalizeRoomId(obj.roomId || f.slice(0, -5));
    if (!rid) continue;

    const theme = (obj.theme && String(obj.theme).trim()) ? String(obj.theme).trim() : "";
    const createdAt = Number(obj.createdAt || 0) || 0;
    const updatedAt = Number(obj.updatedAt || 0) || 0;

    const committedArr = Array.isArray(obj.committed) ? obj.committed.map(Boolean)
                      : (Array.isArray(obj.filled) ? obj.filled.map(Boolean) : []);
    const filledCount = committedArr.reduce((a,b)=>a+(b?1:0), 0);
    const completed = (String(obj.phase || "") === "PLAYBACK") || filledCount >= 60;

    out[rid] = { roomId: rid, theme, createdAt, updatedAt, filledCount, completed };
  }
  return out;
}

function saveIndex(){
  try{
    atomicWriteFile(INDEX_FILE, JSON.stringify(index));
  }catch(e){}
}

// If index is missing/corrupted but rooms exist on disk, rebuild lazily on start.
if (!Object.keys(index).length){
  const rebuilt = rebuildIndexFromDisk();
  if (Object.keys(rebuilt).length){
    index = rebuilt;
    try{ atomicWriteFile(INDEX_FILE, JSON.stringify(index)); }catch(e){}
  }
}

function roomFile(roomId){
  const id = normalizeRoomId(roomId);
  if (!id) throw new Error("invalid roomId");
  return path.join(ROOMS_DIR, id + ".json");
}

function cleanupReservations(room){
  const t = now();
  for (const [tok, r] of room.reservations.entries()){
    if (!r || r.expiresAt <= t || room.committed[r.frameIndex]){
      room.reservations.delete(tok);
      const curTok = room.reservedByFrame.get(r.frameIndex);
      if (curTok === tok) room.reservedByFrame.delete(r.frameIndex);
    }
  }
}

// Normalize to "room stays editable until truly completed"
function normalizePhase(room){
  const done = room.committed.every(Boolean);
  if (done){
    room.phase = "PLAYBACK";
  }else{
    room.phase = "DRAWING";
  }
}

function deserializeRoom(obj){
  const roomId = normalizeRoomId(obj?.roomId);
  if (!roomId) return null;
  const frames = Array.isArray(obj?.frames) ? obj.frames.slice(0,60) : [];
  const committed = Array.isArray(obj?.committed) ? obj.committed.slice(0,60).map(Boolean) : [];
  while (frames.length < 60) frames.push(null);
  while (committed.length < 60) committed.push(false);

  const room = {
    roomId,
    theme: ((obj?.theme && String(obj.theme).trim()) ? String(obj.theme).trim() : randTheme()),
    frames,
    committed,
    createdAt: Number(obj?.createdAt || 0) || now(),
    updatedAt: Number(obj?.updatedAt || 0) || now(),
    phase: String(obj?.phase || "DRAWING"),
    reservations: new Map(),
    reservedByFrame: new Map(),
  };

  // reservations: [[tok, {frameIndex, expiresAt}], ...]
  if (Array.isArray(obj?.reservations)){
    for (const pair of obj.reservations){
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const tok = String(pair[0] || "");
      const r = pair[1] || {};
      const fi = Number(r.frameIndex);
      const ex = Number(r.expiresAt);
      if (!tok) continue;
      if (!Number.isFinite(fi) || fi < 0 || fi >= 60) continue;
      if (!Number.isFinite(ex) || ex <= 0) continue;
      room.reservations.set(tok, { frameIndex: fi, expiresAt: ex });
    }
  }

  // rebuild reservedByFrame
  for (const [tok, r] of room.reservations.entries()){
    if (room.committed[r.frameIndex]) continue;
    room.reservedByFrame.set(r.frameIndex, tok);
  }

  cleanupReservations(room);
  normalizePhase(room);
  return room;
}

function serializeRoom(room){
  cleanupReservations(room);
  normalizePhase(room);
  return {
    roomId: room.roomId,
    theme: room.theme,
    frames: room.frames,
    committed: room.committed,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    phase: room.phase,
    reservations: Array.from(room.reservations.entries()),
  };
}

function updateIndexFromRoom(room){
  const filledCount = room.committed.reduce((a,b)=>a+(b?1:0),0);
  index[room.roomId] = {
    roomId: room.roomId,
    theme: room.theme,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    filledCount,
    completed: room.phase === "PLAYBACK",
  };
}

const cache = new Map(); // roomId -> {room, lastAccess}
function touch(roomId){
  const e = cache.get(roomId);
  if (e) e.lastAccess = now();
}

function getRoom(roomId){
  const id = normalizeRoomId(roomId);
  if (!id) return null;

  const e = cache.get(id);
  if (e){
    e.lastAccess = now();
    return e.room;
  }

  const fp = roomFile(id);
  if (!fs.existsSync(fp)) return null;

  try{
    const raw = fs.readFileSync(fp, "utf8");
    const obj = JSON.parse(raw);
    const room = deserializeRoom(obj);
    if (!room) return null;
    cache.set(id, { room, lastAccess: now() });
    return room;
  }catch(e2){
    return null;
  }
}

function saveRoom(room){
  try{
    normalizePhase(room);
    cleanupReservations(room);
    updateIndexFromRoom(room);
    atomicWriteFile(roomFile(room.roomId), JSON.stringify(serializeRoom(room)));
    dirtyRoomIds.add(room.roomId);
    saveIndex();
  }catch(e){}
}

function evictCache(){
  const t = now();

  // idle eviction
  for (const [id, e] of cache.entries()){
    if ((t - e.lastAccess) > ROOM_CACHE_IDLE_MS){
      cache.delete(id);
    }
  }

  // size eviction (oldest first)
  if (cache.size > ROOM_CACHE_MAX){
    const arr = Array.from(cache.entries()).sort((a,b)=>a[1].lastAccess - b[1].lastAccess);
    const over = cache.size - ROOM_CACHE_MAX;
    for (let i=0;i<over;i++){
      cache.delete(arr[i][0]);
    }
  }
}
setInterval(evictCache, 15_000);

function pruneBackups(){
  try{
    const dirs = fs.readdirSync(BACKUP_DIR).filter(n=>!n.startsWith("."));
    dirs.sort();
    const over = dirs.length - BACKUP_KEEP;
    for (let i=0;i<over;i++){
      fs.rmSync(path.join(BACKUP_DIR, dirs[i]), { recursive:true, force:true });
    }
  }catch(e){}
}

function doBackup(){
  const t = now();
  if ((t - lastBackupAt) < BACKUP_INTERVAL_MS) return;
  if (dirtyRoomIds.size === 0) return;

  const stamp = new Date(t).toISOString().replace(/[:.]/g, "-");
  const dir = path.join(BACKUP_DIR, stamp);
  try{
    fs.mkdirSync(dir, { recursive:true });
    atomicWriteFile(path.join(dir, "rooms_index.json"), JSON.stringify(index));
    atomicWriteFile(path.join(dir, "manifest.json"), JSON.stringify({ ts: t, rooms: Array.from(dirtyRoomIds) }));
    for (const rid of dirtyRoomIds){
      try{
        const src = roomFile(rid);
        const dst = path.join(dir, rid + ".json");
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      }catch(e){}
    }
    dirtyRoomIds.clear();
    lastBackupAt = t;
    pruneBackups();
  }catch(e){}
}

// Run backup checks periodically (backs up only when there were changes)
setInterval(doBackup, 30_000);

function makeRoom(theme){
  const roomId = id7();
  const room = {
    roomId,
    theme: ((theme && String(theme).trim()) ? String(theme).trim() : randTheme()),
    frames: Array.from({length:60}, ()=>null),
    committed: Array.from({length:60}, ()=>false),
    createdAt: now(),
    updatedAt: now(),
    phase: "DRAWING",
    reservations: new Map(),
    reservedByFrame: new Map(),
  };
  cache.set(roomId, { room, lastAccess: now() });
  updateIndexFromRoom(room);
  saveRoom(room);
  return room;
}

function roomState(room){
  cleanupReservations(room);
  normalizePhase(room);
  return {
    roomId: room.roomId,
    theme: room.theme,
    frameCount: 60,
    fps: 12,
    phase: room.phase,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    filled: room.committed.slice(),
    completed: room.phase === "PLAYBACK",
  };
}

function firstYoungestEmpty(room){
  cleanupReservations(room);
  for (let i=0;i<60;i++){
    if (room.committed[i]) continue;
    if (room.reservedByFrame.has(i)) continue;
    return i;
  }
  return -1;
}

// Random join: pick any open (unfinished) room
function findRandomOpenRoomId(){
  const candidates = [];
  for (const rid in index){
    const meta = index[rid];
    if (!meta) continue;
    if (meta.completed) continue;
    if ((meta.filledCount || 0) >= 60) continue;
    candidates.push(rid);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random()*candidates.length)];
}

function send(ws, obj){
  try{ ws.send(JSON.stringify(obj)); }catch(e){}
}
function broadcast(roomId, obj){
  const text = JSON.stringify(obj);
  for (const ws of wss.clients){
    if (ws._roomId === roomId){
      try{ ws.send(text); }catch(e){}
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health"){
    res.writeHead(200, { "content-type":"application/json" });
    let roomsOnDisk = 0;
    let backups = 0;
    try{ roomsOnDisk = fs.readdirSync(ROOMS_DIR).filter(f=>f.endsWith(".json")).length; }catch(e){}
    try{ backups = fs.readdirSync(BACKUP_DIR).filter(n=>!n.startsWith(".")).length; }catch(e){}
    res.end(JSON.stringify({ ok:true, roomsInIndex: Object.keys(index).length, roomsOnDisk, cachedRooms: cache.size, backups, dataDir: DATA_DIR, ts: now() }));
    return;
  }
  res.writeHead(200, { "content-type":"text/plain; charset=utf-8" });
  res.end("anim5s ok");
});

const wss = new WebSocket.Server({ noServer:true, maxPayload: 2_000_000 });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws"){
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  ws._roomId = "";

  ws.on("message", (buf) => {
    let m = null;
    try{ m = JSON.parse(String(buf)); }catch(e){ return; }
    const t = String(m.t || "");
    const d = m.data || {};


    // Backward-compatible handshake (older clients send these)
    if (t === "hello"){
      send(ws, { v:1, t:"welcome", ts: now(), data:{ protocol:1, serverTime: now() } });
      return;
    }
    // Backward-compatible resync: keep lightweight (clients should request frames via get_frame)
    if (t === "resync"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      ws._roomId = room.roomId;
      send(ws, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      return;
    }

    if (t === "create_public_and_submit"){
      const theme = (d.theme && String(d.theme).trim()) ? String(d.theme).trim() : randTheme();
      const dataUrl = d.dataUrl;
      if (!validatePngDataUrl(dataUrl)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"dataUrl が不正/大きすぎる" } });
        return;
      }
      const room = makeRoom(theme);
      room.frames[0] = dataUrl;
      room.committed[0] = true;
      room.updatedAt = now();
      saveRoom(room);

      ws._roomId = room.roomId;
      send(ws, { v:1, t:"created_public", ts: now(), data: roomState(room) });
      broadcast(room.roomId, { v:1, t:"frame_committed", ts: now(), data:{ roomId: room.roomId, frameIndex:0 } });
      return;
    }

    if (t === "join_random"){
      const rid = findRandomOpenRoomId();
      if (!rid){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"参加できる公開作品がありません（まず誰かが公開で1コマ目を提出してね）" } });
        return;
      }
      const room = getRoom(rid);
      if (!room){
        // stale index
        delete index[rid];
        saveIndex();
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない（再試行してね）" } });
        return;
      }
      normalizePhase(room);
      if (room.phase !== "DRAWING"){
        updateIndexFromRoom(room); saveIndex();
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"参加できる部屋がありません（再試行してね）" } });
        return;
      }
      const idx = firstYoungestEmpty(room);
      if (idx < 0){
        updateIndexFromRoom(room); saveRoom(room);
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"空きコマがありません（再試行してね）" } });
        return;
      }
      const tok = token();
      const expiresAt = now() + RESERVATION_MS;
      room.reservations.set(tok, { frameIndex: idx, expiresAt });
      room.reservedByFrame.set(idx, tok);
      room.updatedAt = now();
      saveRoom(room);

      ws._roomId = room.roomId;
      send(ws, { v:1, t:"room_joined", ts: now(), data:{
        roomId: room.roomId,
        theme: room.theme,
        assignedFrame: idx,
        reservationToken: tok,
        reservationExpiresAt: expiresAt,
        filled: roomState(room).filled
      }});
      return;
    }

    if (t === "join_by_id"){
      const roomId = normalizeRoomId(d.roomId);
      if (!roomId){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } });
        return;
      }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      normalizePhase(room);
      if (room.phase !== "DRAWING"){
        // completed rooms are excluded from editing/joining
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      const idx = firstYoungestEmpty(room);
      if (idx < 0){
        updateIndexFromRoom(room); saveRoom(room);
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"空きコマがありません" } });
        return;
      }

      const tok = token();
      const expiresAt = now() + RESERVATION_MS;
      room.reservations.set(tok, { frameIndex: idx, expiresAt });
      room.reservedByFrame.set(idx, tok);
      room.updatedAt = now();
      saveRoom(room);

      ws._roomId = room.roomId;
      send(ws, { v:1, t:"room_joined", ts: now(), data:{
        roomId: room.roomId,
        theme: room.theme,
        assignedFrame: idx,
        reservationToken: tok,
        reservationExpiresAt: expiresAt,
        filled: roomState(room).filled
      }});
      return;
    }

    if (t === "join_room"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      ws._roomId = room.roomId;
      normalizePhase(room);

      if (d.view !== true && d.reservationToken){
        // editing join: must be DRAWING and have a valid reservation
        if (room.phase !== "DRAWING"){
          send(ws, { v:1, t:"error", ts: now(), data:{ message:"この部屋は編集できません（完成済み）" } });
          return;
        }
        cleanupReservations(room);
        const r = room.reservations.get(String(d.reservationToken));
        if (!r || r.expiresAt <= now()){
          send(ws, { v:1, t:"error", ts: now(), data:{ message:"予約が無効/期限切れです。もう一度参加してね" } });
          return;
        }
      }

      send(ws, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      return;
    }

    if (t === "resync"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      ws._roomId = room.roomId;
      send(ws, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      return;
    }

    if (t === "get_frame"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      const idx = Number(d.frameIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= 60){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"frameIndex が不正" } });
        return;
      }
      if (!room.committed[idx] || !room.frames[idx]) return;
      send(ws, { v:1, t:"frame_data", ts: now(), data:{ roomId: room.roomId, frameIndex: idx, dataUrl: room.frames[idx] } });
      return;
    }

    if (t === "submit_frame"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      const room = getRoom(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      normalizePhase(room);
      cleanupReservations(room);

      if (room.phase !== "DRAWING"){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"この部屋は提出を受け付けていません（完成済み）" } });
        return;
      }

      const idx = Number(d.frameIndex);
      const tok = String(d.reservationToken || "");
      const dataUrl = d.dataUrl;

      if (!Number.isFinite(idx) || idx<0 || idx>=60){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"frameIndex が不正" } });
        return;
      }
      if (!tok){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"reservationToken が必要" } });
        return;
      }
      const r = room.reservations.get(tok);
      if (!r || r.expiresAt <= now()){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"予約が無効/期限切れです" } });
        return;
      }
      if (r.frameIndex !== idx){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"担当コマが一致しません" } });
        return;
      }
      if (room.committed[idx]){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"すでに提出済みです" } });
        return;
      }
      if (!validatePngDataUrl(dataUrl)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"dataUrl が不正/大きすぎる" } });
        return;
      }

      room.frames[idx] = dataUrl;
      room.committed[idx] = true;
      room.updatedAt = now();

      // consume reservation
      room.reservations.delete(tok);
      room.reservedByFrame.delete(idx);

      saveRoom(room);

      broadcast(room.roomId, { v:1, t:"frame_committed", ts: now(), data:{ roomId: room.roomId, frameIndex: idx } });
      send(ws, { v:1, t:"submitted", ts: now(), data:{ roomId: room.roomId, frameIndex: idx } });

      if (room.committed.every(Boolean)){
        // Completed: lock and stop surfacing in join/random
        room.phase = "PLAYBACK";
        room.updatedAt = now();
        saveRoom(room);

        broadcast(room.roomId, { v:1, t:"start_playback", ts: now(), data:{ roomId: room.roomId } });
        broadcast(room.roomId, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      }

      return;
    }

    send(ws, { v:1, t:"error", ts: now(), data:{ message:"unknown message type: " + t } });
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("anim5s server listening on", PORT));
