import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
const html = readFileSync("index.html", "utf8");
const app = readFileSync("static/app.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");

test("web app manifest describes an installable scoped application", () => {
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name);
  assert.ok(manifest.short_name);
  assert.ok(manifest.icons.length);
  for (const icon of manifest.icons) assert.ok(existsSync(icon.src), icon.src);
  const icon = readFileSync(manifest.icons[0].src, "utf8");
  assert.doesNotMatch(icon, /<(?:text|font|font-face)\b/i);
  assert.ok((icon.match(/<path\b/g) || []).length >= 5);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color"/);
});

test("application registers the root service worker", () => {
  assert.match(app, /import "\.\/pwa\.js";/);
  const registration = readFileSync("static/pwa.js", "utf8");
  assert.match(registration, /navigator\.serviceWorker\.register/);
  assert.match(registration, /\.\.\/service-worker\.js/);
  assert.match(registration, /updateViaCache: "none"/);
  assert.match(registration, /registration\.update\(\)/);
  assert.match(registration, /controllerchange/);
  assert.match(registration, /epub-convert:pwa-update-ready/);
  assert.match(app, /epub-convert:pwa-update-ready/);
  assert.match(app, /app\.pwa\.updateReady/);
});

test("service worker precaches local conversion runtimes", () => {
  const appShellSource = serviceWorker.slice(
    serviceWorker.indexOf("const APP_SHELL = ["),
    serviceWorker.indexOf("];", serviceWorker.indexOf("const APP_SHELL = [")),
  );
  const assets = [...appShellSource.matchAll(/"(\.\/[^"\n]+)"/g)]
    .map((match) => match[1]);
  for (const asset of assets) {
    if (asset === "./") continue;
    assert.ok(existsSync(asset.slice(2)), asset);
  }
  assert.ok(assets.includes("./static/convert-worker.js"));
  assert.ok(assets.includes("./static/opencc-config.js"));
  assert.ok(assets.includes("./vendor/opencc-wasm/esm/opencc-wasm.wasm"));
  assert.ok(assets.includes("./vendor/zip.js/zip-module.wasm"));

  for (const configName of ["s2twp", "s2twp_jieba"]) {
    const configAsset = `./vendor/opencc-wasm/data/config/${configName}.json`;
    assert.ok(assets.includes(configAsset), configAsset);
    const config = JSON.parse(readFileSync(configAsset.slice(2), "utf8"));
    const dependencies = new Set();
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "file") dependencies.add(`./vendor/opencc-wasm/data/dict/${child}`);
        else if (key.endsWith("_path")) dependencies.add(`./vendor/opencc-wasm/data/${child}`);
        else visit(child);
      }
    };
    visit(config);
    for (const dependency of dependencies) {
      assert.ok(existsSync(dependency.slice(2)), dependency);
      assert.ok(assets.includes(dependency), `${configName} dependency: ${dependency}`);
    }
  }

  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /request\.method !== "GET"/);
  assert.match(serviceWorker, /relativePath\.startsWith\("vendor\/"\)/);
  assert.match(serviceWorker, /await self\.skipWaiting\(\)/);
  assert.match(serviceWorker, /await self\.clients\.claim\(\)/);
});
