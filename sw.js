// Service Worker for The Chord Book (adapted from House Index v1.9.2 sw.js)
// - Network-first page (4 s timeout) and app files (no timeout; saved copy only when offline)
// - Per-user Supabase REST cache that never caches anonymous reads and wipes on user switch/sign-out
// - Pre-caches self-hosted fonts and ES modules so the app works offline at a gig

const VERSION = "cb-v0.6.3";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const META_KEY = "https://chordbook.local/__meta/owner";
const SHELL_TIMEOUT_MS = 4000;
const DATA_TIMEOUT_MS = 4500;

const SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "manifest.json",
  "vendor/supabase-2.118.0.min.js",
  "js/boot-guard.js",
  "js/core.js",
  "js/device.js",
  "js/chords.js",
  "js/chordpro.js",
  "js/render.js",
  "js/fit.js",
  "js/melody.js",
  "js/revisions.js",
  "js/analytics.js",
  "js/ai.js",
  "js/send.js",
  "js/timing.js",
  "js/perform.js",
  "js/setlists.js",
  "js/song.js",
  "js/library.js",
  "fonts/fraunces-latin.woff2",
  "fonts/public-sans-latin.woff2",
  "fonts/ibm-plex-mono-latin.woff2",
  "fonts/ibm-plex-mono-500-latin.woff2"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // "reload" skips the browser's own HTTP cache, so this release's files are cached together.
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "WIPE_USER_CACHE") {
    event.waitUntil(caches.delete(DATA_CACHE));
  }
});

function userIdFromRequest(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64));
    if (json && json.role === "authenticated" && typeof json.sub === "string" && json.sub) {
      return json.sub;
    }
  } catch { /* ignore */ }
  return null;
}

let storeChain = Promise.resolve();
function queueStore(request, response, userId) {
  storeChain = storeChain.then(async () => {
    const cache = await caches.open(DATA_CACHE);
    const metaResp = await cache.match(META_KEY);
    const prevOwner = metaResp ? await metaResp.text() : null;
    if (prevOwner && prevOwner !== userId) {
      await caches.delete(DATA_CACHE);
    }
    const freshCache = await caches.open(DATA_CACHE);
    await freshCache.put(META_KEY, new Response(userId));
    await freshCache.put(request.url, response);
  }).catch(() => { });
  return storeChain;
}

function networkWithin(ms, promise) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (res) => { clearTimeout(t); resolve(res); },
      () => { clearTimeout(t); resolve(null); }
    );
  });
}

async function handleData(event) {
  const { request } = event;
  const userId = userIdFromRequest(request);
  const network = fetch(request).then((response) => {
    if (response.ok && userId) {
      event.waitUntil(queueStore(request, response.clone(), userId));
    }
    return response;
  });
  const fast = await networkWithin(DATA_TIMEOUT_MS, network);
  if (fast) return fast;
  if (!userId) return network;
  const cache = await caches.open(DATA_CACHE);
  const metaResp = await cache.match(META_KEY);
  const owner = metaResp ? await metaResp.text() : null;
  if (owner !== userId) return network;
  const cached = await cache.match(request.url);
  return cached || network;
}

// The page itself: network first, but after a few seconds use the saved copy so the app opens
// at a gig with no signal. App files (scripts, styles): wait for the network and use the saved
// copy only when offline. Mixing a slow network's files with saved ones from another release
// can break the app, so they never race.
async function handleShell(event) {
  const { request } = event;
  const isPage = request.mode === "navigate";
  const network = fetch(request, { cache: "no-cache" }).then((response) => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(request, copy)));
    }
    return response;
  });
  const cache = await caches.open(SHELL_CACHE);
  const saved = async () =>
    (await cache.match(request, { ignoreSearch: isPage })) ||
    (isPage ? await cache.match("index.html") : undefined);
  if (!isPage) {
    try {
      return await network;
    } catch {
      return (await saved()) || Response.error();
    }
  }
  const fast = await networkWithin(SHELL_TIMEOUT_MS, network);
  if (fast) return fast;
  return (await saved()) || network;
}

async function handleFont(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then((response) => {
    if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => { }));
    return cached;
  }
  return network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.includes("/rest/v1/")) {
    event.respondWith(handleData(event));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.includes("/fonts/")) {
    event.respondWith(handleFont(event));
    return;
  }
  if (url.origin === self.location.origin && !url.pathname.endsWith("/sw.js")) {
    event.respondWith(handleShell(event));
  }
});
