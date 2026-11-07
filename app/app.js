// カメラ画面と設定画面。UI 部品は Ionic、カメラはブラウザ標準の getUserMedia と ImageCapture
const $ = (id) => document.getElementById(id);
const video = $('video');
let stream = null;
let track = null;
let imageCapture = null;
let torchOn = false;
let testedApi = null; // 疎通確認に通った URL
let trayUrl = null;

// ---------------------------------------------------------------- カメラ

async function startCamera() {
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 4096 } },
      audio: false,
    });
  } catch (e) {
    $('nocam').hidden = false;
    $('nocam-msg').textContent = e.message + '（右下のボタンで画像を選んで送れる）';
    return;
  }
  $('nocam').hidden = true;
  video.srcObject = stream;
  track = stream.getVideoTracks()[0];
  imageCapture = 'ImageCapture' in window ? new ImageCapture(track) : null;
  $('shutter').disabled = false;
  setupControls();
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = track = imageCapture = null;
  torchOn = false;
}

// ライトとズームは、端末が対応しているときだけ出す
function setupControls() {
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  $('torch').hidden = !caps.torch;
  $('torch').setAttribute('color', torchOn ? 'warning' : '');
  const zoom = $('zoom');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const steps = [caps.zoom.min, 2, 3].filter((z, i) => i === 0 || (z > caps.zoom.min && z <= caps.zoom.max));
    zoom.innerHTML = steps.map((z) => `<ion-segment-button value="${z}"><ion-label>${z === caps.zoom.min && z === 1 ? '1' : z}×</ion-label></ion-segment-button>`).join('');
    zoom.value = String(track.getSettings().zoom || caps.zoom.min);
    zoom.hidden = steps.length < 2;
  } else {
    zoom.hidden = true;
  }
}

$('torch').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; toast('ライトを点けられない'); }
  $('torch').setAttribute('color', torchOn ? 'warning' : '');
});

$('zoom').addEventListener('ionChange', (e) => {
  track?.applyConstraints({ advanced: [{ zoom: Number(e.detail.value) }] }).catch(() => {});
});

// ImageCapture が使えればセンサーの解像度で撮る。だめなら映像の1コマを使う
async function grab() {
  if (imageCapture) {
    try { return await imageCapture.takePhoto(); } catch (e) { /* 映像の1コマにする */ }
  }
  return canvasBlob(frameCanvas(video.videoWidth), 0.92);
}

// 映像の今のコマを、長辺 px の canvas にする
function frameCanvas(px) {
  const scale = Math.min(1, px / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c;
}

const canvasBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

// 長辺 2400px の JPEG にする（領収書の文字が読める大きさ）
async function shrink(blob, px = 2400, q = 0.85) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, px / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return canvasBlob(c, q);
}

function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

// 1枚を端末に積んで送る。thumb は一覧用の小さい画像
async function save(raw, thumb) {
  const id = crypto.randomUUID();
  const takenAt = localIso();
  const blob = await shrink(raw);
  await enqueue({ id, takenAt, blob });
  await recentPut({ id, takenAt, thumb: thumb || await shrink(blob, 360, 0.7), state: 'pending' });
  await refresh();
  send();
}

// 連写できるよう、シャッターは止めない。重い処理は順番に流す
let chain = Promise.resolve();
$('shutter').addEventListener('click', () => {
  if (!stream) return;
  navigator.vibrate?.(30);
  $('flash').classList.remove('on');
  void $('flash').offsetWidth;
  $('flash').classList.add('on');
  const thumbCanvas = frameCanvas(360);
  showTray(thumbCanvas.toDataURL('image/jpeg', 0.7));
  const raw = grab();
  chain = chain.then(async () => save(await raw, await canvasBlob(thumbCanvas, 0.7)))
    .catch((e) => toast('撮れなかった: ' + e.message));
});

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (ev) => {
  for (const f of ev.target.files) await save(f);
  ev.target.value = '';
});

// ---------------------------------------------------------------- 送信と表示

async function send() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.sync?.register('drain'); // 画面を閉じても、つながったら送る
  } catch (e) { /* Background Sync 非対応。画面が開いている間に送る */ }
  try {
    await drain();
  } catch (e) {
    if (e.code !== 'no-api') toast('未送信あり（あとで自動で送る）: ' + e.message);
  }
  await refresh();
  if (openPages.has('recent')) renderRecent();
}

function showTray(src) {
  if (trayUrl) URL.revokeObjectURL(trayUrl);
  trayUrl = src.startsWith('blob:') ? src : null;
  $('tray-img').src = src;
  $('tray-img').hidden = false;
}

