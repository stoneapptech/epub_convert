import { convertEpub } from "./epub-converter.js";
import { t } from "./i18n.js";

const baseConverters = new Map();
const customConverters = new Map();
let openCcModulePromise = null;

async function getConverter(config, customDictionary, onProgress) {
  if (!openCcModulePromise) {
    onProgress({
      phase: "initializing-opencc",
      percent: 0,
      label: t("worker.progress.loadingOpenCC"),
    });
    openCcModulePromise = import("../vendor/opencc-wasm/esm/index.js");
  }
  const { default: OpenCC } = await openCcModulePromise;

  if (!baseConverters.has(config)) {
    onProgress({
      phase: "initializing-dictionary",
      percent: 0,
      label: t("worker.progress.loadingDictionary"),
    });
    const converter = OpenCC.Converter({ config });
    baseConverters.set(config, converter);
    await converter("");
  }
  const baseConverter = baseConverters.get(config);
  if (!customDictionary?.entries?.length) return baseConverter;

  const key = `${config}:${customDictionary.id}`;
  if (!customConverters.has(key)) {
    onProgress({
      phase: "initializing-custom-dictionary",
      percent: 0,
      label: t("worker.progress.loadingCustomDictionary"),
    });
    const customConverter = OpenCC.CustomConverter(customDictionary.entries);
    if (customConverters.size >= 20) customConverters.clear();
    customConverters.set(key, async (text) => customConverter(await baseConverter(text)));
  }
  return customConverters.get(key);
}

function serializeError(error) {
  return {
    code: error?.code || "conversion-failed",
    name: error?.name || "Error",
    message: error?.message || t("worker.error.failed"),
    stack: error?.stack || null,
    entryName: error?.entryName || null,
    diagnostics: error?.diagnostics || null,
    detail: error?.cause?.message || null,
    cause: error?.cause
      ? {
        name: error.cause.name || "Error",
        message: error.cause.message || String(error.cause),
        stack: error.cause.stack || null,
      }
      : null,
  };
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;

  const { bytes, filename, config, customDictionary } = event.data;
  let progressContext = {
    phase: "initializing",
    percent: 0,
    label: t("worker.progress.loadingOpenCC"),
  };

  try {
    const sendProgress = (progress) => {
      progressContext = progress;
      self.postMessage({ type: "progress", ...progress });
    };
    const converter = await getConverter(config, customDictionary, sendProgress);
    const result = await convertEpub({
      bytes,
      filename,
      config,
      converter,
      onProgress: sendProgress,
    });
    const outputBuffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    );
    self.postMessage(
      { type: "complete", bytes: outputBuffer, filename: result.filename },
      [outputBuffer],
    );
  } catch (error) {
    const serializedError = {
      ...serializeError(error),
      phase: progressContext.phase,
      filename,
      config,
    };
    console.error("[EPUB converter worker] Conversion failed", {
      error,
      context: serializedError,
    });
    self.postMessage({ type: "error", error: serializedError });
  }
});
