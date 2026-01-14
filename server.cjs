/**
 * anim5s server (V12+)
 * - Node.js + ws
 * - WebSocket endpoint: /ws
 * - 60 frames (12fps) "1人1フレーム"
 * - Public: assigned frame only (one per client)
 * - Private (合言葉あり): 全コマ編集OK（合言葉で入室した接続だけ）
 */
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const THEMES = [
  "歩く犬","通勤時間","雪だるま","くるま","うさぎのジャンプ","猫のあくび","風船","回転寿司",
  "おにぎり","宇宙船","かたつむり","スケボー","カメラ","ダンス","エスカレーター","ロボット",
];

function id7(){ return Math.random().toString(36).slice(2, 9).toUpperCase(); }
function nowTs(){ return Date.now(); }
function randTheme(){ return THEMES[Math.floor(Math.random()*THEMES.length)] || "お題"; }

const rooms = new Map();
// room: { roomId, theme, password, frameCount, fps, phase, revision, frames[], assignments: Map(clientId->frameIndex), clients:Set(ws) }

function makeRoom({ theme, password }) {
  const roomId = id7();
  const room = {
    roomId,
    theme: theme && String(theme).trim() ? String(theme).trim() : randTheme(),
    password: password ? String(password) : "",
    frameCount: 60,
    fps: 12,
    phase: "DRAWING",
    revision: 1,
    frames: Array.from({ length: 60 }, () => ({ committed:false, dataUrl:null, author:null, ts:null })),
    assignments: new Map(),
    clients: new Set(),
  };
  rooms.set(roomId, room);
  return room;
}

function countCommitted(room){
  let n = 0;
  for (const f of room.frames) if (f && f.committed) n++;
  return n;
}

function firstEmptyFrame(room) {
  // uncommitted & unassigned first
  const assigned = new Set([...room.assignments.values()].filter(v => typeof v === "number"));
  for (let i = 0; i < room.frameCount; i++) {
    if (!room.frames[i].committed && !assigned.has(i)) return i;
  }
  // fallback: any uncommitted
  for (let i = 0; i < room.frameCount; i++) {
    if (!room.frames[i].committed) return i;
  }
  return -1;
}

function findRandomOpenRoom() {
  const candidates = [];
  for (const room of rooms.values()) {
    if (room.phase !== "DRAWING") continue;
    if (countCommitted(room) >= room.frameCount) continue;
    candidates.push(room);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function roomState(room, clientId) {
  const assignedFrame = room.assignments.get(clientId);
  return {
    roomId: room.roomId,
    phase: room.phase,
    theme: room.theme,
    revision: room.revision,
    frameCount: room.frameCount,
    fps: room.fps,
    assignedFrame: (typeof assignedFrame === "number") ? assignedFrame : -1,
    // ③: 作品の状態（埋まり具合 + 画像）を渡す（クライアント側でランダム参加にも反映）
    frames: room.frames.map(f => (f && f.dataUrl) ? f.dataUrl : null),
    filled: room.frames.map(f => !!(f && f.committed)),
    updatedAt: nowTs(),
    completed: countCommitted(room) >= room.frameCount,
  };
}

function send(ws, msgObj) {
  try { ws.send(JSON.stringify(msgObj)); } catch(e) {}
}

function broadcast(room, msgObj) {
  const text = JSON.stringify(msgObj);
  for (const c of room.clients) {
    try { c.send(text); } catch(e) {}
  }
}

function joinRoom(ws, clientId, room, password, opts={}) {
  const viewOnly = !!opts.viewOnly;

  if (room.password) {
    if (room.password !== (password || "")) {
      send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"合言葉が違う" } });
      return;
    }
    // mark this ws as authed for this private room
    ws._authedPrivate = ws._authedPrivate || new Set();
    ws._authedPrivate.add(room.roomId);
  }

  room.clients.add(ws);
  ws._roomId = room.roomId;

  if (!viewOnly) {
    if (!room.assignments.has(clientId)) {
      const idx = firstEmptyFrame(room);
      if (idx >= 0) room.assignments.set(clientId, idx);
    }
  }

  send(ws, { v:1, t:"joined", ts: nowTs(), data: roomState(room, clientId) });
}

