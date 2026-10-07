/* FGC 2026 — service worker.
   À chaque déploiement de l'interface : incrémenter VERSION ici ET le « ?v= » des
   liens css/app.css et js/app.js dans index.html (vérifié par tools/check-static.mjs). */
"use strict";
const VERSION = "fgc2026-v8";
const BUILD = VERSION.slice(VERSION.lastIndexOf("v") + 1);
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const DATA = `${VERSION}-data`;

const PRECACHE = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/config.js",
  "js/data.js",
  "js/i18n.js",
  "js/pwa.js",
  "js/teams.js",
  "manifest.webmanifest",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME, DATA]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** Réseau d'abord (avec délai), cache ensuite. */
async function networkFirst(request, cacheName, timeoutMs, cacheKey = request) {
  const cache = await caches.open(cacheName);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(request, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok && res.type === "basic") await cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

/** Cache d'abord, mise à jour en arrière-plan. */
async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const update = fetch(event.request).then(res => {
    if (res.ok) cache.put(event.request, res.clone());
    return res;
  }).catch(() => hit || Response.error());
  if (hit) { event.waitUntil(update); return hit; }
  return update;
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") {
      event.respondWith(networkFirst(req, SHELL, 4000, "index.html").catch(() => caches.match("index.html")));
      return;
    }
    if (url.pathname.endsWith("/data.json")) {
      event.respondWith(networkFirst(req, DATA, 6000, "data.json"));
      return;
    }
    /* Fichier d'une autre version (?v= différent de BUILD) : réseau d'abord, pour ne
       jamais associer une page récente à une feuille de style ou un script périmés. */
    const v = url.searchParams.get("v");
    if (v && v !== BUILD) {
      event.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || Response.error())));
      return;
    }
    event.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
    return;
  }
  if (FONT_HOSTS.has(url.hostname)) event.respondWith(staleWhileRevalidate(event, RUNTIME));
  /* Tout le reste (YouTube…) passe directement par le réseau. */
});
