# receipt-cam

領収書を撮ると、その写真が Google Drive のフォルダに届くスマホ用のカメラアプリ（PWA）です。撮ったあとに確認する画面はなく、続けて何枚でも撮れます。ログインはありません。

アプリは https://konaito.github.io/receipt-cam/ にあり、誰でも同じものを使います。写真の送り先は、使う人が自分の Google アカウントに置いた Google Apps Script です。Apps Script が、置いた人の Drive のフォルダに写真を保存します。作者のサーバーやアカウントを経由することはありません。

このアプリが行うのは、撮影して Drive に保存するところまでです。文字の読み取り（OCR）や家計簿への記帳はしません。作者は Drive に溜まった写真を Claude Code に読ませて、別の帳簿に記帳しています。

## 使い方

1. 自分の Apps Script を用意する（下の「Apps Script を置く」）
2. アプリを開き、設定画面の「送り先 URL」に Apps Script の URL を入れて「疎通確認」を押す
3. 4つの確認（URL の形、Apps Script に届く、キーが合う、Drive のフォルダ）が通ったら「この送り先を使う」を押す
4. ブラウザのメニューからホーム画面に追加する

`https://konaito.github.io/receipt-cam/#api=<URL をエンコードしたもの>` を開くと、送り先 URL が欄に入り、疎通確認まで進みます。

## Apps Script を置く

送り先 URL は「ウェブアプリの URL」の末尾にキーを付けた `https://script.google.com/macros/s/<デプロイ ID>/exec?k=<キー>` です。キーを知らない人は写真を送れません。URL が漏れたら、関数 `rotateKey` を実行してキーを作り直してください。

### エディタに貼る（clasp を使わない）

1. https://script.google.com/home/projects/create で新しいプロジェクトを作り、[`gas/Code.js`](gas/Code.js) の中身を貼る
2. プロジェクトの設定で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、[`gas/appsscript.json`](gas/appsscript.json) の中身に置き換える
3. 関数 `setup` を実行し、Drive の権限を許可する。実行ログに保存先のフォルダ、キー、カメラアプリで次にやる手順が出る
4. 「デプロイ」→「新しいデプロイ」で種類を「ウェブアプリ」にし、デプロイする。実行するユーザーは「自分」、アクセスできるユーザーは「全員」を選ぶ
5. 表示された `/exec` で終わる URL の末尾に `?k=<キー>` を付ける。これが送り先 URL

### clasp で上げる（任意）

```sh
npx -y @google/clasp@3.3.0 login   # Apps Script API をオンにしてから
./gas/push.sh
```

`gas/push.sh` は、初回にプロジェクトとデプロイを作り、`gas/.clasp.json` と `gas/.deployment-id` に記録します（どちらも git に入れません）。2回目からは同じデプロイを新しい版に差し替えるので、URL は変わりません。初回だけ、表示されたエディタの URL を開いて `setup` を実行してください。

### 保存先

保存先は、`setup` がマイドライブに作る `receipts` フォルダです。別のフォルダにするときは、プロジェクトの設定の「スクリプト プロパティ」で `FOLDER_ID` にフォルダの ID を入れてください。

ファイル名は `YYYYMMDD_HHMMSS_<id先頭8桁>.jpg`（撮影した端末の時刻）です。同じ名前のファイルがあれば保存しません。送り直しで同じ写真が2枚になるのを防ぐためです。

## アプリの動き

- シャッターを押すと、写真を長辺 2400px の JPEG に縮めて端末の IndexedDB に入れ、すぐ送ります
- 送れなかった写真は端末に残り、画面を開き直したとき、オンラインに戻ったとき、60秒ごと、Background Sync のときに送り直します
- 端末が対応していれば、ライトとズーム（1×・2×・3×）のボタンが出ます
- 左下のサムネイルから、最近撮った写真と送信の状態を見られます
- 圏外でも開けるよう、アプリ本体と Ionic を service worker がキャッシュします

動作を確かめた端末は Android の Chrome です。

## 自分の GitHub Pages に置く

フォークして、Settings → Pages の Source を「GitHub Actions」にします。`main` に push すると `.github/workflows/pages.yml` が `app/` を Pages に出します。手元で試すときは次のとおりです。

```sh
cd app && python3 -m http.server 8000   # http://localhost:8000 を開く
```

## 写真を手元で一覧する

`tools/gallery.py` は Drive の写真を `tmp/` に取り込み、`http://127.0.0.1:8765/` に一覧を出します。手元のブラウザでだけ見られます。[gog](https://github.com/steipete/gogcli) と [uv](https://docs.astral.sh/uv/) を使います。サムネイルは macOS の `sips` で作り、無い環境では原寸の画像を使います。

```sh
uv run tools/gallery.py --account you@example.com --folder <receipts フォルダの ID>
```

フォルダの ID は、`setup` の実行ログに出た URL の `folders/` のあとの部分です。環境変数 `RECEIPT_CAM_ACCOUNT` と `RECEIPT_CAM_FOLDER_ID` でも渡せます。

## ファイル

| ファイル | 役割 |
|---|---|
| `app/index.html`・`app/app.js` | カメラ画面と設定画面。UI 部品は [Ionic Framework](https://ionicframework.com/)（MIT） |
| `app/queue.js` | 未送信の写真の保存と送信、疎通確認。画面と service worker の両方が読み込む |
| `app/sw.js` | オフラインで開くためのキャッシュと Background Sync |
| `gas/Code.js` | 写真を受け取って Drive に保存する Apps Script |
| `gas/push.sh` | clasp で Apps Script を作成・更新・公開する |
| `.github/workflows/pages.yml` | `app/` を GitHub Pages に出す |
| `tools/gallery.py` | Drive の写真を手元で一覧する |
| `tools/make_icons.py` | アイコンの PNG を作る |

## ライセンス

MIT
