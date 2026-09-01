const CACHE_PREFIX = "epub-convert";
const CACHE_VERSION = "v20";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./static/main.css",
  "./static/app.js",
  "./static/pwa.js",
  "./static/i18n.js",
  "./static/locales/zh-Hant.js",
  "./static/modes.js",
  "./static/opencc-config.js",
  "./static/custom-dictionaries.js",
  "./static/convert-worker.js",
  "./static/conversion-runtime.js",
  "./static/epub-converter.js",
  "./static/icons/app-icon.svg",
  "./vendor/vue/vue.global.prod.js",
  "./vendor/tocas/tocas.min.css",
  "./vendor/tocas/tocas.min.js",
  "./vendor/tocas/flags/4x3/tw.svg",
  "./vendor/tocas/flags/4x3/hk.svg",
  "./vendor/tocas/fonts/icons/fa-v4compatibility.woff2",
  "./vendor/tocas/fonts/icons/fa-solid-900.woff2",
  "./vendor/tocas/fonts/icons/fa-regular-400.woff2",
  "./vendor/tocas/fonts/icons/fa-brands-400.woff2",
  "./vendor/opencc-wasm/esm/index.js",
  "./vendor/opencc-wasm/esm/opencc-wasm.js",
  "./vendor/opencc-wasm/esm/opencc-wasm.wasm",
  "./vendor/opencc-wasm/data/config/s2twp.json",
  "./vendor/opencc-wasm/data/config/s2twp_jieba.json",
  "./vendor/opencc-wasm/data/dict/CJK_Compatibility_Ideographs.ocd2",
  "./vendor/opencc-wasm/data/dict/STPhrases.ocd2",
  "./vendor/opencc-wasm/data/dict/STPhrases_GeneratedFromRegionalPhrases.ocd2",
  "./vendor/opencc-wasm/data/dict/STCharacters.ocd2",
  "./vendor/opencc-wasm/data/dict/TWPhrases.ocd2",
  "./vendor/opencc-wasm/data/dict/TWVariantsPhrases.ocd2",
  "./vendor/opencc-wasm/data/dict/TWVariants.ocd2",
  "./vendor/opencc-wasm/data/jieba_dict/jieba_merged.ocd2",
  "./vendor/opencc-wasm/data/jieba_dict/hmm_model.utf8",
  "./vendor/zip.js/zip-core-external.min.js",
  "./vendor/zip.js/zip-web-worker.js",
  "./vendor/zip.js/zip-module.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const expectedCaches = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(`${CACHE_PREFIX}-`) && !expectedCaches.has(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function putIfCacheable(cacheName, request, response) {
  if (!(response.ok || response.type === "opaque")) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request, { ignoreSearch: true }))
      || (await caches.match("./index.html"))
      || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await putIfCacheable(RUNTIME_CACHE, request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then(async (response) => {
    await putIfCacheable(RUNTIME_CACHE, request, response.clone());
    return response;
  });
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    const basePath = new URL("./", self.location.href).pathname;
    const relativePath = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
    const immutableRuntime = relativePath.startsWith("vendor/");
    event.respondWith(immutableRuntime ? cacheFirst(request) : staleWhileRevalidate(request));
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
