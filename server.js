/**
 * anim5s server (V12 debug-friendly)
 * - Node.js + ws
 * - WebSocket endpoint: /ws
 * - Minimal room management for "1人1フレーム" 60 frames
 */
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const THEMES = [
  "歩く犬",
  "通勤時間",
  "空を飛ぶ紙飛行機",
  "逃げるおにぎり",
  "笑う信号機",
  "変身する靴下",
  "増えるコーヒー",
  "踊る影",
];

function randTheme() {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

function id7() {
  // 7 chars base36
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

function nowTs() { return Date.now(); }

const rooms = new Map(); // roomId -> room
// room: { roomId, theme, password, frameCount, fps, phase, revision, frames[], assignments: Map(clientId->frameIndex), clients:Set(ws) }

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
    frames: room.frames.map(f => f && f.dataUrl ? f.dataUrl : null),
    policy: {
      maxW: 256, maxH: 256, maxBytes: 1_500_000,
      submit: "button_or_timeout"
    }
  };
}

function broadcast(room, msgObj) {
  const text = JSON.stringify(msgObj);
  for (const ws of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

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
    frames: Array.from({ length: 60 }, () => ({ committed: false, dataUrl: null, author: null, ts: null })),
    assignments: new Map(),
    clients: new Set(),
  };
  rooms.set(roomId, room);
  return room;
}

function countCommitted(room) {
  let n = 0;
  for (const f of room.frames) if (f.committed) n++;
  return n;
}

function firstEmptyFrame(room) {
  for (let i = 0; i < room.frameCount; i++) {
    if (!room.frames[i].committed && ![...room.assignments.values()].includes(i)) return i;
  }
  // if all uncommitted are assigned, still allow joining but assign first uncommitted
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

function joinRoom(ws, clientId, room, password) {
  if (room.password && room.password !== (password || "")) {
    send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"合言葉が違う" } });
    return;
  }
  room.clients.add(ws);
  if (!room.assignments.has(clientId)) {
    const idx = firstEmptyFrame(room);
    if (idx >= 0) room.assignments.set(clientId, idx);
  }
  send(ws, { v:1, t:"joined", ts: nowTs(), data: roomState(room, clientId) });
}

function forkPrivate(ws, clientId, srcRoom, password) {
  const room = makeRoom({ theme: srcRoom.theme, password });
  // copy frames
  room.frames = srcRoom.frames.map(f => ({ ...f }));
  room.revision = srcRoom.revision + 1;
  // join
  joinRoom(ws, clientId, room, password);
  send(ws, { v:1, t:"forked", ts: nowTs(), data:{ roomId: room.roomId, theme: room.theme, password: room.password } });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: nowTs() }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("anim5s server up. WebSocket: /ws\n");
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
    try { msg = JSON.parse(String(data)); } catch (e) {
      send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"JSON parse error" } });
      return;
    }
    const t = msg.t;
    const d = msg.data || {};
    const rid = d.roomId || msg.roomId || ws._roomId;

    if (t === "hello") {
      return; // already welcomed
    }

    if (t === "create_room") {
      const room = makeRoom({ theme: d.theme });
      ws._roomId = room.roomId;
      joinRoom(ws, clientId, room, room.password);
      send(ws, { v:1, t:"created", ts: nowTs(), data:{ roomId: room.roomId, theme: room.theme, password: room.password } });
      return;
    }

    if (t === "join_random") {
      let room = findRandomOpenRoom();
      if (!room) room = makeRoom({ theme: randTheme() });
      ws._roomId = room.roomId;
      joinRoom(ws, clientId, room, "");
      // (joined message is sent by joinRoom)
      return;
    }

    if (t === "join_room") {
      const roomId = String(d.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"部屋が見つからない" } });
        return;
      }
      ws._roomId = room.roomId;
      joinRoom(ws, clientId, room, d.password || "");
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
      const assigned = room.assignments.get(clientId);
      if (assigned !== frameIndex) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"割当と違うコマは提出できない" } });
        return;
      }
      if (!(frameIndex >= 0 && frameIndex < room.frameCount)) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"frameIndex out of range" } });
        return;
      }
      const dataUrl = String(d.dataUrl || "");
      if (!dataUrl.startsWith("data:image/png;base64,")) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"dataUrl must be PNG data URL" } });
        return;
      }
      // basic size limit (rough)
      if (dataUrl.length > 1_500_000) {
        send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"画像が大きすぎる" } });
        return;
      }
      room.frames[frameIndex] = { committed:true, dataUrl, author: clientId, ts: nowTs() };
      room.revision++;

      broadcast(room, { v:1, t:"frame_committed", ts: nowTs(), data:{ roomId: room.roomId, frameIndex, dataUrl, author: clientId } });
      send(ws, { v:1, t:"submitted", ts: nowTs(), data:{ roomId: room.roomId, frameIndex } });

      // If complete, go playback
      if (countCommitted(room) >= room.frameCount) {
        room.phase = "PLAYBACK";
        room.revision++;
        broadcast(room, { v:1, t:"start_playback", ts: nowTs(), data:{ roomId: room.roomId, fps: room.fps } });
      }
      return;
    }

    // unknown
    send(ws, { v:1, t:"error", ts: nowTs(), data:{ message:"unknown message type: " + t } });
  });

  ws.on("close", () => {
    // Remove from any room clients set
    for (const room of rooms.values()) {
      room.clients.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log("anim5s server listening on", PORT);
});
