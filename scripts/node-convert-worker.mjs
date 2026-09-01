import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { getConverter, serializeConversionError } from "../static/conversion-runtime.js";
import { convertEpub } from "../static/epub-converter.js";

if (!parentPort) throw new Error("The conversion worker must run in a worker thread.");

function samePath(first, second) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

function safeOutputPath(inputPath, outputDirectory, convertedFilename) {
  if (path.basename(convertedFilename) !== convertedFilename) {
    throw new Error(`Unsafe converted filename: ${convertedFilename}`);
  }
  let outputPath = path.join(outputDirectory, convertedFilename);
  if (samePath(inputPath, outputPath)) {
    const basename = convertedFilename.replace(/\.epub$/i, "");
    outputPath = path.join(outputDirectory, `${basename}-converted.epub`);
  }
  return outputPath;
}

parentPort.on("message", async (message) => {
  if (message?.type === "shutdown") {
    parentPort.close();
    return;
  }
  if (message?.type !== "convert") return;

  const { id, inputPath, outputDirectory, overwrite } = message;
  const startedAt = performance.now();
  let phase = "initializing";
  let lastProgressKey = null;

  try {
    const onProgress = (progress) => {
      phase = progress.phase;
      const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
      const progressKey = `${progress.phase}:${percent}`;
      if (progressKey === lastProgressKey) return;
      lastProgressKey = progressKey;
      parentPort.postMessage({
        type: "progress",
        id,
        phase: progress.phase,
        percent,
        messageKey: progress.messageKey,
        messageParameters: progress.messageParameters,
      });
    };
    const converter = await getConverter(workerData.config, workerData.customDictionary, onProgress);
    const bytes = await readFile(inputPath);
    const result = await convertEpub({
      bytes,
      filename: path.basename(inputPath),
      config: workerData.config,
      converter,
      onProgress,
    });
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = safeOutputPath(inputPath, outputDirectory, result.filename);
    await writeFile(outputPath, result.bytes, { flag: overwrite ? "w" : "wx" });
    parentPort.postMessage({
      type: "complete",
      id,
      inputPath,
      outputPath,
      elapsedMs: performance.now() - startedAt,
    });
  } catch (error) {
    parentPort.postMessage({
      type: "failed",
      id,
      inputPath,
      phase,
      error: serializeConversionError(error),
      elapsedMs: performance.now() - startedAt,
    });
  }
});
