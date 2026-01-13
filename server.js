// anim5s Phase2 server (Node.js + ws) - improved keepalive
// - /health : ok
// - ws: /ws
// 永続化なし（メモリ）。Phase3でDB等へ。

import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const FRAME_COUNT = 60;
const RESERVE_MS = 90_000;
const UPLOAD_TTL_MS = 5_000;
const MAX_BYTES = 512_000; // 256x256 PNG想定
const HOUSEKEEP_MS = 10_000;
const PING_MS = 25_000;

function now() { return Date.now(); }
function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function randId(len=6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<len;i++) out += chars[(Math.random()*chars.length)|0];
  return out;
}
function genRoomId(rooms) {
  for (let i=0;i<30;i++){
    const id = randId(6);
    if (!rooms.has(id)) return id;
  }
  return randId(8) + randId(2);
}
function genToken() {
  return crypto.randomBytes(9).toString("base64url");
}
function safeTheme(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.slice(0, 60);
}

function makeRoom({roomId, visibility, theme, passphrase}) {
  const t = now();
  return {
    roomId,
    visibility, // public/private
    theme,
    passHash: visibility==="private" ? sha256(passphrase || "") : null,
    createdAt: t,
    updatedAt: t,
    completed: false,
    frames: Array.from({length: FRAME_COUNT}, () => null), // Buffer or null
    filled: Array.from({length: FRAME_COUNT}, () => false),
    reservations: new Map(), // frameIndex -> {wsId, token, expiresAt}
    clients: new Set(), // ws
  };
}

function reserveFrame(room, frameIndex, wsId) {
  const token = genToken();
  const expiresAt = now() + RESERVE_MS;
  room.reservations.set(frameIndex, { wsId, token, expiresAt });
  return { token, expiresAt };
}

function releaseReservation(room, frameIndex, wsId) {
  const r = room.reservations.get(frameIndex);
  if (!r) return;
  if (wsId && r.wsId !== wsId) return;
  room.reservations.delete(frameIndex);
}

function cleanupReservations(rooms) {
  const t = now();
  for (const room of rooms.values()) {
    for (const [k, r] of room.reservations.entries()) {
      if (r.expiresAt <= t) {
        if (!room.filled[k]) room.reservations.delete(k);
      }
    }
  }
}

function earliestEmptyFrame(room) {
  for (let i=0;i<FRAME_COUNT;i++){
    if (room.filled[i]) continue;
    if (room.reservations.has(i)) continue;
    return i;
  }
  return -1;
}

function eligiblePublicRooms(rooms) {
  const arr = [];
  for (const room of rooms.values()) {
    if (room.visibility !== "public") continue;
    if (room.completed) continue;
    if (earliestEmptyFrame(room) === -1) continue;
    arr.push(room);
  }
  return arr;
}

function pickRandom(arr) {
  return arr[(Math.random()*arr.length)|0];
}

const rooms = new Map(); // roomId -> room
let wsCounter = 0;

