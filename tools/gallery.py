# /// script
# requires-python = ">=3.11"
# ///
"""Drive の receipts フォルダにある領収書写真を、手元のブラウザで一覧する。

    uv run tools/gallery.py --account you@example.com --folder <フォルダID>
    uv run tools/gallery.py --no-open  # ブラウザを開かない
    uv run tools/gallery.py --port 9000

アカウントとフォルダは環境変数 RECEIPT_CAM_ACCOUNT・RECEIPT_CAM_FOLDER_ID でも渡せる。
写真の正本は Drive。ここでは tmp/ にキャッシュして配信するだけで、Drive 側は変更しない。
配信先は 127.0.0.1 のみ。標準ライブラリと gog・sips（macOS）だけで動く。
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ACCOUNT = ""  # main() で決める
FOLDER_ID = ""
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "tmp"
THUMB_PX = 480
NAME_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_([0-9a-f]{8})\.jpe?g$")


def gog(*args: str) -> dict:
    cmd = ["gog", "drive", *args, "--account", ACCOUNT, "--json", "--no-input"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"gog が失敗: {' '.join(cmd)}\n{proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout) if proc.stdout.strip() else {}
    except json.JSONDecodeError:
        sys.exit(f"gog の出力が JSON でない: {proc.stdout[:200]}")


def list_files() -> list[dict]:
    """全ページを取る。ページトークンが繰り返したら途中で止める（黙って欠けさせない）。"""
    files: list[dict] = []
    seen_tokens: set[str] = set()
    token = ""
    for _ in range(100):
        args = ["ls", "--parent", FOLDER_ID, "--max", "100"]
        if token:
            args += ["--page", token]
        data = gog(*args)
        files.extend(data.get("files", []))
        token = data.get("nextPageToken") or ""
        if not token:
            break
        if token in seen_tokens:
            sys.exit("gog のページトークンが繰り返した。一覧が完全か分からないので中断")
        seen_tokens.add(token)
    else:
        sys.exit("ページが 100 を超えた。一覧が完全か分からないので中断")
    ids = [f["id"] for f in files]
    if len(ids) != len(set(ids)):
        sys.exit("同じファイル ID が複数回返った。一覧が壊れているので中断")
    return files


def ensure_cached(f: dict) -> tuple[Path, Path]:
    """原寸とサムネイルをキャッシュに置く。ファイル ID をキーにするので再取得しない。"""
    ext = ".jpg" if f.get("mimeType", "").startswith("image/jpeg") else Path(f["name"]).suffix or ".bin"
    full = CACHE / "full" / f"{f['id']}{ext}"
    thumb = CACHE / "thumb" / f"{f['id']}.jpg"
    if not full.exists() or full.stat().st_size != int(f.get("size", -1)):
        full.parent.mkdir(parents=True, exist_ok=True)
        print(f"取得 {f['name']}", file=sys.stderr)
        gog("download", f["id"], "--out", str(full))
        if not full.exists() or full.stat().st_size == 0:
            sys.exit(f"ダウンロードが空: {f['name']}")
        thumb.unlink(missing_ok=True)
    if not thumb.exists():
        thumb.parent.mkdir(parents=True, exist_ok=True)
        if shutil.which("sips"):
            r = subprocess.run(["sips", "-Z", str(THUMB_PX), str(full), "--out", str(thumb)],
                               capture_output=True, text=True)
            if r.returncode != 0 or not thumb.exists():
                print(f"sips 失敗（原寸で代用）: {f['name']}: {r.stderr.strip()}", file=sys.stderr)
                shutil.copyfile(full, thumb)
        else:
            shutil.copyfile(full, thumb)
    return full, thumb


def taken_label(name: str) -> tuple[str, str]:
    """ファイル名（端末時刻）から撮影時刻を取り出す。合わなければ名前をそのまま返す。"""
    m = NAME_RE.match(name)
    if not m:
        return name, ""
    y, mo, d, h, mi, s, short = m.groups()
    return f"{y}-{mo}-{d} {h}:{mi}:{s}", short


def render(files: list[dict], entries: list[tuple[dict, Path, Path]]) -> str:
    cards = []
    for f, full, thumb in entries:
        label, short = taken_label(f["name"])
        size_kb = int(f.get("size", 0)) // 1024
        cards.append(f"""
    <figure>
      <a href="full/{html.escape(full.name)}" target="_blank" rel="noopener">
        <img src="thumb/{html.escape(thumb.name)}" alt="{html.escape(f['name'])}" loading="lazy">
      </a>
      <figcaption>
        <strong>{html.escape(label)}</strong>
        <span>{html.escape(f['name'])} · {size_kb:,} KB</span>
        <span class="row">
          <a href="{html.escape(f.get('webViewLink', ''))}" target="_blank" rel="noopener">Drive で開く</a>
          <button type="button" data-copy-image="full/{html.escape(full.name)}">画像をコピー</button>
          <button type="button" data-copy-text="{html.escape(str(full))}">パスをコピー</button>
        </span>
      </figcaption>
    </figure>""")
    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>receipts 一覧</title>
<style>
  :root {{ --fg: #1f1f1f; --muted: #6b6b6b; --line: #e4e4e4; --bg: #ffffff; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg);
         font: 14px/1.5 -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }}
  header {{ max-width: 1200px; margin: 0 auto 20px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }}
  h1 {{ font-size: 18px; font-weight: 600; margin: 0; }}
  header p {{ margin: 0; color: var(--muted); }}
  main {{ max-width: 1200px; margin: 0 auto; display: grid; gap: 20px;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }}
  figure {{ margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: #fff; }}
  figure > a {{ display: block; aspect-ratio: 3 / 4; background: #f4f4f4; }}
  img {{ width: 100%; height: 100%; object-fit: contain; display: block; }}
  figcaption {{ padding: 10px 12px; display: grid; gap: 2px; }}
  figcaption span {{ color: var(--muted); font-size: 12px; word-break: break-all; }}
  figcaption a {{ color: #2a5bd7; font-size: 12px; text-decoration: none; }}
  figcaption a:hover {{ text-decoration: underline; }}
  .row {{ display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }}
  button {{ font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 4px;
            background: #fff; color: var(--fg); cursor: pointer; }}
  button:hover {{ border-color: #bdbdbd; }}
  button.done {{ border-color: #2a7a3b; color: #2a7a3b; }}
  button.fail {{ border-color: #b3261e; color: #b3261e; }}
</style>
</head>
<body>
<header>
  <h1>receipts 一覧</h1>
  <p>{len(files)} 枚 · Drive（{html.escape(ACCOUNT)}）の receipts フォルダ · 新しい順 · 手元の 127.0.0.1 でだけ配信</p>
</header>
<main>{''.join(cards)}
</main>
<script>
// クリップボードへのコピー。画像は PNG に変換して書く（Chrome は JPEG を受け付けない）
function flash(btn, ok, msg) {{
  const label = btn.textContent;
  btn.textContent = msg;
  btn.classList.add(ok ? 'done' : 'fail');
  setTimeout(() => {{ btn.textContent = label; btn.classList.remove('done', 'fail'); }}, 1500);
}}
async function toPng(url) {{
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return new Promise((ok, ng) => c.toBlob(b => b ? ok(b) : ng(new Error('toBlob failed')), 'image/png'));
}}
document.addEventListener('click', async (ev) => {{
  const btn = ev.target.closest('button[data-copy-image], button[data-copy-text]');
  if (!btn) return;
  try {{
    if (btn.dataset.copyText !== undefined) {{
      await navigator.clipboard.writeText(btn.dataset.copyText);
    }} else {{
      await navigator.clipboard.write([new ClipboardItem({{ 'image/png': toPng(btn.dataset.copyImage) }})]);
    }}
    flash(btn, true, 'コピーした');
  }} catch (e) {{
    console.error(e);
    flash(btn, false, '失敗: ' + (e && e.message || e));
  }}
}});
</script>
</body>
</html>
"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 配信ログは出さない
        pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", default=os.environ.get("RECEIPT_CAM_ACCOUNT"), help="Drive の持ち主（gog のアカウント）")
    ap.add_argument("--folder", default=os.environ.get("RECEIPT_CAM_FOLDER_ID"), help="receipts フォルダの ID")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="ブラウザを開かない")
    ap.add_argument("--no-serve", action="store_true", help="HTML を書くだけで配信しない")
    args = ap.parse_args()
    if not args.account or not args.folder:
        ap.error("--account と --folder（または RECEIPT_CAM_ACCOUNT・RECEIPT_CAM_FOLDER_ID）が要る")
    global ACCOUNT, FOLDER_ID
    ACCOUNT, FOLDER_ID = args.account, args.folder

    if not shutil.which("gog"):
        sys.exit("gog が見つからない")
    files = list_files()
    if not files:
        sys.exit("Drive の receipts フォルダにファイルがない")
    files.sort(key=lambda f: f["name"], reverse=True)  # 名前の先頭が撮影時刻
    entries = [(f, *ensure_cached(f)) for f in files]
    CACHE.mkdir(parents=True, exist_ok=True)
    index = CACHE / "index.html"
    index.write_text(render(files, entries), encoding="utf-8")
    print(f"{len(files)} 枚。HTML: {index}", file=sys.stderr)
    if args.no_serve:
        return

    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(CACHE)))
    except OSError as e:
        sys.exit(f"ポート {args.port} を使えない（{e}）。lsof -i :{args.port} で確かめるか --port を変える")
    print(f"配信中 {url}（Ctrl+C で止める）", file=sys.stderr)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
