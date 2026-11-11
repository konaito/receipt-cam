// カメラ画面と設定画面。UI 部品は Ionic、カメラはブラウザ標準の getUserMedia と ImageCapture
const $ = (id) => document.getElementById(id);
const video = $('video');
let stream = null;
let track = null;
let imageCapture = null;
let torchOn = false;
let testedApi = null; // 疎通確認に通った URL
let testedBody = null; // そのときの Apps Script の応答
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

// 長辺 2400px の JPEG にする（書類の小さい文字が読める大きさ）
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

// 1枚を端末に積んで送る。thumb は一覧用の小さい画像。dest は押した時点の保存先（null は既定のフォルダ）
async function save(raw, thumb, dest) {
  const id = crypto.randomUUID();
  const takenAt = localIso();
  const blob = await shrink(raw);
  await enqueue({ id, takenAt, blob, dest });
  await recentPut({ id, takenAt, thumb: thumb || await shrink(blob, 360, 0.7), state: 'pending', dest });
  await refresh();
  send();
}

function restart(el) {
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

// 連写できるよう、シャッターは止めない。重い処理は順番に流す
// 保存先はここで同期的に確定する。chain の中で読むと、連写中に帯を動かしたとき行き先がずれる
let chain = Promise.resolve();
$('shutter').addEventListener('click', () => {
  if (!stream) return;
  const dest = currentDest();
  navigator.vibrate?.(30);
  restart($('flash'));
  $('shot-dest').textContent = `→ ${destLabel(dest)}`;
  restart($('shot-dest'));
  const thumbCanvas = frameCanvas(360);
  showTray(thumbCanvas.toDataURL('image/jpeg', 0.7));
  const raw = grab();
  chain = chain.then(async () => save(await raw, await canvasBlob(thumbCanvas, 0.7), dest))
    .catch((e) => toast('撮れなかった: ' + e.message));
});

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (ev) => {
  const dest = currentDest();
  const files = [...ev.target.files];
  ev.target.value = '';
  for (const f of files) await save(f, null, dest);
  if (files.length) toast(`${files.length} 枚を「${destLabel(dest)}」に入れた`);
});

// ---------------------------------------------------------------- 送信と表示

async function send() {
  try {
    // ready は service worker が無いと永久に待つので、登録の有無をすぐ返す getRegistration を使う
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.sync?.register('drain'); // 画面を閉じても、つながったら送る
  } catch (e) { /* Background Sync 非対応。画面が開いている間に送る */ }
  try {
    await drain();
  } catch (e) {
    if (e.code !== 'no-api') toast('未送信あり（あとで自動で送る）: ' + e.message);
  }
  await updatePendingNotice();
  await refresh();
  if (openPages.has('recent')) renderRecent();
  // オフラインで足した保存先は、最初の写真を送ったときに Drive にフォルダができる。その ID を取りに行く
  if (dests.some((d) => !d.id) && !(await pending()).some((it) => it.dest && !it.dest.id)) syncDests();
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
  rootName = folder?.name || '既定';
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
    $('status-text').textContent = 'すべて送信済み';
  }
  $('tray-badge').hidden = !n;
  $('tray-badge').textContent = String(n);
  const [latest] = await recentAll();
  if (latest && !$('tray-img').src) showTray(URL.createObjectURL(latest.thumb));

  $('kv-api').textContent = api ? new URL(api).pathname.split('/').slice(-2, -1)[0].slice(0, 10) + '…' : '未設定';
  $('kv-pending').textContent = `${n} 枚`;
  $('root-name').textContent = rootName;
  $('dest-root-name').textContent = rootName;
  $('dest-v2').hidden = !api || version >= 3;
  if ($('band').querySelector('[data-key=""]')?.textContent !== rootName) renderBand();
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
  renderDestSettings();
  renderNotify();
  syncDests();
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
  const more = Array.isArray(body.folders) ? '' : '（保存先を増やすには Apps Script の更新が要る）';
  mark('drive', 'ok', `「${body.folder.name}」に保存する${more}`);
  testedApi = url.href;
  testedBody = body;
  $('save').disabled = false;
}
$('test').addEventListener('click', test);

$('save').addEventListener('click', async () => {
  if (!testedApi) return;
  // 別の Apps Script に替えたら、前の保存先の一覧は使えないので捨てる。未送信の写真は名前で新しい側に入る
  if ((await kvGet('api')) !== testedApi) await resetDests();
  await kvSet('api', testedApi);
  await applyServer(testedBody);
  await settings.dismiss();
  toast('送り先を保存した');
  send();
});

