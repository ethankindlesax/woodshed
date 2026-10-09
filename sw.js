// Offline support. App files: newest from the network when online, saved copy when offline.
// Fonts: saved copy first (they never change).
const CACHE = 'woodshed-v3-5';
const FILES = ['./', 'index.html', 'style.css', 'config.js', 'app.js', 'sync.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.includes('.supabase.co')) return; // sync traffic always goes to the network
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  e.respondWith(sameOrigin ? networkFirst(req) : cacheFirst(req));
});
async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    // give a weak connection 4s, then fall back to the saved copy
    const r = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))
    ]);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    return (await c.match(req, { ignoreSearch: true })) || Response.error();
  }
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}
