let conversionModulesPromise = null;

function loadConversionModules() {
  if (!conversionModulesPromise) {
    conversionModulesPromise = Promise.all([
      import("./epub-converter.js"),
      import("./conversion-runtime.js"),
    ]).then(([epubConverter, conversionRuntime]) => ({
      convertEpub: epubConverter.convertEpub,
      getConverter: conversionRuntime.getConverter,
      serializeConversionError: conversionRuntime.serializeConversionError,
    }));
  }
  return conversionModulesPromise;
}

function serializeStartupError(error) {
  return {
    code: error?.code || "conversion-failed",
    name: error?.name || "Error",
    message: error?.message || "Conversion failed",
    messageKey: error?.messageKey || null,
    messageParameters: error?.messageParameters || {},
    stack: error?.stack || null,
    entryName: error?.entryName || null,
    diagnostics: error?.diagnostics || null,
    detail: error?.cause?.message || null,
    cause: null,
  };
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;

  const { bytes, filename, config, customDictionary } = event.data;
  let progressContext = {
    phase: "initializing",
    percent: 0,
    messageKey: "worker.progress.loadingOpenCC",
    messageParameters: {},
  };
  let serializeConversionError = serializeStartupError;

  try {
    const sendProgress = (progress) => {
      progressContext = progress;
      self.postMessage({ type: "progress", ...progress });
    };
    sendProgress(progressContext);
    const modules = await loadConversionModules();
    const { convertEpub, getConverter } = modules;
    serializeConversionError = modules.serializeConversionError;
    const converter = await getConverter(
      config,
      customDictionary,
      () => import("../vendor/opencc-wasm/esm/index.js"),
      sendProgress,
    );
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
      ...serializeConversionError(error),
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
