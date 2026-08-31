function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;

  const serviceWorkerUrl = new URL("../service-worker.js", import.meta.url);
  const scopeUrl = new URL("../", import.meta.url);
  const hadController = Boolean(navigator.serviceWorker.controller);
  if (hadController) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.dispatchEvent(new Event("epub-convert:pwa-update-ready"));
    }, { once: true });
  }
  navigator.serviceWorker.register(serviceWorkerUrl, {
    scope: scopeUrl.href,
    updateViaCache: "none",
  }).then((registration) => {
    registration.update().catch(() => {});
    const updateWhenVisible = () => {
      if (document.visibilityState === "visible") registration.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", updateWhenVisible);
  }).catch((error) => {
    console.error("[EPUB converter] Service worker registration failed", error);
  });
}

if (document.readyState === "complete") registerServiceWorker();
else window.addEventListener("load", registerServiceWorker, { once: true });
