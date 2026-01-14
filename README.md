# 5秒アニメ Phase2（改善版 v5）

## 何を直したか（改善案 → 修正内容）
### ① ロビーは4ボタンだけ
- `client/index.html` を「4ボタンのみ」にしました。

### ② 指を離したら提出される問題
- editorで「指を離す」は **ログ送信だけ**。
- **提出（コマ確定）は**「送信」ボタン または「60秒」だけ。

### ③ サーバーURLを毎回入れない
- 入力UIは消しました。
- `client/config.js` の `DEFAULT_SERVER_BASE` にURLを1回入れるだけでOK。
- ページを開いた時点で自動接続します。

### ④ ページは完全に独立
- `index/create/random/private/gallery/editor` は全部別HTML。
- タブ切り替えは使っていません。

### ⑤ ZIPで出力
- このZIPをそのまま使えます。

---

## 1) まず1回だけ（サーバーURL）
`client/config.js` を開いてこれを自分のサーバーURLに変える：

`https://YOUR-SERVER-URL`

例：
`https://xxxx.onrender.com`

---

## 2) GitHub Pages（client）
GitHubリポジトリの一番上（root）に **clientの中身**を置く。

置くファイル：
- index.html
- create.html
- random.html
- private.html
- gallery.html
- editor.html
- editor.js
- common.js
- config.js
- app.css

Pages設定：
- Settings → Pages
- Branch: main
- Folder: /(root)

---

## 3) サーバー（server）
GitHub Pagesだけでは同期できません。サーバーが必要です。

ローカル（PCがある場合）：
```bash
cd server
npm i
npm start
```

確認：
- `http://localhost:8080/health`

---

## 4) 操作
1. ロビー（index.html）
2. 4ボタンのどれか
3. editor.html（編集）

---



## 重要：ローカルで直に開いても動くようにしました
この版は **ES module を使わない** ので、スマホでファイルを直接開いても動きます（「編集へ」が反応しない問題の対策）。



## v4 追加
- editorに「コマを見る」：全60コマを閲覧（見る時は描けない）
- プライベートで作成した部屋は最初から自由編集（any）
- プライベート（any）はコマの上書きOK


## v5 追加
- ギャラリー：作品ごとに「現在の状態を閲覧」「プライベートで編集」
- 閲覧は editor の「見るだけモード」（パネルはスライダーだけ）
- プライベートで編集：元作品を新IDのプライベートへコピーして自由編集


## v6 変更
- 制限時間 3分
- 入室時に大きく「お題 / コマ目」表示
- 送信後に「終了」ポップアップ（ボタンでロビーへ）
- 自分の作品：ボタン縦並び + ページ送り
- プライベートで編集：新ID自動（合言葉だけ）
- ID長さ：基本 7 文字
- 編集画面：スクロールなし + 下のタブ
- コマスライダーは上に常時表示
