// Service worker : garde une copie des fichiers du site sur le téléphone, pour que skred marche sans réseau.
// Avec du réseau, c'est toujours la version en ligne qui est servie (et la copie est mise à jour).
// Sans réseau, c'est la copie. Aucune requête ne part vers un autre site.
const CACHE = 'skred';
const FILES = [
  './',
  'style.css',
  'app.js',
  'detector.js',
  'detect-worker.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'models/yunet.onnx',
  'vendor/fonts/fonts.css',
  'vendor/fonts/archivo-latin.woff2',
  'vendor/fonts/archivo-latin-ext.woff2',
  'vendor/fonts/jetbrains-mono-latin.woff2',
  'vendor/fonts/jetbrains-mono-latin-ext.woff2',
  'vendor/ort/ort.wasm.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/mediabunny/mediabunny.min.mjs',
];
const KNOWN = new Set(FILES.map((f) => new URL(f, self.registration.scope).href));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  url.search = '';
  url.hash = '';
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -10);
  if (e.request.method !== 'GET' || !KNOWN.has(url.href)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(e.request);
      if (fresh.ok) cache.put(url.href, fresh.clone());
      return fresh;
    } catch (err) {
      const kept = await cache.match(url.href);
      if (kept) return kept;
      throw err;
    }
  })());
});
