const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// ====== 設定（ここだけ触ればOK） ======
const PORT = process.env.PORT || 3000;
const COUNT = 60;                 // 60コマ固定（5秒）
const MAX_DATAURL_LEN = 220_000;  // 画像（PNG DataURL）の最大サイズ

// 部屋が空になったあと、どれくらい残すか（メモリ節約）
const ROOM_TTL_MS = 1000 * 60 * 60;      // 1時間
const CLEANUP_EVERY_MS = 1000 * 60 * 10; // 10分おき

// ping/pong（接続が死んでたら切る）
const HEARTBEAT_MS = 30_000;

// 連打対策（荒らし予防）
const MIN_SUBMIT_INTERVAL_MS = 180; // コマ送信は 0.18秒に1回まで
const MIN_RESYNC_INTERVAL_MS = 800; // 同期は 0.8秒に1回まで

// ====== 便利関数 ======
function uid() { return crypto.randomBytes(8).toString("hex"); }
function now() { return Date.now(); }

function safeRoomId(s){
  s = String(s || "").trim();
  if (!/^[a-z0-9_-]{3,32}$/i.test(s)) return null;
  return s;
}

function makeTheme(seed) {
  const titles = [
    "歩く犬","通勤時間","駅のホーム","雨の日の傘","信号待ち","朝の歯みがき",
    "走る猫","お弁当作り","自転車で帰る","宿題の時間","エレベーター","コンビニ入店",
    "電車でうとうと","お店のレジ","自動ドア","朝の支度","追いかけっこ","ジャンプする人"
  ];
  const notes = [
    "動きがわかるように","シンプルでOK","表情を大きめに","3つくらい動かす",
    "最初と最後を変える","オチがあると強い","左右に動かす","小物を1つ入れる"
  ];
  const s = seed >>> 0;
  return { seed: s, title: titles[s % titles.length], note: notes[(s * 7) % notes.length] };
}

function makeRoom(roomId) {
  const seed = Math.floor(Math.random() * 1_000_000);
  return {
    roomId,
    createdAt: now(),
    updatedAt: now(),
    revision: 0,
    theme: makeTheme(seed),
    frames: Array.from({ length: COUNT }, () => null),
    clients: new Map(), // playerId -> ws
    lastThemeChangeAt: 0,
  };
}

const rooms = new Map();

function getRoom(roomId){
  let r = rooms.get(roomId);
  if (!r) {
    r = makeRoom(roomId);
    rooms.set(roomId, r);
  }
  return r;
}

function roomState(room){
  return {
    roomId: room.roomId,
    revision: room.revision,
    theme: room.theme,
    frames: room.frames,
    players: room.clients.size,
    updatedAt: room.updatedAt
  };
}

function send(ws, obj){
  if (ws.readyState !== 1) return false;
  try{ ws.send(JSON.stringify(obj)); return true; }catch{ return false; }
}

function broadcast(room, obj){
  for (const ws of room.clients.values()) send(ws, obj);
}

function error(ws, message){
  send(ws, { v:1, t:"error", message });
}

function touch(room){ room.updatedAt = now(); }

// ====== 部屋お掃除 ======
function cleanupRooms(){
  const t = now();
  for (const [id, room] of rooms.entries()){
    if (room.clients.size > 0) continue;
    if (t - room.updatedAt > ROOM_TTL_MS) rooms.delete(id);
  }
}
setInterval(cleanupRooms, CLEANUP_EVERY_MS).unref();

// ====== HTTP（動作確認用） ======
const server = http.createServer((req, res)=>{
  if (req.url === "/" || req.url === "/health"){
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok:true, rooms: rooms.size, t: now() }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

// ====== WebSocket ======
const wss = new WebSocketServer({ server, path: "/ws" });

// ping/pong（Renderなどの公開環境で安定させる）
setInterval(()=>{
  for (const ws of wss.clients){
    if (ws.isAlive === false){
      try{ ws.terminate(); }catch{}
      continue;
    }
    ws.isAlive = false;
    try{ ws.ping(); }catch{}
  }
}, HEARTBEAT_MS).unref();

wss.on("connection", (ws)=>{
  const playerId = uid();
  ws._playerId = playerId;
  ws._roomId = null;

  // rate limit 用
  ws._lastSubmitAt = 0;
  ws._lastResyncAt = 0;

  // heartbeat
  ws.isAlive = true;
  ws.on("pong", ()=>{ ws.isAlive = true; });

  send(ws, { v:1, t:"welcome", playerId });

  ws.on("message", (buf)=>{
    let msg;
    try{ msg = JSON.parse(buf.toString("utf8")); }catch{ return; }
    if (!msg || typeof msg.t !== "string") return;

    const type = msg.t;

    // ---- join（最初に必須） ----
    if (type === "join"){
      const roomId = safeRoomId(msg.roomId);
      if (!roomId) return error(ws, "部屋IDが変");

      if (ws._roomId){
        const old = rooms.get(ws._roomId);
        if (old) old.clients.delete(ws._playerId);
      }

      const room = getRoom(roomId);
      ws._roomId = roomId;
      room.clients.set(ws._playerId, ws);
      touch(room);

      send(ws, { v:1, t:"room_state", data: roomState(room) });
      return;
    }

    // join してないならここで止める
    if (!ws._roomId) return error(ws, "先に join してね");
    const room = rooms.get(ws._roomId);
    if (!room) return error(ws, "部屋がない");

    // ---- resync（全体同期） ----
    if (type === "resync"){
      const t = now();
      if (t - ws._lastResyncAt < MIN_RESYNC_INTERVAL_MS) return;
      ws._lastResyncAt = t;
      send(ws, { v:1, t:"room_state", data: roomState(room) });
      return;
    }

    // ---- お題変更 ----
    if (type === "change_theme"){
      const since = now() - room.lastThemeChangeAt;
      if (since < 2000) return; // 2秒に1回
      room.lastThemeChangeAt = now();
      room.theme = makeTheme(Math.floor(Math.random() * 1_000_000));
      room.revision++;
      touch(room);
      broadcast(room, {
        v:1,
        t:"theme_changed",
        data:{ roomId: room.roomId, theme: room.theme, revision: room.revision }
      });
      return;
    }

    // ---- コマ送信 ----
    if (type === "submit_frame"){
      const t = now();
      if (t - ws._lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;
      ws._lastSubmitAt = t;

      const idx = msg.frameIndex | 0;
      const img = msg.img;

      if (idx < 0 || idx >= COUNT) return error(ws, "コマが変");
      if (typeof img !== "string" || !img.startsWith("data:image/png;base64,")) return error(ws, "画像が変");
      if (img.length > MAX_DATAURL_LEN) return error(ws, "画像が大きすぎ");

      room.frames[idx] = img;
      room.revision++;
      touch(room);

      broadcast(room, {
        v:1,
        t:"frame_committed",
        data:{
          roomId: room.roomId,
          frameIndex: idx,
          img,
          by: ws._playerId,
          revision: room.revision,
          theme: room.theme
        }
      });
      return;
    }
  });

  ws.on("close", ()=>{
    const roomId = ws._roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.clients.delete(ws._playerId);
    touch(room);
  });
});

server.listen(PORT, ()=> console.log("server listening on", PORT));

process.on("SIGTERM", ()=>{
  try{ server.close(()=> process.exit(0)); }catch{ process.exit(0); }
});