$('send-now').addEventListener('click', send);
$('forget').addEventListener('click', async () => {
  await kvDel('api');
  await kvDel('folder');
  await kvDel('version');
  await resetDests();
  $('api-input').value = '';
  $('checks').hidden = true;
  await refresh();
  toast('送り先を消した。未送信の写真は端末に残る');
});
$('dest-root').addEventListener('click', async () => {
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

// ---------------------------------------------------------------- 保存先
// 保存先は、既定のフォルダ（根）と、その直下に作ったフォルダ。一覧と並び順は画面だけが kv に書く
// kv 'dests': [{ key, id, name }]（根は含めない。id が null なのはオフラインで足し、まだ Drive に無いもの）
// kv 'hidden': [{ id, name }]（帯から外したもの。Drive のフォルダは消さない）
// kv 'dest': 選んでいる保存先の key（'' は根）、kv 'version': 最後に見た Apps Script の VERSION

let dests = [];
let hidden = [];
let currentKey = '';
let version = 0;
let rootName = '既定';

async function loadDests() {
  dests = (await kvGet('dests')) || [];
  hidden = (await kvGet('hidden')) || [];
  version = (await kvGet('version')) || 0;
  currentKey = (await kvGet('dest')) || '';
  if (!dests.some((d) => d.key === currentKey)) currentKey = '';
  renderBand();
}

async function saveDests() {
  if (!dests.some((d) => d.key === currentKey)) currentKey = '';
  await kvSet('dests', dests);
  await kvSet('hidden', hidden);
  await kvSet('dest', currentKey);
  renderBand();
  renderDestSettings();
}

async function resetDests() {
  dests = [];
  hidden = [];
  currentKey = '';
  await saveDests();
}

// シャッターを押した時点の保存先。キューに入れる形（null か { id, name }）にして返す
function currentDest() {
  const d = dests.find((x) => x.key === currentKey);
  return d ? { id: d.id || null, name: d.name } : null;
}

const destLabel = (dest) => dest?.name || rootName;

// Apps Script の応答（doGet）を取り込む。別の端末で足した保存先も、ここで帯に出る
async function applyServer(body) {
  if (!body?.ok) return;
  if (body.folder) await kvSet('folder', body.folder);
  version = Array.isArray(body.folders) ? Number(body.version) || 3 : 2;
  await kvSet('version', version);
  if (version < 3) { await refresh(); return; }
  const server = new Map(body.folders.map((f) => [f.id, f]));
  const byName = new Map(body.folders.map((f) => [f.name, f]));
  const next = [];
  const seen = new Set();
  for (const d of dests) {
    const f = d.id ? server.get(d.id) : byName.get(d.name);
    if (d.id && !f) continue; // Drive で消されたか、根の外に移された
    const id = f ? f.id : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    next.push({ key: d.key, id, name: f ? f.name : d.name });
  }
  hidden = hidden.filter((h) => server.has(h.id)).map((h) => ({ id: h.id, name: server.get(h.id).name }));
  const hiddenIds = new Set(hidden.map((h) => h.id));
  for (const f of body.folders) {
    if (!seen.has(f.id) && !hiddenIds.has(f.id)) next.push({ key: crypto.randomUUID(), id: f.id, name: f.name });
  }
  dests = next;
  await saveDests();
  await refresh();
}

// 送り先に GET して一覧を合わせる。圏外などで失敗したら、手元の一覧のまま使う
async function syncDests() {
  const api = await kvGet('api');
  if (!api) return;
  try { await applyServer(await ping(api)); } catch (e) { /* あとで合わせる */ }
}

// ---- 帯

const band = $('band');
let bandLock = false; // タップや初期位置合わせで動かしている間は、途中の項目を選ばない
let bandRaf = 0;
let bandTimer = 0;

function renderBand() {
  const items = [{ key: '', name: rootName }, ...dests];
  band.innerHTML = '';
  for (const d of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.key = d.key;
    b.textContent = d.name;
    band.append(b);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add';
  add.textContent = '＋';
  add.setAttribute('aria-label', '保存先を足す');
  band.append(add);
  markBand();
  requestAnimationFrame(() => centerOn(currentKey, 'instant'));
}

function markBand() {
  for (const b of band.querySelectorAll('[role="radio"]')) b.setAttribute('aria-checked', String(b.dataset.key === currentKey));
}

function centerOn(key, behavior) {
  const b = band.querySelector(`[role="radio"][data-key="${CSS.escape(key)}"]`);
  if (!b || !band.clientWidth) return;
  const left = b.offsetLeft + b.offsetWidth / 2 - band.clientWidth / 2;
  if (Math.abs(band.scrollLeft - left) < 1) return;
  bandLock = true;
  band.scrollTo({ left, behavior });
  if (behavior === 'instant') requestAnimationFrame(() => { bandLock = false; });
}

function select(key) {
  if (key === currentKey) return;
  currentKey = key;
  markBand();
  navigator.vibrate?.(8);
}

// 中央に最も近い保存先を選ぶ。スクロールの途中でも選び直し、止まったら覚える
function pickCenter() {
  const mid = band.scrollLeft + band.clientWidth / 2;
  let best = null;
  let dist = Infinity;
  for (const b of band.querySelectorAll('[role="radio"]')) {
    const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid);
    if (d < dist) { dist = d; best = b; }
  }
  if (best) select(best.dataset.key);
}

function settle() {
  clearTimeout(bandTimer);
  bandLock = false;
  pickCenter();
  kvSet('dest', currentKey);
}

band.addEventListener('scroll', () => {
  if (!bandLock && !bandRaf) bandRaf = requestAnimationFrame(() => { bandRaf = 0; if (!bandLock) pickCenter(); });
  clearTimeout(bandTimer);
  bandTimer = setTimeout(settle, 180); // scrollend が無いブラウザ用
}, { passive: true });
band.addEventListener('scrollend', settle);

band.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.classList.contains('add')) { addDest(); return; }
  select(b.dataset.key);
  kvSet('dest', currentKey);
  centerOn(b.dataset.key, 'smooth');
});

