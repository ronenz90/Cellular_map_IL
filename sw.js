/**
 * sw.js - מאפשר שימוש באפליקציה גם ללא אינטרנט:
 *  - App Shell (html/css/js/icons): cache-first, מתעדכן ברקע
 *  - נתוני אנטנות (data/*.json): network-first עם נפילה לקאש (כדי לתפוס עדכונים אבל לעבוד גם אופליין)
 *  - אריחי מפה (OSM / Esri / Carto): stale-while-revalidate - כל אריח שנצפה פעם נשמר,
 *    כך שאזור שכבר גלשת בו יעבוד גם בלי רשת.
 */

const SHELL_CACHE = 'antenna-shell-v1';
const DATA_CACHE = 'antenna-data-v1';
const TILE_CACHE = 'antenna-tiles-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/data-loader.js',
  './js/reports.js',
  './js/history.js',
  './js/saved-addresses.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => ![SHELL_CACHE, DATA_CACHE, TILE_CACHE].includes(k))
          .map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // אריחי מפה - stale-while-revalidate
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then((resp) => {
          if (resp.ok) cache.put(event.request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // נתוני אנטנות - network-first, נפילה לקאש אם אין רשת
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json') || url.pathname.endsWith('.geojson')) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        const clone = resp.clone();
        caches.open(DATA_CACHE).then((cache) => cache.put(event.request, clone));
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // שאר קבצי האפליקציה (App Shell) - cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
