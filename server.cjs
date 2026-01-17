/**
 * anim5s server (spec 2026-01-15) — Phase4 Step2 hardening + Step3 monitoring + Step4 ops tools (V45)
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
const ADMIN_KEY = String(process.env.ADMIN_KEY || "");

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

// --- Step4: minimal ops tooling ---
// Quarantine list (rooms treated as "not found")
const QUARANTINE_FILE = path.join(DATA_DIR, "quarantine.json");
let quarantineSet = new Set();

// Minimal rate limiting (per IP + message type)
const RATE_BUCKETS = new Map(); // key -> {count, resetAt}
const RATE_DEFAULT = { windowMs: 10_000, max: 50 };
const RATE_BY_OP = {
  hello: { windowMs: 10_000, max: 120 },
  get_frame: { windowMs: 10_000, max: 90 },
  join_room: { windowMs: 10_000, max: 40 },
  resync: { windowMs: 10_000, max: 30 },
  join_random: { windowMs: 10_000, max: 18 },
  join_by_id: { windowMs: 10_000, max: 18 },
  create_public_and_submit: { windowMs: 60_000, max: 12 },
  submit_frame: { windowMs: 60_000, max: 10 },
};

const THEME_POOL = [
  "走る犬","くるま","宇宙人","おにぎり","雨の日","ジャンプ","落下","変身","ねこパンチ",
  "通勤時間","料理","かくれんぼ","風船","雪だるま","電車","魔法","釣り","ダンス"
];


// --- Step3: basic monitoring (metrics + structured logs) ---
const STARTED_AT = Date.now();
const METRICS = {
  counters: Object.create(null),
  ms: Object.create(null), // op -> {count,sum,max}
};
let LAST_ERROR = { ts: 0, code: "", message: "" };

function metricKey(s){
  return String(s || "unknown").replace(/[^a-zA-Z0-9_]/g, "_");
}
function inc(name, n=1){
  const k = metricKey(name);
  METRICS.counters[k] = (METRICS.counters[k] || 0) + (Number(n) || 0);
}
function observeMs(op, ms){
  const k = metricKey(op);
  let o = METRICS.ms[k];
  if (!o) o = METRICS.ms[k] = { count: 0, sum: 0, max: 0 };
  o.count += 1;
  o.sum += ms;
  if (ms > o.max) o.max = ms;
}
function uptimeSec(){
  return Math.max(0, Math.floor((Date.now() - STARTED_AT) / 1000));
}
function logLine(level, event, data){
  try{
    const out = Object.assign({ ts: new Date().toISOString(), level, event }, data || {});
    console.log(JSON.stringify(out));
  }catch(e){
    console.log(level, event);
  }
}

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

// --- Step4: quarantine persistence ---
function loadQuarantineSet(){
  const obj = safeReadJson(QUARANTINE_FILE);
  const ids = Array.isArray(obj?.roomIds) ? obj.roomIds : (Array.isArray(obj) ? obj : []);
  const set = new Set();
  for (const x of ids){
    const rid = normalizeRoomId(x);
    if (rid) set.add(rid);
  }
  return set;
}

function saveQuarantineSet(){
  try{
    const payload = { updatedAt: now(), roomIds: Array.from(quarantineSet) };
    atomicWriteFile(QUARANTINE_FILE, JSON.stringify(payload));
  }catch(e){}
}

quarantineSet = loadQuarantineSet();

function isLocalAddress(addr){
  const a = String(addr || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function isAdminAuthorized(req, urlObj){
  if (ADMIN_KEY){
    const qk = String(urlObj?.searchParams?.get("key") || "");
    const hk = String(req.headers["x-admin-key"] || "");
    return (qk && qk === ADMIN_KEY) || (hk && hk === ADMIN_KEY);
  }
  return isLocalAddress(req.socket.remoteAddress);
}

function sendJson(res, code, obj){
  res.writeHead(code, { "content-type":"application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// --- Step4: minimal rate limiting ---
function checkRateLimit(ip, op){
  const cfg = RATE_BY_OP[op] || RATE_DEFAULT;
  const t = now();
  const key = String(ip || "unknown") + "|" + String(op || "unknown");
  let e = RATE_BUCKETS.get(key);
  if (!e || !Number.isFinite(e.resetAt) || e.resetAt <= t){
    e = { count: 0, resetAt: t + cfg.windowMs };
  }
  e.count += 1;
  RATE_BUCKETS.set(key, e);
  if (e.count > cfg.max){
    return { ok:false, retryAfterMs: Math.max(0, e.resetAt - t) };
  }
  return { ok:true, retryAfterMs: 0 };
}

setInterval(() => {
  const t = now();
  for (const [k,e] of RATE_BUCKETS.entries()){
    if (!e || !Number.isFinite(e.resetAt) || e.resetAt <= t) RATE_BUCKETS.delete(k);
  }
}, 30_000);

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
    const fi = (r && Number.isFinite(r.frameIndex)) ? r.frameIndex : -1;
    const ex = r ? (Number(r.expiresAt) || 0) : 0;
    const expired = (!r) || (ex <= t);
    const invalid = !(fi >= 0 && fi < 60);
    const committed = (!invalid) ? Boolean(room.committed[fi]) : false;
    if (expired || committed || invalid){
      room.reservations.delete(tok);
      if (!invalid){
        const curTok = room.reservedByFrame.get(fi);
        if (curTok === tok) room.reservedByFrame.delete(fi);
      }
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
    if (quarantineSet.has(rid)) continue;
    if (meta.completed) continue;
    if ((meta.filledCount || 0) >= 60) continue;
    candidates.push(rid);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random()*candidates.length)];
}

function send(ws, obj){
  try{
    if (obj && obj.t){
      const t = metricKey(obj.t);
      inc('ws_send_total');
      inc('ws_send_type_' + t);
      if (t === 'error'){
        inc('errors_total');
        const code = (obj.data && obj.data.code) ? String(obj.data.code) : '';
        const message = (obj.data && obj.data.message) ? String(obj.data.message) : '';
        LAST_ERROR = { ts: now(), code, message };
        // keep logs small (do not include payload)
        logLine('warn', 'ws_error_send', { roomId: ws?._roomId || '', code, message });
      }
    }
    ws.send(JSON.stringify(obj));
  }catch(e){}
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
  let u = null;
  let pathname = "/";
  try{
    u = new URL(req.url || "/", "http://localhost");
    pathname = u.pathname || "/";
  }catch(e){
    u = new URL("/", "http://localhost");
    pathname = String(req.url || "/").split("?")[0] || "/";
  }

  const accept = String(req.headers["accept"] || "");

  function healthSnapshot(){
    let roomsOnDisk = 0;
    let backups = 0;
    try{ roomsOnDisk = fs.readdirSync(ROOMS_DIR).filter(f=>f.endsWith(".json")).length; }catch(e){}
    try{ backups = fs.readdirSync(BACKUP_DIR).filter(n=>!n.startsWith(".")).length; }catch(e){}

    const mu = process.memoryUsage();
    return {
      ok: true,
      ts: now(),
      uptimeSec: uptimeSec(),
      wsClients: wss?.clients ? wss.clients.size : 0,
      roomsInIndex: Object.keys(index).length,
      roomsOnDisk,
      cachedRooms: cache.size,
      backups,
      quarantineCount: quarantineSet.size,
      dirtyRooms: dirtyRoomIds.size,
      dataDir: DATA_DIR,
      counters: METRICS.counters,
      lastError: LAST_ERROR,
      memory: {
        rss: mu.rss,
        heapTotal: mu.heapTotal,
        heapUsed: mu.heapUsed,
        external: mu.external,
      }
    };
  }

  function esc(s){
    return String(s ?? "").replace(/[&<>\"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  function fmtBytes(n){
    const x = Number(n) || 0;
    const units = ["B","KB","MB","GB","TB"]; 
    let v = x;
    let i = 0;
    while (v >= 1024 && i < units.length-1){ v /= 1024; i++; }
    return (i === 0) ? (v.toFixed(0) + " " + units[i]) : (v.toFixed(1) + " " + units[i]);
  }

  function fmtIso(ms){
    const t = Number(ms) || 0;
    if (!t) return "なし";
    try{ return new Date(t).toISOString(); }catch(e){ return String(t); }
  }

  function renderHealthHtmlJa(s){
    const le = s.lastError || { ts: 0, code: "", message: "" };
    const rows = [
      ["状態", s.ok ? "OK" : "NG"],
      ["時刻(UTC)", fmtIso(s.ts)],
      ["稼働時間(秒)", String(s.uptimeSec)],
      ["WebSocket接続数", String(s.wsClients)],
      ["部屋数(index)", String(s.roomsInIndex)],
      ["部屋数(ディスク)", String(s.roomsOnDisk)],
      ["キャッシュ中の部屋数", String(s.cachedRooms)],
      ["バックアップ数", String(s.backups)],
      ["隔離数", String(s.quarantineCount || 0)],
      ["dirty数", String(s.dirtyRooms || 0)],
      ["保存先(DATA_DIR)", String(s.dataDir)],
      ["直近エラー時刻", fmtIso(le.ts)],
      ["直近エラーコード", le.code ? String(le.code) : "なし"],
      ["直近エラーメッセージ", le.message ? String(le.message) : "なし"],
      ["メモリ(rss)", fmtBytes(s.memory?.rss)],
      ["メモリ(heapUsed)", fmtBytes(s.memory?.heapUsed)],
      ["メモリ(heapTotal)", fmtBytes(s.memory?.heapTotal)],
    ];

    const counters = Object.entries(s.counters || {}).sort((a,b)=>a[0].localeCompare(b[0]));
    const counterHtml = counters.length
      ? counters.map(([k,v])=>`<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join("\n")
      : `<tr><td class="k">(なし)</td><td class="v">0</td></tr>`;

    const jsonUrl = "/health?format=json";
    const htmlUrl = "/health?format=html";
    const metricsUrl = "/metrics";

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>anim5s ヘルスチェック</title>
  <style>
    :root{ color-scheme: dark; --bg:#0b0d10; --panel:#141722; --line:rgba(255,255,255,.10); --text:#e6e6eb; --muted:rgba(230,230,235,.75); }
    body{ margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
    .wrap{ max-width: 880px; margin: 0 auto; padding: 16px; }
    .card{ background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:16px; }
    h1{ margin:0 0 10px 0; font-size:18px; opacity:.92; }
    .links{ margin: 6px 0 12px; font-size: 13px; color: var(--muted); }
    a{ color:#7aa7ff; text-decoration:none; }
    a:hover{ text-decoration:underline; }
    table{ width:100%; border-collapse:collapse; font-size:14px; }
    td{ padding:10px 8px; border-top:1px solid var(--line); vertical-align:top; }
    td.k{ width: 38%; color: var(--muted); }
    .sub{ margin-top: 14px; color: var(--muted); font-size: 12px; }
    .grid{ display:grid; grid-template-columns: 1fr; gap: 12px; }
    @media(min-width:860px){ .grid{ grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="grid">
      <div class="card">
        <h1>ヘルス概要（人間向け・日本語）</h1>
        <div class="links">表示: <a href="${htmlUrl}">HTML</a> / <a href="${jsonUrl}">JSON</a> / <a href="${metricsUrl}">Metrics</a></div>
        <table>
          ${rows.map(([k,v])=>`<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join("\n")}
        </table>
        <div class="sub">※ 外形監視ツールには <code>/health?format=json</code> を使うと安全。</div>
      </div>
      <div class="card">
        <h1>カウンタ（簡易メトリクス）</h1>
        <table>
          ${counterHtml}
        </table>
        <div class="sub">※ 詳細な時系列が欲しくなったら Prometheus/Grafana へ。</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  // --- Step4: minimal admin endpoints ---
  if (pathname === "/admin/status"){
    if (!isAdminAuthorized(req, u)){
      res.writeHead(404); res.end("not found");
      return;
    }
    const snap = healthSnapshot();
    // add a little more operational info than /health
    const out = {
      ok: true,
      ts: snap.ts,
      uptimeSec: snap.uptimeSec,
      wsClients: snap.wsClients,
      roomsInIndex: snap.roomsInIndex,
      roomsOnDisk: snap.roomsOnDisk,
      cachedRooms: snap.cachedRooms,
      backups: snap.backups,
      dirtyRooms: snap.dirtyRooms,
      quarantineCount: snap.quarantineCount,
      dataDir: snap.dataDir,
      lastError: snap.lastError,
      memory: process.memoryUsage(),
      env: {
        ROOM_CACHE_MAX,
        ROOM_CACHE_IDLE_MS,
        BACKUP_INTERVAL_MS,
        BACKUP_KEEP,
      }
    };
    sendJson(res, 200, out);
    return;
  }

  if (pathname === "/admin/quarantine"){
    if (!isAdminAuthorized(req, u)){
      res.writeHead(404); res.end("not found");
      return;
    }
    const roomId = normalizeRoomId(u.searchParams.get("roomId"));
    const mode = String(u.searchParams.get("mode") || "toggle").toLowerCase();
    if (!roomId){
      sendJson(res, 400, { ok:false, code:"INVALID_ROOM_ID", message:"roomId が不正です" });
      return;
    }
    let quarantined = quarantineSet.has(roomId);
    if (mode === "on") quarantined = true;
    else if (mode === "off") quarantined = false;
    else quarantined = !quarantined; // toggle / unknown -> toggle
    if (quarantined) quarantineSet.add(roomId);
    else quarantineSet.delete(roomId);
    saveQuarantineSet();
    logLine('info','admin_quarantine', { roomId, quarantined, remote: req.socket.remoteAddress || "" });
    sendJson(res, 200, { ok:true, roomId, quarantined, quarantineCount: quarantineSet.size });
    return;
  }

  if (pathname === "/health" || pathname === "/healthz" || pathname === "/health-ja" || pathname === "/health_ja"){
    const format = String(u.searchParams.get("format") || u.searchParams.get("view") || "").toLowerCase();
    const wantsJson = (format === "json");
    const wantsHtml = (format === "html") || (!wantsJson && accept.includes("text/html")) || (pathname === "/health-ja" || pathname === "/health_ja");

    const snap = healthSnapshot();
    if (wantsHtml){
      res.writeHead(200, { "content-type":"text/html; charset=utf-8" });
      res.end(renderHealthHtmlJa(snap));
      return;
    }

    res.writeHead(200, { "content-type":"application/json; charset=utf-8" });
    res.end(JSON.stringify(snap));
    return;
  }

  if (pathname === "/metrics"){
    res.writeHead(200, { "content-type":"text/plain; charset=utf-8" });
    const mu = process.memoryUsage();
    const lines = [];
    lines.push('# HELP anim5s_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE anim5s_uptime_seconds gauge');
    lines.push('anim5s_uptime_seconds ' + uptimeSec());

    lines.push('# HELP anim5s_ws_clients Current websocket clients');
    lines.push('# TYPE anim5s_ws_clients gauge');
    lines.push('anim5s_ws_clients ' + (wss?.clients ? wss.clients.size : 0));

    lines.push('# HELP anim5s_rooms_in_index Rooms in index');
    lines.push('# TYPE anim5s_rooms_in_index gauge');
    lines.push('anim5s_rooms_in_index ' + Object.keys(index).length);

    lines.push('# HELP anim5s_quarantine_count Quarantined rooms count');
    lines.push('# TYPE anim5s_quarantine_count gauge');
    lines.push('anim5s_quarantine_count ' + quarantineSet.size);

    lines.push('# HELP anim5s_dirty_rooms Dirty rooms count (pending backup)');
    lines.push('# TYPE anim5s_dirty_rooms gauge');
    lines.push('anim5s_dirty_rooms ' + dirtyRoomIds.size);

    let roomsOnDisk = 0;
    try{ roomsOnDisk = fs.readdirSync(ROOMS_DIR).filter(f=>f.endsWith(".json")).length; }catch(e){}
    lines.push('# HELP anim5s_rooms_on_disk Rooms json files on disk');
    lines.push('# TYPE anim5s_rooms_on_disk gauge');
    lines.push('anim5s_rooms_on_disk ' + roomsOnDisk);

    lines.push('# HELP anim5s_cached_rooms Cached rooms in memory');
    lines.push('# TYPE anim5s_cached_rooms gauge');
    lines.push('anim5s_cached_rooms ' + cache.size);

    let backups = 0;
    try{ backups = fs.readdirSync(BACKUP_DIR).filter(n=>!n.startsWith(".")).length; }catch(e){}
    lines.push('# HELP anim5s_backups Backups kept on disk');
    lines.push('# TYPE anim5s_backups gauge');
    lines.push('anim5s_backups ' + backups);

    lines.push('# HELP anim5s_memory_rss_bytes Resident set size');
    lines.push('# TYPE anim5s_memory_rss_bytes gauge');
    lines.push('anim5s_memory_rss_bytes ' + mu.rss);

    lines.push('# HELP anim5s_counter_total Generic counters');
    lines.push('# TYPE anim5s_counter_total counter');
    for (const [k,v] of Object.entries(METRICS.counters)){
      const name = String(k).replace(/[^a-zA-Z0-9_]/g,'_');
      lines.push(`anim5s_counter_total{name="${name}"} ${Number(v) || 0}`);
    }

    lines.push('# HELP anim5s_op_ms Operation duration in ms (sum/count/max)');
    lines.push('# TYPE anim5s_op_ms_sum counter');
    for (const [op,o] of Object.entries(METRICS.ms)){
      const name = String(op).replace(/[^a-zA-Z0-9_]/g,'_');
      lines.push(`anim5s_op_ms_sum{op="${name}"} ${Number(o.sum) || 0}`);
      lines.push(`anim5s_op_ms_count{op="${name}"} ${Number(o.count) || 0}`);
      lines.push(`anim5s_op_ms_max{op="${name}"} ${Number(o.max) || 0}`);
    }

    // last error as info gauge
    lines.push('# HELP anim5s_last_error_ts Last error timestamp (ms since epoch, 0 if none)');
    lines.push('# TYPE anim5s_last_error_ts gauge');
    lines.push('anim5s_last_error_ts ' + (LAST_ERROR.ts || 0));

    res.end(lines.join('\n') + '\n');
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

  inc('ws_connections_total');
  logLine('info','ws_open', { remote: (ws._socket && ws._socket.remoteAddress) ? ws._socket.remoteAddress : '' });

  ws.on('close', (code, reason) => {
    inc('ws_disconnect_total');
    logLine('info','ws_close', { code, reason: String(reason||'') });
  });

  ws.on("message", (buf) => {
  const msgStart = now();
  let opName = 'unknown';
  try{
    let m = null;
    try{ m = JSON.parse(String(buf)); }catch(e){ inc('ws_bad_json_total'); return; }
    const t = String(m.t || "");
    opName = metricKey(t || 'unknown');
    inc('ws_messages_total');
    inc('ws_msg_type_' + opName);
    const d = m.data || {};

    // Step4: minimal rate limiting
    const ip = (ws._socket && ws._socket.remoteAddress) ? ws._socket.remoteAddress : "unknown";
    const rl = checkRateLimit(ip, t || "unknown");
    if (!rl.ok){
      inc('rate_limited_total');
      send(ws, { v:1, t:"error", ts: now(), data:{ code:"RATE_LIMIT", message:"操作が早すぎます。少し待ってね", retryAfterMs: rl.retryAfterMs } });
      return;
    }


    // Backward-compatible handshake (older clients send these)
    if (t === "hello"){
      send(ws, { v:1, t:"welcome", ts: now(), data:{ protocol:1, serverTime: now() } });
      return;
    }
    // Backward-compatible resync: keep lightweight (clients should request frames via get_frame)
    if (t === "resync"){
      const roomId = normalizeRoomId(d.roomId || ws._roomId);
      if (!roomId){ send(ws, { v:1, t:"error", ts: now(), data:{ message:"roomId が不正です" } }); return; }
      if (quarantineSet.has(roomId)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
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
      if (quarantineSet.has(roomId)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
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
      if (quarantineSet.has(roomId)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
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
      if (quarantineSet.has(roomId)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
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
      if (quarantineSet.has(roomId)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
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
  } finally {
    observeMs('ws_' + opName, now() - msgStart);
  }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("anim5s server listening on", PORT));
