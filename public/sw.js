// オフライン対応: 一度読み込んだファイル（アプリ本体・解析モデル）を端末に保存して再利用する。
// 写真は扱わない（写真はネットワークにもキャッシュにも出ない）。
const CACHE = 'monitor-collage-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './wasm/vision_wasm_internal.js',
  './wasm/vision_wasm_internal.wasm',
  './models/blaze_face_short_range.tflite',
  './models/face_landmarker.task',
  './models/pose_landmarker_lite.task',
  './models/selfie_segmenter.tflite',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 画面（HTML）は最新を優先、それ以外は保存済みを優先
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => caches.match('./index.html')),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    })),
  );
});
