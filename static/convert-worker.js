import { convertEpub } from "./epub-converter.js";
import { t } from "./i18n.js";

const converters = new Map();
let openCcModulePromise = null;

async function getConverter(config, onProgress) {
  if (!openCcModulePromise) {
    onProgress({
      phase: "initializing-opencc",
      percent: 0,
      label: t("worker.progress.loadingOpenCC"),
    });
    openCcModulePromise = import("../vendor/opencc-wasm/esm/index.js");
  }
  const { default: OpenCC } = await openCcModulePromise;

  if (!converters.has(config)) {
    onProgress({
      phase: "initializing-dictionary",
      percent: 0,
      label: t("worker.progress.loadingDictionary"),
    });
    const converter = OpenCC.Converter({ config });
    converters.set(config, converter);
    await converter("");
  }
  return converters.get(config);
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

  const { bytes, filename, config } = event.data;
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
    const converter = await getConverter(config, sendProgress);
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
