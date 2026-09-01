const baseConverters = new Map();
const customConverters = new Map();
let openCcModulePromise = null;

export async function getConverter(config, customDictionary, onProgress = () => {}) {
  if (!openCcModulePromise) {
    onProgress({
      phase: "initializing-opencc",
      percent: 0,
      messageKey: "worker.progress.loadingOpenCC",
      messageParameters: {},
    });
    openCcModulePromise = import("../vendor/opencc-wasm/esm/index.js");
  }
  const { default: OpenCC } = await openCcModulePromise;

  if (!baseConverters.has(config)) {
    onProgress({
      phase: "initializing-dictionary",
      percent: 0,
      messageKey: "worker.progress.loadingDictionary",
      messageParameters: {},
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
      messageKey: "worker.progress.loadingCustomDictionary",
      messageParameters: {},
    });
    const customConverter = OpenCC.CustomConverter(customDictionary.entries);
    if (customConverters.size >= 20) customConverters.clear();
    customConverters.set(key, async (text) => baseConverter(await customConverter(text)));
  }
  return customConverters.get(key);
}

export function serializeConversionError(error, fallbackMessage = "Conversion failed") {
  return {
    code: error?.code || "conversion-failed",
    name: error?.name || "Error",
    message: error?.message || fallbackMessage,
    messageKey: error?.messageKey || null,
    messageParameters: error?.messageParameters || {},
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
