/**
 * anim5s server (spec 2026-01-15)
 * - WebSocket endpoint: /ws
 * - Public rooms created only when frame0 is submitted (A案)
 * - Join random assigns youngest empty frame with reservationToken + expiry
 * - Submit requires reservationToken validation
 * - room_state returns filled only; get_frame returns individual frame dataUrl
 */
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

function now(){ return Date.now(); }
function id7(){ return Math.random().toString(36).slice(2, 9).toUpperCase(); }
function token(){ return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }


const THEME_POOL = [
  "走る犬","くるま","宇宙人","おにぎり","雨の日","ジャンプ","落下","変身","ねこパンチ",
  "通勤時間","料理","かくれんぼ","風船","雪だるま","電車","魔法","釣り","ダンス"
];
function randTheme(){
  return THEME_POOL[Math.floor(Math.random()*THEME_POOL.length)];
}

const rooms = new Map();

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
    reservations: new Map(),     // token -> {frameIndex, expiresAt}
    reservedByFrame: new Map(),  // frameIndex -> token
  };
  rooms.set(roomId, room);
  return room;
}

function cleanupReservations(room){
  const t = now();
  for (const [tok, r] of room.reservations.entries()){
    if (r.expiresAt <= t || room.committed[r.frameIndex]){
      room.reservations.delete(tok);
      const curTok = room.reservedByFrame.get(r.frameIndex);
      if (curTok === tok) room.reservedByFrame.delete(r.frameIndex);
    }
  }
}

function roomState(room){
  cleanupReservations(room);
  return {
    roomId: room.roomId,
    theme: room.theme,
    frameCount: 60,
    fps: 12,
    phase: room.phase,
    filled: room.committed.slice(),
    updatedAt: room.updatedAt,
    completed: room.committed.every(Boolean)
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

function findRandomOpenRoom(){
  const list = [];
  for (const r of rooms.values()){
    cleanupReservations(r);
    if (r.phase !== "DRAWING") continue;
    if (r.committed.every(Boolean)) continue;
    list.push(r);
  }
  if (!list.length) return null;
  return list[Math.floor(Math.random()*list.length)];
}

function send(ws, obj){
  try{ ws.send(JSON.stringify(obj)); }catch(e){}
}
function broadcast(room, obj){
  const text = JSON.stringify(obj);
  for (const ws of wss.clients){
    if (ws._roomId === room.roomId){
      try{ ws.send(text); }catch(e){}
    }
  }
}

function validatePngDataUrl(s){
  if (typeof s !== "string") return false;
  if (!s.startsWith("data:image/")) return false;
  if (s.length > 1_500_000) return false;
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health"){
    res.writeHead(200, { "content-type":"application/json" });
    res.end(JSON.stringify({ ok:true, rooms: rooms.size, ts: now() }));
    return;
  }
  res.writeHead(200, { "content-type":"text/plain; charset=utf-8" });
  res.end("anim5s ws server. use /ws");
});

const wss = new WebSocket.Server({ noServer:true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/ws")){
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

let wsSeq = 1;

wss.on("connection", (ws) => {
  ws._wsId = "ws" + (wsSeq++);
  ws._roomId = null;

  send(ws, { v:1, t:"welcome", ts: now(), data:{ wsId: ws._wsId } });

  ws.on("message", (raw) => {
    let msg;
    try{ msg = JSON.parse(String(raw)); }catch(e){
      send(ws, { v:1, t:"error", ts: now(), data:{ message:"JSON parse error" } });
      return;
    }
    const t = msg.t;
    const d = msg.data || {};

    if (t === "hello") return;
    if (t === "ping"){ send(ws, { v:1, t:"pong", ts: now(), data:{ ts: d.ts || now() } }); return; }

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
      ws._roomId = room.roomId;

      send(ws, { v:1, t:"created_public", ts: now(), data: roomState(room) });
      broadcast(room, { v:1, t:"frame_committed", ts: now(), data:{ roomId: room.roomId, frameIndex:0 } });
      return;
    }

    if (t === "join_random"){
      const room = findRandomOpenRoom();
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"参加できる公開作品がありません（まず誰かが公開で1コマ目を提出してね）" } });
        return;
      }
      const idx = firstYoungestEmpty(room);
      if (idx < 0){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"空きコマがありません" } });
        return;
      }
      const tok = token();
      const expiresAt = now() + 3*60*1000;
      room.reservations.set(tok, { frameIndex: idx, expiresAt });
      room.reservedByFrame.set(idx, tok);
      room.updatedAt = now();
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
      const roomId = String(d.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      ws._roomId = room.roomId;

      if (d.view !== true && d.reservationToken){
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
      const roomId = String(d.roomId || ws._roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      send(ws, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      return;
    }

    if (t === "get_frame"){
      const roomId = String(d.roomId || ws._roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
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
      const roomId = String(d.roomId || ws._roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"部屋が見つからない" } });
        return;
      }
      cleanupReservations(room);

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
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"そのコマは既に提出済み" } });
        return;
      }
      if (!validatePngDataUrl(dataUrl)){
        send(ws, { v:1, t:"error", ts: now(), data:{ message:"dataUrl が不正/大きすぎる" } });
        return;
      }

      room.frames[idx] = dataUrl;
      room.committed[idx] = true;
      room.updatedAt = now();

      room.reservations.delete(tok);
      room.reservedByFrame.delete(idx);

      broadcast(room, { v:1, t:"frame_committed", ts: now(), data:{ roomId: room.roomId, frameIndex: idx } });
      send(ws, { v:1, t:"submitted", ts: now(), data:{ roomId: room.roomId, frameIndex: idx } });

      if (room.committed.every(Boolean)){
        room.phase = "PLAYBACK";
        room.updatedAt = now();
        broadcast(room, { v:1, t:"room_state", ts: now(), data: roomState(room) });
      }
      return;
    }

    send(ws, { v:1, t:"error", ts: now(), data:{ message:"unknown message type: " + t } });
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("anim5s server listening on", PORT));
