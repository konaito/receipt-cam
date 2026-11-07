// アプリ本体と Ionic（CDN、版を固定）をキャッシュして圏外でも開けるようにし、Background Sync で未送信を送る
importScripts('queue.js');
const CACHE = 'receipt-cam-v6';
const SHELL = ['./', 'index.html', 'app.js', 'queue.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = 'https://cdn.jsdelivr.net/npm/@ionic/core@9.0.10/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Ionic は版を固定しているので、キャッシュにあればそれを使う
  if (url.startsWith(CDN)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // 同じオリジンはネット優先で、つながらなければキャッシュ
  if (new URL(url).origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});

// 失敗したら reject され、ブラウザがあとで再試行する
self.addEventListener('sync', (e) => {
  if (e.tag === 'drain') e.waitUntil(drain());
});
