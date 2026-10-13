'use strict';

/*
 * matcha/public/sw.js — the service worker. Cache the site, spare the wifi.
 * ---------------------------------------------------------------------------
 * Strategy:
 *   - Static assets (/assets/, /scramjet/) : cache-first, they basically never change
 *   - Navigations (/, /index.html)         : network-first, fall back to cache
 *   - /api/proxy/*                         : NEVER cached. Game files are megabytes
 *                                            each; caching them is how you fill a
 *                                            user's disk and get blamed for it.
 *
 * Update ritual: bump VERSION below whenever you touch any asset. Users stuck
 * on an old cache otherwise need to close every tab, which is a support ticket
 * you will not enjoy reading.
 *
 * ---------------------------------------------------------------------------
 * OPTIONAL: SCramjet IS SHIPPED BUT DORMANT
 * ---------------------------------------------------------------------------
 * The real Scramjet dist files live at /scramjet/ (scramjet.all.js,
 * scramjet.sync.js, scramjet.wasm.wasm — courtesy of MercuryWorkshop).
 * They're not wired in by default because Scramjet needs a *wisp* websocket
 * server to actually proxy anything, and pretending otherwise would break this
 * perfectly working site in a very exciting way.
 *
 * When you DO have a wisp server (e.g. wss://your-wisp-host/wisp), the wiring
 * looks like this — per the official MercuryWorkshop quickstart:
 *
 *   importScripts('/scramjet/scramjet.all.js');
 *   const { ScramjetServiceWorker } = $scramjetLoadWorker();
 *   const scramjet = new ScramjetServiceWorker();
 *   self.addEventListener('fetch', (event) => {
 *     event.respondWith(scramjet.fetch(event));
 *   });
 *
 * Until then, these files sit here like a gym membership: paid for, unused,
 * quietly judging everyone.
 */

const VERSION = 'matcha-v1'; // ← bump me. I am the only thing standing between you and stale CSS.
const STATIC_CACHE = `static-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/404.html',
  '/assets/style.css',
  '/assets/app.js',
  '/assets/games.js',
  '/assets/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // allSettled, not all: cache.addAll fails wholesale if ANY file 404s, and
      // we are not letting one missing favicon nuke the entire install.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      await self.skipWaiting(); // stop asking old tabs to politely refresh
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Delete caches from previous VERSIONs. Future you, grateful you, etc.
      await Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET. POST/PUT/etc to our proxy must hit the network like adults.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only. Caching cross-origin stuff (CDN games, covers) is a
  // one-way ticket to "user reports disk full, blames your site".
  if (url.origin !== self.location.origin) return;

  // Never touch the proxy: it streams other people's games, and they're big.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached; // it's static, it's fine, it's cached

  const response = await fetch(request);
  // Cache successful responses only. Caching a 500 is how you serve errors
  // offline for a week.
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline (or the server exploded). Serve the cached shell.
    const cached =
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      (await caches.match('/404.html'));
    // If even the 404 page isn't cached, there's nothing left to say.
    return cached || new Response('Offline and uncached. A bold combination.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