async function refresh() {
  const api = await kvGet('api');
  const n = (await pending()).length;
  const folder = await kvGet('folder');
  const chip = $('status');
  if (!api) {
    chip.dataset.s = 'unset';
    $('status-icon').name = 'alert-circle';
    $('status-text').textContent = '送り先を設定';
  } else if (n) {
    chip.dataset.s = 'pending';
    $('status-icon').name = 'cloud-upload-outline';
    $('status-text').textContent = `未送信 ${n} 枚`;
  } else {
    chip.dataset.s = 'ok';
    $('status-icon').name = 'checkmark-circle';
    $('status-text').textContent = folder ? `Drive「${folder.name}」` : 'Drive に直結';
  }
  $('tray-badge').hidden = !n;
  $('tray-badge').textContent = String(n);
  const [latest] = await recentAll();
  if (latest && !$('tray-img').src) showTray(URL.createObjectURL(latest.thumb));

  $('kv-api').textContent = api ? new URL(api).pathname.split('/').slice(-2, -1)[0].slice(0, 10) + '…' : '未設定';
  $('kv-folder').textContent = folder ? folder.name : '—';
  $('kv-pending').textContent = `${n} 枚`;
}

bus?.addEventListener('message', () => { refresh(); if (openPages.has('recent')) renderRecent(); });

function toast(message) {
  const t = $('toast');
  t.message = message;
  t.present?.();
}

// ---------------------------------------------------------------- 全画面のページ
// 設定と一覧は全画面で開く。開いたら履歴を1つ積み、Android の戻る操作で閉じられるようにする
// present() で開いたモーダルは isOpen に出ないので、開いているページを自分で持つ
const openPages = new Set();
for (const id of ['settings', 'recent']) {
  const m = $(id);
  m.addEventListener('ionModalDidPresent', () => { openPages.add(id); history.pushState({ page: id }, ''); });
  m.addEventListener('ionModalDidDismiss', () => { openPages.delete(id); if (history.state?.page === id) history.back(); });
}
addEventListener('popstate', () => {
  for (const id of openPages) if (history.state?.page !== id) $(id).dismiss();
});

// ---------------------------------------------------------------- 設定と疎通確認

const settings = $('settings');
$('status').addEventListener('click', () => settings.present());
$('open-settings').addEventListener('click', () => settings.present());
$('settings-close').addEventListener('click', () => settings.dismiss());
settings.addEventListener('ionModalWillPresent', async () => {
  const api = await kvGet('api');
  if (api && !$('api-input').value) $('api-input').value = api;
  refresh();
});
$('api-input').addEventListener('ionInput', () => { testedApi = null; $('save').disabled = true; });

$('paste').addEventListener('click', async () => {
  try { $('api-input').value = (await navigator.clipboard.readText()).trim(); testedApi = null; $('save').disabled = true; }
  catch (e) { toast('貼り付けできない。長押しで貼り付けて'); }
});

function mark(step, state, detail = '') {
  const item = document.querySelector(`.check[data-step="${step}"]`);
  const icon = item.querySelector('[slot="start"]');
  const next = state === 'run' ? document.createElement('ion-spinner') : document.createElement('ion-icon');
  next.slot = 'start';
  if (state === 'run') next.name = 'crescent';
  else {
    next.name = { ok: 'checkmark-circle', ng: 'close-circle', wait: 'ellipse-outline' }[state];
    next.color = { ok: 'success', ng: 'danger', wait: 'medium' }[state];
  }
  icon.replaceWith(next);
  item.querySelector('p').textContent = detail;
}