const server = http.createServer((req, res) => {
  if (!req.url) { res.writeHead(404); res.end(); return; }
  if (req.url.startsWith("/health")) {
    res.writeHead(200, {"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ ok:true, ts: now(), rooms: rooms.size }));
    return;
  }
  res.writeHead(200, {"content-type":"text/plain; charset=utf-8"});
  res.end("anim5s Phase2 server\n/health ok\n/ws websocket\n");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function sendError(ws, message, code="ERR") {
  send(ws, { t:"error", code, message });
}
function sendRoomState(ws, room, extra={}) {
  send(ws, {
    t:"room_state",
    roomId: room.roomId,
    theme: room.theme,
    visibility: room.visibility,
    filled: room.filled,
    updatedAt: room.updatedAt,
    completed: room.completed,
    ...extra,
  });
}

async function sendRoomAll(ws, room) {
  const info = ws.joinInfo?.get(room.roomId);
  const extra = {};
  if (info?.reservationExpiresAt) extra.reservationExpiresAt = info.reservationExpiresAt;
  sendRoomState(ws, room, extra);

  for (let i=0;i<FRAME_COUNT;i++){
    const buf = room.frames[i];
    if (!buf) continue;
    send(ws, { t:"frame_update_begin", roomId: room.roomId, frameIndex: i, mime: "image/png" });
    try { ws.send(buf); } catch {}
  }
}

function joinRoomSocket(ws, room, joinInfo) {
  room.clients.add(ws);
  ws.joinInfo.set(room.roomId, joinInfo);
  ws.rooms.add(room.roomId);
}

function leaveSocket(ws) {
  for (const roomId of ws.rooms) {
    const room = rooms.get(roomId);
    if (!room) continue;
    room.clients.delete(ws);
  }
}

function broadcastRoomState(room) {
  for (const c of room.clients) {
    const info = c.joinInfo?.get(room.roomId);
    const extra = {};
    if (info?.reservationExpiresAt) extra.reservationExpiresAt = info.reservationExpiresAt;
    sendRoomState(c, room, extra);
  }
}

wss.on("connection", (ws) => {
  const wsId = "ws" + (++wsCounter);
  ws.wsId = wsId;
  ws.rooms = new Set();
  ws.joinInfo = new Map(); // roomId -> {canEdit, assignedFrame, reservationToken, reservationExpiresAt, flow, pass}
  ws.pendingUpload = null; // {roomId, frameIndex, mime, ts}

  // keepalive (ping frame)
  ws.isAlive = true;
  ws.on("pong", ()=>{ ws.isAlive = true; });

  send(ws, { t:"welcome", wsId });

  ws.on("close", () => leaveSocket(ws));

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        const p = ws.pendingUpload;
        ws.pendingUpload = null;
        if (!p) return;
        if (!(data instanceof Buffer)) data = Buffer.from(data);
        if (data.length > MAX_BYTES) { sendError(ws, "サイズ大きい", "TOO_BIG"); return; }

        const room = rooms.get(p.roomId);
        if (!room) { sendError(ws, "部屋なし", "NO_ROOM"); return; }
        if (p.frameIndex < 0 || p.frameIndex >= FRAME_COUNT) { sendError(ws, "コマおかしい"); return; }
        if (room.filled[p.frameIndex]) { sendError(ws, "もうある"); return; }

        const info = ws.joinInfo.get(p.roomId);
        if (!info) { sendError(ws, "入ってない"); return; }
        if (info.canEdit === "view") { sendError(ws, "見てるだけ"); return; }

        if (info.canEdit === "assigned") {
          if (info.assignedFrame !== p.frameIndex) { sendError(ws, "そのコマじゃない"); return; }
          const r = room.reservations.get(p.frameIndex);
          if (!r || r.wsId !== ws.wsId || r.token !== info.reservationToken || r.expiresAt <= now()) {
            sendError(ws, "予約切れ", "RESERVE_END");
            return;
          }
        }

        room.frames[p.frameIndex] = Buffer.from(data);
        room.filled[p.frameIndex] = true;
        room.updatedAt = now();
        releaseReservation(room, p.frameIndex, ws.wsId);
        room.completed = room.filled.every(Boolean);

        for (const c of room.clients) {
          send(c, { t:"frame_update_begin", roomId: room.roomId, frameIndex: p.frameIndex, mime: "image/png" });
          try { c.send(room.frames[p.frameIndex]); } catch {}
        }
        broadcastRoomState(room);
        send(ws, { t:"frame_submit_ok", roomId: room.roomId, frameIndex: p.frameIndex });
        return;
      }

      const txt = data.toString("utf8");
      let msg = null;
      try { msg = JSON.parse(txt); } catch { return; }
      if (!msg || !msg.t) return;

      if (msg.t === "hello") { send(ws, { t:"pong", ts: now() }); return; }
      if (msg.t === "ping") { send(ws, { t:"pong", ts: msg.ts || now() }); return; }
      if (msg.t === "pong") return;

      if (msg.t === "create_room") {
        const visibility = (msg.visibility === "private") ? "private" : "public";
        const theme = safeTheme(msg.theme) || "お題";
        const passphrase = visibility==="private" ? String(msg.passphrase || "") : "";
        if (visibility==="private" && !passphrase) { sendError(ws, "合言葉", "NEED_PASS"); return; }

        const roomId = genRoomId(rooms);
        const room = makeRoom({ roomId, visibility, theme, passphrase });
        rooms.set(roomId, room);

        const assignedFrame = 0;
        const { token, expiresAt } = reserveFrame(room, assignedFrame, ws.wsId);
        const joinInfo = {
          canEdit: "assigned",
          assignedFrame,
          reservationToken: token,
          reservationExpiresAt: expiresAt,
          flow: "create",
          pass: visibility==="private" ? passphrase : null,
        };
        joinRoomSocket(ws, room, joinInfo);

        send(ws, {
          t:"room_joined",
          roomId, visibility, theme,
          canEdit:"assigned",
          assignedFrame,
          reservationToken: token,
          reservationExpiresAt: expiresAt,
          flow: "create",
          pass: visibility==="private" ? passphrase : null,
        });

        await sendRoomAll(ws, room);
        return;
      }

      if (msg.t === "join_random") {
        let pool = eligiblePublicRooms(rooms);
        let room = null;

        if (!pool.length) {
          const theme = safeTheme(pickRandom([
            "歩く犬","通勤時間","雨の日","ねこが伸びる","信号待ち","おにぎり","ジャンプ","落ちる"
          ])) || "歩く犬";
          const roomId = genRoomId(rooms);
          room = makeRoom({ roomId, visibility:"public", theme, passphrase:"" });
          rooms.set(roomId, room);
        } else {
          room = pickRandom(pool);
        }

        const frameIndex = earliestEmptyFrame(room);
        if (frameIndex === -1) { sendError(ws, "空きなし", "NO_EMPTY"); return; }

        const { token, expiresAt } = reserveFrame(room, frameIndex, ws.wsId);

        const joinInfo = {
          canEdit: "assigned",
          assignedFrame: frameIndex,
          reservationToken: token,
          reservationExpiresAt: expiresAt,
          flow: "random",
          pass: null,
        };
        joinRoomSocket(ws, room, joinInfo);

        send(ws, {
          t:"room_joined",
          roomId: room.roomId,
          visibility: room.visibility,
          theme: room.theme,
          canEdit:"assigned",
          assignedFrame: frameIndex,
          reservationToken: token,
          reservationExpiresAt: expiresAt,
          flow: "random",
        });

        await sendRoomAll(ws, room);
        return;
      }

      if (msg.t === "join_private") {
        const roomId = String(msg.roomId || "").trim().toUpperCase();
        const passphrase = String(msg.passphrase || "");
        const room = rooms.get(roomId);
        if (!room) { sendError(ws, "部屋なし", "NO_ROOM"); return; }
        if (room.visibility !== "private") { sendError(ws, "プライベートじゃない", "NOT_PRIVATE"); return; }
        if (!passphrase) { sendError(ws, "合言葉", "NEED_PASS"); return; }
        if (sha256(passphrase) !== room.passHash) { sendError(ws, "合言葉ちがう", "BAD_PASS"); return; }

        const joinInfo = {
          canEdit: "any",
          assignedFrame: null,
          reservationToken: null,
          reservationExpiresAt: null,
          flow: "private",
          pass: passphrase,
        };
        joinRoomSocket(ws, room, joinInfo);

        send(ws, {
          t:"room_joined",
          roomId: room.roomId,
          visibility: room.visibility,
          theme: room.theme,
          canEdit:"any",
          assignedFrame: null,
          flow: "private",
          pass: passphrase,
        });

        await sendRoomAll(ws, room);
        return;
      }

      if (msg.t === "join_view") {
        const roomId = String(msg.roomId || "").trim().toUpperCase();
        const room = rooms.get(roomId);
        if (!room) { sendError(ws, "部屋なし", "NO_ROOM"); return; }

        if (room.visibility === "private") {
          const passphrase = String(msg.passphrase || "");
          if (!passphrase) { sendError(ws, "合言葉", "NEED_PASS"); return; }
          if (sha256(passphrase) !== room.passHash) { sendError(ws, "合言葉ちがう", "BAD_PASS"); return; }
        }

        const joinInfo = {
          canEdit: "view",
          assignedFrame: null,
          reservationToken: null,
          reservationExpiresAt: null,
          flow: "view",
          pass: null,
        };
        joinRoomSocket(ws, room, joinInfo);

        send(ws, {
          t:"room_joined",
          roomId: room.roomId,
          visibility: room.visibility,
          theme: room.theme,
          canEdit:"view",
          assignedFrame: null,
          flow: "view",
        });

        await sendRoomAll(ws, room);
        return;
      }

      if (msg.t === "resync") {
        const roomId = String(msg.roomId || "").trim().toUpperCase();
        const room = rooms.get(roomId);
        if (!room) { sendError(ws, "部屋なし", "NO_ROOM"); return; }
        await sendRoomAll(ws, room);
        return;
      }

      if (msg.t === "submit_begin") {
        const roomId = String(msg.roomId || "").trim().toUpperCase();
        const frameIndex = Number(msg.frameIndex);
        const mime = String(msg.mime || "image/png");
        const room = rooms.get(roomId);
        if (!room) { sendError(ws, "部屋なし", "NO_ROOM"); return; }
        if (!Number.isFinite(frameIndex) || frameIndex < 0 || frameIndex >= FRAME_COUNT) {
          sendError(ws, "コマおかしい", "BAD_FRAME"); return;
        }
        if (room.filled[frameIndex]) { sendError(ws, "もうある", "FILLED"); return; }

        const info = ws.joinInfo.get(roomId);
        if (!info) { sendError(ws, "入ってない", "NOT_JOINED"); return; }
        if (info.canEdit === "view") { sendError(ws, "見てるだけ", "VIEW_ONLY"); return; }

        if (info.canEdit === "assigned") {
          const tok = String(msg.reservationToken || "");
          if (!tok || tok !== info.reservationToken) { sendError(ws, "予約ちがう", "BAD_TOKEN"); return; }
          if (info.assignedFrame !== frameIndex) { sendError(ws, "そのコマじゃない", "NOT_YOURS"); return; }
          const r = room.reservations.get(frameIndex);
          if (!r || r.wsId !== ws.wsId || r.token !== tok || r.expiresAt <= now()) {
            sendError(ws, "予約切れ", "RESERVE_END"); return;
          }
        }

        ws.pendingUpload = { roomId, frameIndex, mime, ts: now() };
        setTimeout(() => {
          if (!ws.pendingUpload) return;
          if (ws.pendingUpload.roomId === roomId && ws.pendingUpload.frameIndex === frameIndex) {
            ws.pendingUpload = null;
          }
        }, UPLOAD_TTL_MS);
        return;
      }

    } catch (e) {
      sendError(ws, "サーバーエラー", "EX");
    }
  });
});

// housekeep
setInterval(() => cleanupReservations(rooms), HOUSEKEEP_MS);

// ping frame keepalive
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_MS);

server.listen(PORT, () => {
  console.log("anim5s Phase2 server on", PORT);
});
