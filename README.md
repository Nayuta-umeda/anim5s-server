# 5秒アニメ Phase2（改善版 v2）

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

