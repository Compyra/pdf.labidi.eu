/* PDF Studio — service worker for offline / installable use.

   DEPLOY: bump V here and the matching ?v= in index.html, together.

   Own assets are versioned (?v=) so a deploy swaps atomically even behind
   Cloudflare/GitHub Pages edge caches. Vendored library files are pinned
   snapshots that never change in place, so they are cached unversioned.
   The shell is fetched NETWORK FIRST — a cache-first shell is what strands
   returning visitors on a frozen build. Everything else is cache-first,
   which is what makes the whole toolbox work with no network at all
   (the OCR engine + language packs enter the cache on first OCR run). */
const V = '3';
const CACHE = 'pdf-studio-v' + V;
const SHELL = './index.html';
const ASSETS = [
    './',
    SHELL,
    './style.css?v=' + V,
    './i18n.js?v=' + V,
    './app.js?v=' + V,
    './tools.js?v=' + V,
    './manifest.webmanifest',
    './icon.svg',
    './vendor/pdf-lib.min.js',
    './vendor/pdfjs/pdf.min.js',
    './vendor/pdfjs/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
    // addAll is atomic: if any file 404s mid-deploy the install fails and the
    // old worker stays, rather than a broken set being frozen into the cache.
    e.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (err) { return; }
    if (url.origin !== self.location.origin) return;
    // blob:/data: requests (the print preview) must never be touched
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    if (req.mode === 'navigate') {
        e.respondWith(
            fetch(req).then((resp) => {
                if (resp && resp.ok && resp.type === 'basic') {
                    const copy = resp.clone();
                    caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => { });
                }
                return resp;
            }).catch(() => caches.match(SHELL).then((c) => c || caches.match('./')))
        );
        return;
    }

    e.respondWith(
        caches.match(req).then((cached) =>
            cached || fetch(req).then((resp) => {
                if (resp && resp.ok && resp.type === 'basic') {
                    const copy = resp.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => { });
                }
                return resp;
            }).catch(() => Response.error())
        )
    );
});