addEventListener('resize', () => centerOn(currentKey, 'instant'));

// ---- 追加・名前の変更・帯から外す・並べ替え

function v2Notice() {
  return alertBox({
    header: 'Apps Script の更新が要る',
    message: '保存先を増やすには、Apps Script を新しい gas/Code.js に更新して、デプロイし直す（デプロイを管理 → 編集 → 新しいバージョン）。送り先 URL は変わらない。更新するまでは既定のフォルダに保存する。',
    buttons: ['OK'],
  });
}

async function alertBox(opts) {
  const a = document.createElement('ion-alert');
  Object.assign(a, opts);
  document.querySelector('ion-app').append(a);
  await a.present();
  const res = await a.onDidDismiss();
  a.remove();
  return res;
}

// 名前を1つ聞く。キャンセルなら null
async function askName(header, value = '') {
  const res = await alertBox({
    header,
    inputs: [{ name: 'name', type: 'text', value, placeholder: '例: 名刺', attributes: { maxlength: DEST_NAME_MAX, enterkeyhint: 'done' } }],
    buttons: [{ text: 'やめる', role: 'cancel' }, { text: 'OK', role: 'confirm' }],
  });
  if (res.role !== 'confirm') return null;
  return String(res.data?.values?.name ?? '');
}

const isOffline = (e) => e instanceof TypeError; // fetch が届かなかった

async function addDest() {
  const api = await kvGet('api');
  if (!api) { toast('先に送り先 URL を設定する'); settings.present(); return; }
  const raw = await askName('保存先を足す');
  if (raw === null) return;
  const err = destNameError(raw);
  if (err) { toast(err); return; }
  const name = raw.trim();
  const same = dests.find((d) => d.name === name);
  if (same) { currentKey = same.key; await saveDests(); toast(`「${name}」はもうある`); return; }
  const h = hidden.find((x) => x.name === name);
  if (h) { hidden = hidden.filter((x) => x !== h); return pushDest({ id: h.id, name }); }
  let body;
  try {
    body = await postAction(api, { action: 'mkdir', name });
  } catch (e) {
    if (!isOffline(e)) { toast('作れなかった: ' + e.message); return; }
    if (version < 3) { toast('つながったときに足せる'); return; }
    toast('圏外なので、最初の写真を送るときに Drive にフォルダを作る');
    return pushDest({ id: null, name });
  }
  if (body.ok) {
    if (version < 3) { version = 3; kvSet('version', 3); refresh(); }
    const dup = dests.find((d) => d.id === body.dest.id);
    if (dup) { currentKey = dup.key; return saveDests(); }
    return pushDest({ id: body.dest.id, name: body.dest.name });
  }
  if (body.error === 'bad request') { version = 2; await kvSet('version', 2); await refresh(); return v2Notice(); } // version 2 は mkdir を知らない
  toast('作れなかった: ' + body.error);
}

async function pushDest(d) {
  const key = crypto.randomUUID();
  dests.push({ key, ...d });
  currentKey = key;
  await saveDests();
}