// URL の形 → 届くか → キー → フォルダ の順に確かめる。どこで止まったかと直し方を出す
async function test() {
  const raw = String($('api-input').value || '').trim();
  $('checks').hidden = false;
  ['url', 'reach', 'key', 'drive'].forEach((s) => mark(s, 'wait'));
  $('save').disabled = true;
  testedApi = null;

  mark('url', 'run');
  let url;
  try { url = new URL(raw); } catch (e) { return mark('url', 'ng', 'URL として読めない'); }
  if (url.protocol !== 'https:' || url.host !== 'script.google.com') return mark('url', 'ng', 'https://script.google.com/… で始まる URL を入れる');
  if (url.pathname.endsWith('/dev')) return mark('url', 'ng', '/dev はテスト用で作者しか使えない。デプロイの /exec の URL を使う');
  if (!url.pathname.endsWith('/exec')) return mark('url', 'ng', 'ウェブアプリの URL（/exec で終わる）を使う');
  if ((url.searchParams.get('k') || '').length < 32) return mark('url', 'ng', '末尾に ?k=<キー> が無い。キーは setup の実行ログにある');
  mark('url', 'ok', url.pathname.split('/').slice(-2, -1)[0].slice(0, 16) + '…');

  mark('reach', 'run');
  let body;
  try {
    body = await ping(url.href);
  } catch (e) {
    if (e.code === 'not-json') return mark('reach', 'ng', 'Apps Script が JSON 以外を返した。setup を実行して Drive の権限を許可したか確かめる（' + e.message + '）');
    return mark('reach', 'ng', '届かない。デプロイの「アクセスできるユーザー」が「全員」か、圏外でないかを確かめる');
  }
  if (body.app !== 'receipt-cam' && body.error !== 'bad key' && !String(body.error).startsWith('no key')) {
    return mark('reach', 'ng', 'receipt-cam の Apps Script ではない応答: ' + JSON.stringify(body).slice(0, 120));
  }
  mark('reach', 'ok');

  mark('key', 'run');
  if (String(body.error).startsWith('no key')) return mark('key', 'ng', 'Apps Script で setup をまだ実行していない');
  if (body.error === 'bad key') return mark('key', 'ng', 'キーが違う。setup の実行ログのキーと見比べる');
  mark('key', 'ok');

  mark('drive', 'run');
  if (!body.ok || !body.folder) return mark('drive', 'ng', body.error || 'フォルダを開けない');
  mark('drive', 'ok', `「${body.folder.name}」に保存する`);
  testedApi = url.href;
  await kvSet('pendingFolder', body.folder);
  $('save').disabled = false;
}
$('test').addEventListener('click', test);

$('save').addEventListener('click', async () => {
  if (!testedApi) return;
  await kvSet('api', testedApi);
  await kvSet('folder', await kvGet('pendingFolder'));
  await settings.dismiss();
  toast('送り先を保存した');
  send();
});

$('send-now').addEventListener('click', send);
$('forget').addEventListener('click', async () => {
  await kvDel('api');
  await kvDel('folder');
  $('api-input').value = '';
  $('checks').hidden = true;
  await refresh();
  toast('送り先を消した。未送信の写真は端末に残る');
});
$('kv-folder-item').addEventListener('click', async () => {
  const folder = await kvGet('folder');
  if (folder?.url) window.open(folder.url, '_blank', 'noopener');
});

// セットアップ用リンク（#api=<送り先 URL>）で開いたら、欄に入れて疎通確認まで進める
async function takeApiFromHash() {
  const m = location.hash.match(/^#api=(.+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname);
  await customElements.whenDefined('ion-modal');
  $('api-input').value = decodeURIComponent(m[1]);
  await settings.present();
  test();
  return true;
}

// ---------------------------------------------------------------- 最近の写真

const recent = $('recent');
$('tray').addEventListener('click', () => recent.present());
$('recent-close').addEventListener('click', () => recent.dismiss());
recent.addEventListener('ionModalWillPresent', renderRecent);

let gridUrls = [];
async function renderRecent() {
  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
  const all = await recentAll();
  $('grid-empty').hidden = all.length > 0;
  $('grid').innerHTML = '';
  for (const r of all) {
    const u = URL.createObjectURL(r.thumb);
    gridUrls.push(u);
    const fig = document.createElement('figure');
    const label = { sent: ['送信済み', 'success'], sending: ['送信中', 'primary'], pending: ['未送信', 'warning'] }[r.state] || ['未送信', 'warning'];
    fig.innerHTML = `<img alt=""><ion-badge color="${label[1]}">${label[0]}</ion-badge>`;
    fig.querySelector('img').src = u;
    fig.title = r.takenAt.slice(0, 19).replace('T', ' ');
    if (r.fileId) fig.addEventListener('click', () => window.open(`https://drive.google.com/file/d/${r.fileId}/view`, '_blank', 'noopener'));
    $('grid').append(fig);
  }
}

// ---------------------------------------------------------------- 起動

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else { startCamera(); send(); }
});
addEventListener('online', send);
addEventListener('hashchange', takeApiFromHash);
setInterval(send, 60000);

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  navigator.storage?.persist?.(); // 未送信の写真がブラウザに消されないように
  await refresh();
  startCamera();
  const fromLink = await takeApiFromHash();
  if (!fromLink && !(await kvGet('api'))) {
    await customElements.whenDefined('ion-modal');
    settings.present();
  }
  send();
})();
