// 撮った写真の送信キュー。画面と service worker の両方から読み込む（IndexedDB 経由で共有）
// 送り先は設定画面で入れた URL（GAS のウェブアプリの URL?k=<キー>）。kv の 'api' にある
// キューの各写真は、撮った時点の保存先 dest（null なら根のフォルダ、{ id?, name } なら根の直下のフォルダ）を持つ

const RECENT_MAX = 60;
const DEST_NAME_MAX = 40; // gas/Code.js の NAME_MAX と同じ値

// 保存先の名前の検証。gas/Code.js の nameError と同じ規則。問題が無ければ空文字
function destNameError(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return '名前が空';
  if (name.length > DEST_NAME_MAX) return `名前は ${DEST_NAME_MAX} 文字まで`;
  if (/[\/\\]/.test(name)) return '/ と \\ は使えない';
  if (/[\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') return 'この名前は使えない';
  return '';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('receipt-cam', 2);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore('queue', { keyPath: 'id' });
        db.createObjectStore('kv');
      }
      if (ev.oldVersion < 2) db.createObjectStore('recent', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k));
const enqueue = (item) => tx('queue', 'readwrite', (s) => s.put(item));
const pending = () => tx('queue', 'readonly', (s) => s.getAll());
const dequeue = (id) => tx('queue', 'readwrite', (s) => s.delete(id));

// 最近撮った写真（小さいサムネイルと送信の状態）。トレイと一覧に出す
const recentAll = async () => (await tx('recent', 'readonly', (s) => s.getAll()))
  .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
const recentPut = (r) => tx('recent', 'readwrite', (s) => s.put(r));

async function recentUpdate(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('recent', 'readwrite');
    const s = t.objectStore('recent');
    const g = s.get(id);
    g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function recentPrune() {
  const all = await recentAll();
  const drop = all.slice(RECENT_MAX).filter((r) => r.state === 'sent');
  if (drop.length) await tx('recent', 'readwrite', (s) => drop.forEach((r) => s.delete(r.id)));
}

// 変化を画面に知らせる。service worker から送ったときも画面の表示が変わるように BroadcastChannel を使う
const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('receipt-cam') : null;
const notify = () => bus?.postMessage('changed');

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// GAS の応答を読む。JSON 以外（Google のログイン画面やエラーページ）なら、原因を追えるよう手がかりを付ける
async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) {
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || text.slice(0, 80);
    throw new ApiError('not-json', `JSON でない応答 HTTP ${res.status}「${title.trim()}」`);
  }
}

// 未送信を古い順に送る。画面と service worker が同時に送らないよう Web Locks で1本にする。戻り値は送れた件数
function drain() {
  if (navigator.locks) return navigator.locks.request('receipt-cam-drain', drainOnce);
  return drainOnce();
}

async function drainOnce() {
  const items = (await pending()).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  if (!items.length) return 0;
  const api = await kvGet('api');
  if (!api) throw new ApiError('no-api', '送り先が未設定');
  let sent = 0;
  try {
    for (const it of items) {
      await recentUpdate(it.id, { state: 'sending' });
      notify();
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライトを避ける
        body: JSON.stringify({ id: it.id, takenAt: it.takenAt, mime: it.blob.type, data: await toBase64(it.blob), ...(it.dest ? { dest: it.dest } : {}) }),
      });
      const body = await readJson(res);
      if (!body.ok) throw new ApiError('rejected', body.error || 'send failed');
      await dequeue(it.id);
      // 実際に入ったフォルダを記録する。version 2 の Apps Script は dest を返さず、根に保存する
      await recentUpdate(it.id, { state: 'sent', fileId: body.fileId, sentAt: new Date().toISOString(), dest: body.dest || null });
      sent++;
      notify();
    }
  } catch (e) {
    for (const it of await pending()) await recentUpdate(it.id, { state: 'pending' });
    notify();
    throw e;
  }
  await recentPrune();
  return sent;
}

// 疎通確認。送り先 URL に GET し、キーと保存先のフォルダを確かめる
async function ping(api) {
  const res = await fetch(api, { method: 'GET' });
  return readJson(res);
}

// 保存先の作成や改名など、写真以外の POST。つながらなければ fetch の TypeError がそのまま出る
async function postAction(api, body) {
  const res = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  return readJson(res);
}

// ---------------------------------------------------------------- 未送信の通知
// 枚数の正本は送信キューだけ。画面と service worker の両方からこの関数を呼び、通知とアプリのバッジを合わせる
// 設定画面でオンにして（kv の 'notify'）、通知の権限があるときだけ出す。tag を固定して1つだけにする

const NOTICE_TAG = 'pending';

async function noticeRegistration() {
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) return self.registration;
  // ready は service worker が無いと永久に待つので getRegistration を使う
  return navigator.serviceWorker?.getRegistration();
}

// 「名刺 2・receipts 1」のような保存先ごとの内訳
async function pendingSummary() {
  const items = await pending();
  const rootName = (await kvGet('folder'))?.name || '既定';
  const counts = new Map();
  for (const it of items) {
    const name = it.dest?.name || rootName;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return { n: items.length, detail: [...counts].map(([name, c]) => `${name} ${c}`).join('・') };
}

// 失敗しても送信や sync の結果を変えないよう、例外は外に出さない
async function updatePendingNotice() {
  try {
    const { n, detail } = await pendingSummary();
    const on = (await kvGet('notify')) === true && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    const reg = await noticeRegistration();
    if (reg?.getNotifications) {
      if (on && n) {
        await reg.showNotification(`未送信 ${n} 枚`, {
          tag: NOTICE_TAG, renotify: false, silent: true, body: `${detail}（つながったら自動で送る。タップで開く）`,
          icon: 'icon-192.png', data: { pending: n },
        });
      } else {
        for (const x of await reg.getNotifications({ tag: NOTICE_TAG })) x.close();
      }
    }
    if (on && n) await navigator.setAppBadge?.(n);
    else await navigator.clearAppBadge?.();
  } catch (e) { /* 通知を出せない端末。画面の表示はそのまま */ }
}
