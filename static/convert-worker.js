import { convertEpub } from "./epub-converter.js";
import { getConverter, serializeConversionError } from "./conversion-runtime.js";

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;

  const { bytes, filename, config, customDictionary } = event.data;
  let progressContext = {
    phase: "initializing",
    percent: 0,
    messageKey: "worker.progress.loadingOpenCC",
    messageParameters: {},
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
