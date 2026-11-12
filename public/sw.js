// オフライン対応: アプリ本体と解析モデルを端末に保存して、2回目以降はネットなしで使えるようにする。
// 写真は扱わない（写真はネットワークにもキャッシュにも出ない）。
// 初回はページ側が読み込んだものをそのまま保存するので、二重にダウンロードしない。
const CACHE = 'monitor-collage-v3';
const MODEL_HOSTS = ['storage.googleapis.com', 'unpkg.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (!same && !MODEL_HOSTS.includes(url.hostname)) return;
  // 画面（HTML）は最新を優先、ネットがなければ保存済み
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./', copy));
        return res;
      }).catch(() => caches.match('./')),
    );
    return;
  }
  // それ以外（JS・モデル）は保存済みを優先
  e.respondWith(
    caches.match(req.url).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.url, copy));
      }
      return res;
    })),
  );
});
