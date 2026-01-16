# みんあ (anim5s) — V43

## 現在の確定仕様（Phase3 最終）
部屋は3つ：
- **テーマを作成**
  - 公開: **1コマ目を提出した瞬間にだけ**サーバ上に部屋が生成される（提出まで他人に反映されない）
  - プライベート: ローカル保存のみ（サーバ送信なし）
- **テーマに参加**
  - 既存公開アニメに参加（**ランダム** or **ID検索**）
  - 参加時に **予約トークン（期限あり）** を発行し、提出時に検証
- **自分の作品（ギャラリー）**
  - 公開作品はローカルにスナップショット保存
  - **「更新」ボタンを押した時だけ**サーバから取得してローカルスナップショット更新（勝手に最新化しない）

重要：
- **未完成の部屋はずっと残り、編集可能**
- **完成済みの部屋は編集不可**で、ランダム/ID参加でも「見つからない」扱い
- **オニオン（前コマ薄表示）は「描く」時だけ**。Viewer（見る）や保存はオニオン無し表示基準
- ZIP生成時は **.gif ファイルは同梱しない**（コードの gif.js は含む）

## Phase4 Step1（必須）を反映した内容（V43にも含まれる）
- 通信の **リトライ/タイムアウト**（get_frame／ギャラリー更新／提出の待ち）
- 連打などによる状態破綻を避ける **二重実行ガード**（ギャラリー更新など）
- サーバ側での **入力検証（roomId）** + WebSocket **maxPayload** 設定

## フォルダ
- `client/` : GitHub Pages 等に置く静的ファイル
- `server/` : Render 等で動かす WebSocket サーバ（/ws）

## Render（Web Service）でサーバを動かす
1. Renderで新しいWeb Serviceを作成（GitHubリポジトリを選択）
2. Root Directory を `server` に設定
3. Start Command は `npm start`（package.jsonに定義済み）
4. デプロイ後、URL（例：https://xxxx.onrender.com）を `client/config.js` の `DEFAULT_SERVER_BASE` に設定

## 接続確認
`client/ws-test.html` を開いて OPEN/RECV が出るか確認。


## Phase4 Step2（永続化＋メモリ肥大対策）を反映した内容（V43）
- サーバ側の永続化を「原子的書き込み（temp→rename）」にして、クラッシュ時のJSON破損リスクを低減
- rooms_index.json が欠損/破損しても、rooms/ を走査して自動でインデックスを再構築
- 変更があった部屋だけを対象に、一定間隔で backups/ に増分バックアップ（回転保持）
- /health に roomsOnDisk / backups / dataDir を追加

環境変数（任意）：
- DATA_DIR：保存先（Renderの永続ディスクに合わせる）
- ROOM_CACHE_MAX / ROOM_CACHE_IDLE_MS：メモリキャッシュ制御
- BACKUP_INTERVAL_MS / BACKUP_KEEP：バックアップ間隔と保持数


## 監視（Step3）
- サーバログ：ホスティング（Render等）の Logs で確認
- ヘルス：`/health`（または `/healthz`）
- メトリクス：`/metrics`（Prometheus 形式のテキスト）

外形監視（UptimeRobot等）は `/health` を1分おきに叩くのが簡単です。
