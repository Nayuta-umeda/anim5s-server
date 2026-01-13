# 5秒アニメ（みんなで）サーバー（単体）

## ローカル
```bash
npm i
npm start
```
- http://localhost:3000/health
- ws://localhost:3000/ws

## デプロイ
Node.js の Web Service としてデプロイしてください。
- `npm install` → `npm start`
- 公開URLは `https://...` が出ます。
- クライアントには `https://...` を入れてOK（内部で wss://.../ws にします）
