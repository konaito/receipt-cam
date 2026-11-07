#!/bin/sh
# clasp で Apps Script を上げて、ウェブアプリとして公開する（clasp を使わないなら README の「エディタに貼る」手順で同じことができる）
# 初回: プロジェクトを作り（gas/.clasp.json）、デプロイを作る（gas/.deployment-id）
# 2回目から: 同じデプロイを新しい版に差し替える（URL は変わらない）
# clasp は CLASP（既定 npx -y @google/clasp@3.3.0）で呼ぶ。先に clasp login しておく
set -eu
cd "$(dirname "$0")"
CLASP=${CLASP:-npx -y @google/clasp@3.3.0}

if [ ! -s .clasp.json ]; then
  # create-script はカレントに .clasp.json を作り、雛形の appsscript.json を取ってくる。
  # 手元の appsscript.json を上書きさせないよう、一時フォルダで作って scriptId だけ使う
  tmp=$(mktemp -d)
  (cd "$tmp" && $CLASP create-script --type standalone --title "${RECEIPT_CAM_TITLE:-receipt-cam}" >&2)
  script_id=$(sed -n 's/.*"scriptId": *"\([^"]*\)".*/\1/p' "$tmp/.clasp.json")
  rm -rf "$tmp"
  [ -n "$script_id" ] || { echo "scriptId を読めなかった" >&2; exit 1; }
  printf '{ "scriptId": "%s", "rootDir": "" }\n' "$script_id" > .clasp.json
  echo "プロジェクトを作った: https://script.google.com/d/$script_id/edit" >&2
fi

$CLASP push -f

if [ -s .deployment-id ]; then
  $CLASP update-deployment "$(cat .deployment-id)" -d "$(date +%Y%m%d-%H%M)"
else
  out=$($CLASP create-deployment -d "$(date +%Y%m%d-%H%M)" --json)
  deployment_id=$(printf '%s' "$out" | sed -n 's/.*"deploymentId": *"\([^"]*\)".*/\1/p')
  [ -n "$deployment_id" ] || { echo "deploymentId を読めなかった: $out" >&2; exit 1; }
  echo "$deployment_id" > .deployment-id
fi

script_id=$(sed -n 's/.*"scriptId": *"\([^"]*\)".*/\1/p' .clasp.json)
cat >&2 <<MSG

ウェブアプリの URL: https://script.google.com/macros/s/$(cat .deployment-id)/exec
初回は https://script.google.com/d/$script_id/edit で setup を実行し、Drive の権限を許可する。
実行ログのキーを付けた「ウェブアプリの URL?k=<キー>」が、カメラアプリに入れる送り先 URL になる。
MSG