async function renameDest(d) {
  const raw = await askName('名前を変える', d.name);
  if (raw === null) return;
  const err = destNameError(raw);
  if (err) { toast(err); return; }
  const name = raw.trim();
  if (name === d.name) return;
  if (dests.some((x) => x !== d && x.name === name)) { toast('その名前の保存先はもうある'); return; }
  if (d.id) {
    let body;
    try { body = await postAction(await kvGet('api'), { action: 'rename', dest: { id: d.id }, name }); }
    catch (e) { toast(isOffline(e) ? 'つながっているときに変えられる' : '変えられなかった: ' + e.message); return; }
    if (!body.ok) { toast(body.error === 'exists' ? 'Drive に同じ名前のフォルダがある' : '変えられなかった: ' + body.error); return; }
  }
  d.name = name;
  await saveDests();
}

async function hideDest(d) {
  dests = dests.filter((x) => x !== d);
  if (d.id) hidden.push({ id: d.id, name: d.name }); // Drive のフォルダは消さない
  await saveDests();
  toast(`「${d.name}」を帯から外した。Drive のフォルダは残る`);
}

async function destMenu(d) {
  const sheet = document.createElement('ion-action-sheet');
  sheet.header = d.name;
  sheet.buttons = [
    { text: '名前を変える', data: 'rename' },
    { text: '帯から外す', role: 'destructive', data: 'hide' },
    { text: 'やめる', role: 'cancel' },
  ];
  document.querySelector('ion-app').append(sheet);
  await sheet.present();
  const { data } = await sheet.onDidDismiss();
  sheet.remove();
  if (data === 'rename') renameDest(d);
  if (data === 'hide') hideDest(d);
}

function renderDestSettings() {
  const group = $('dest-reorder');
  group.innerHTML = '';
  for (const d of dests) {
    const item = document.createElement('ion-item');
    item.button = true;
    item.detail = false;
    item.innerHTML = '<ion-label></ion-label><ion-reorder slot="end"></ion-reorder>';
    item.querySelector('ion-label').textContent = d.name;
    if (!d.id) {
      const note = document.createElement('p');
      note.textContent = 'まだ Drive に無い（最初の写真を送るときに作る）';
      item.querySelector('ion-label').append(note);
    }
    item.addEventListener('click', () => destMenu(d));
    group.append(item);
  }
  $('hidden-list').hidden = !hidden.length;
  const box = $('hidden-items');
  box.innerHTML = '';
  for (const h of hidden) {
    const item = document.createElement('ion-item');
    item.innerHTML = '<ion-label></ion-label><ion-button slot="end" fill="clear">戻す</ion-button>';
    item.querySelector('ion-label').textContent = h.name;
    item.querySelector('ion-button').addEventListener('click', async () => {
      hidden = hidden.filter((x) => x !== h);
      dests.push({ key: crypto.randomUUID(), id: h.id, name: h.name });
      await saveDests();
    });
    box.append(item);
  }
}

$('dest-reorder').addEventListener('ionReorderEnd', async (ev) => {
  dests = ev.detail.complete(dests);
  await saveDests();
});
$('dest-add').addEventListener('click', addDest);

// ---------------------------------------------------------------- 未送信の通知

async function renderNotify() {
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
  $('notify-list').hidden = !supported;
  if (!supported) return;
  $('notify').checked = (await kvGet('notify')) === true && Notification.permission === 'granted';
}

$('notify').addEventListener('ionChange', async (ev) => {
  if (ev.detail.checked) {
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') {
      $('notify').checked = false;
      toast(perm === 'denied' ? 'ブラウザの設定で、このサイトの通知が止められている' : '通知を許可しなかった');
      return;
    }
  }
  await kvSet('notify', ev.detail.checked);
  await updatePendingNotice();
});

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
    fig.innerHTML = `<img alt=""><figcaption></figcaption><ion-badge color="${label[1]}">${label[0]}</ion-badge>`;
    fig.querySelector('img').src = u;
    fig.querySelector('figcaption').textContent = destLabel(r.dest);
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
addEventListener('online', () => { send(); syncDests(); });
addEventListener('hashchange', takeApiFromHash);
setInterval(send, 60000);

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  navigator.storage?.persist?.(); // 未送信の写真がブラウザに消されないように
  await loadDests();
  await refresh();
  syncDests();
  startCamera();
  const fromLink = await takeApiFromHash();
  if (!fromLink && !(await kvGet('api'))) {
    await customElements.whenDefined('ion-modal');
    settings.present();
  }
  send();
})();
