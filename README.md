# 共同5秒アニメ（1人1フレーム）V12 ZIP

## 構成
- /client: GitHub Pages 等で配信する静的ファイル
- /server: Node.js + ws の WebSocket サーバ（Render 等で稼働想定）

## V12 追加点（重要）
- デバッグログを localStorage に保存（キー: `anim5s_debug_log_v12`, 最大1200件）
- 右下「LOG」ボタンでログ表示、絞り込み、コピー、消去
- WebSocket をラップして送受信ログを自動記録（ws_ctor/open/send/recv/close/error）
- `wsUrlFromBase()` を強化（/ws 二重付加防止、ws/wss/プロトコル無しも許容）

## 使い方（ざっくり）
1) `client/config.js` の `DEFAULT_SERVER_BASE` をあなたのWSサーバURL（httpsのbase）にする  
2) /server を起動（後述）  
3) /client を静的ホスティング（GitHub Pages等）  
4) `ws-test.html` で `wss://.../ws` が OPEN するか確認

## サーバ起動（ローカル）
```bash
cd server
npm i ws
node server.js
```
既定で `http://localhost:3000` が base になります（WSは `ws://localhost:3000/ws`）。

## 注意
- https 上のページからは必ず wss が必要です
- 「お題：-」のまま → join 成功応答が来てない可能性が高いです。LOGで `ws_open -> ws_send(join_*) -> ws_recv(room_state)` を見てください。


## UI変更（2026-01-14）
- 白背景 + 淡い配色（ライトテーマ）
- 編集画面はスクロール無しの1画面（上: お題/部屋ID/担当コマ、中央: 256x256、下: タブ）
- タブは「描く」「見る」
- 手を離すたびに内部更新（下書き保存）。提出は送信 or 3分タイムアウト。
- コマ表記は 1〜60。


## Render用メモ
- Renderにデプロイする場合は `server/package.json` が必要です。
- Renderの Web Service 設定で Root Directory を `server` にし、Start Command は `npm start` が無難です。


## Renderデプロイ注意（Node 22 / ESM対策）
- RenderがESM扱いで起動して `require is not defined` になる場合があるため、serverは `server.cjs` (CommonJS) で起動するようにしています。
- RenderのWeb Serviceは Root Directory を `server` にして、Start Command は `npm start` にしてください。