function forkPrivate(ws, clientId, srcRoom, password) {
  const room = makeRoom({ theme: srcRoom.theme, password });
  room.frames = srcRoom.frames.map(f => ({ ...f }));
  room.revision = srcRoom.revision + 1;
  joinRoom(ws, clientId, room, password, { viewOnly: false });
  send(ws, { v:1, t:"forked", ts: nowTs(), data:{ roomId: room.roomId, theme: room.theme, password: room.password } });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: nowTs() }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("anim5s ws server. use /ws");
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

let clientSeq = 1;

wss.on("connection", (ws) => {
  const clientId = "c" + (clientSeq++);
  ws._clientId = clientId;
  ws._roomId = null;

  send(ws, { v:1, t:"welcome", ts: nowTs(), data:{ clientId, serverTime: nowTs() } });

  ws.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch(e) {
      send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"JSON parse error" } });
      return;
    }

    const t = msg.t;
    const d = msg.data || {};
    const rid = d.roomId || msg.roomId || ws._roomId;

    if (t === "hello") return;

    if (t === "ping") {
      send(ws, { v:1, t:"pong", ts: nowTs(), data:{ ts: d.ts || nowTs() } });
      return;
    }

    if (t === "create_room") {
      const room = makeRoom({ theme: d.theme, password: d.password || "" });
      joinRoom(ws, clientId, room, room.password, { viewOnly:false });
      send(ws, { v:1, t:"created", ts: nowTs(), data:{ roomId: room.roomId, theme: room.theme, password: room.password } });
      return;
    }

    if (t === "join_random") {
      let room = findRandomOpenRoom();
      if (!room) room = makeRoom({ theme: randTheme() });
      joinRoom(ws, clientId, room, "", { viewOnly:false });
      return;
    }

    if (t === "join_room") {
      const roomId = String(d.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"部屋が見つからない" } });
        return;
      }
      joinRoom(ws, clientId, room, d.password || d.pass || "", { viewOnly: !!d.view });
      return;
    }

    if (t === "resync") {
      const roomId = String(d.roomId || rid || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"部屋が見つからない" } });
        return;
      }
      send(ws, { v:1, t:"room_state", ts: nowTs(), data: roomState(room, clientId) });
      return;
    }

    if (t === "fork_private") {
      const roomId = String(d.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"元の部屋が見つからない" } });
        return;
      }
      const pw = String(d.password || "").trim();
      forkPrivate(ws, clientId, room, pw);
      return;
    }

    if (t === "submit_frame") {
      const roomId = String(d.roomId || rid || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"部屋が見つからない" } });
        return;
      }

      const frameIndex = Number(d.frameIndex);
      const dataUrl = String(d.dataUrl || "");

      if (!Number.isFinite(frameIndex) || frameIndex < 0 || frameIndex >= room.frameCount) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"frameIndex が不正" } });
        return;
      }
      if (!dataUrl.startsWith("data:image/")) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"dataUrl が不正" } });
        return;
      }
      if (dataUrl.length > 1_500_000) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"画像が大きすぎる" } });
        return;
      }

      // ③: publicは担当コマのみ、privateは合言葉で入った接続なら全コマOK
      if (room.password) {
        const ok = ws._authedPrivate && ws._authedPrivate.has(room.roomId);
        if (!ok) {
          send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"プライベートの合言葉認証が必要" } });
          return;
        }
      } else {
        const assigned = room.assignments.get(clientId);
        if (typeof assigned !== "number") {
          send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"担当コマが割り当てられていない" } });
          return;
        }
        if (frameIndex !== assigned) {
          send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"担当コマ以外は提出できない" } });
          return;
        }
      }

      room.frames[frameIndex] = { committed:true, dataUrl, author: clientId, ts: nowTs() };
      room.revision++;

      broadcast(room, { v:1, t:"frame_committed", ts: nowTs(), data:{ roomId: room.roomId, frameIndex, dataUrl, author: clientId } });
      send(ws, { v:1, t:"submitted", ts: nowTs(), data:{ roomId: room.roomId, frameIndex } });

      if (countCommitted(room) >= room.frameCount) {
        room.phase = "PLAYBACK";
        room.revision++;
        broadcast(room, { v:1, t:"room_state", ts: nowTs(), data: roomState(room, clientId) });
      }
      return;
    }
  });

  ws.on("close", () => {
    // remove from room clients
    const rid = ws._roomId;
    if (rid && rooms.has(rid)) {
      const room = rooms.get(rid);
      room.clients.delete(ws);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("anim5s server listening on", PORT);
});
