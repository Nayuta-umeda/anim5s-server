# anim5s (spec 2026-01-15)

## 確定仕様
部屋は3つ：
- テーマを作成（公開: 1コマ目 / プライベート: ローカルのみ）
- テーマに参加（公開ランダム参加）
- 自分の作品（公開の追跡 + ローカルプライベート編集）

重要：
- 公開「テーマを作成」は **1コマ目を提出した瞬間にだけ** サーバ上に部屋が生成されます（提出まで他人に反映されません / A案）。
- プライベート作品は **ローカル保存のみ**（サーバに送信しません）。
- 「テーマに参加」は **予約トークン方式**（期限あり / 提出時に検証）。

## フォルダ
- `client/` : GitHub Pages 等に置く静的ファイル
- `server/` : Render 等で動かす WebSocket サーバ（/ws）

## Render（Web Service）でサーバを動かす
1. Renderで新しいWeb Serviceを作成（GitHubリポジトリを選択）
2. Root Directory を `server` に設定
3. Start Command は `npm start`（package.jsonに定義済み）
4. デプロイ後、URL（例：https://xxxx.onrender.com）を `client/config.js` の `DEFAULT_SERVER_BASE` に設定

## GitHub Pages
`client/` を公開対象にしてください（docs/運用でもOK）。

## 接続確認
`client/ws-test.html` を開いて OPEN/RECV が出るか確認。
