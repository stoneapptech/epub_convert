import * as os from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { resolveConfig } from "../static/opencc-config.js";
import {
  MAX_CUSTOM_DICTIONARY_ENTRIES,
  parseCustomDictionary,
  parseDictionaryLibrary,
} from "../static/custom-dictionaries.js";
import { CliProgress } from "./cli-progress.mjs";

const workerUrl = new URL("./node-convert-worker.mjs", import.meta.url);
const MAX_JOBS = 64;

export const HELP = `Usage: npm run convert -- [options] <file-or-directory...>

Convert EPUB files with OpenCC and process multiple books in parallel.

Options:
  -m, --mode <mode>       OpenCC mode (default: s2tw)
      --jieba             Use the Jieba variant when supported by the mode
  -j, --jobs <count>      Parallel workers (automatic: up to 4; maximum: ${MAX_JOBS})
  -o, --output-dir <dir>  Put all converted books in this directory
  -d, --dictionary <file> Apply a text dictionary or browser-exported JSON library
                          Repeat to merge multiple dictionary files
      --overwrite         Replace an existing converted output file
  -h, --help              Show this help

Directories include their immediate .epub files. Existing outputs are never
overwritten unless --overwrite is specified. Options can appear before, after,
or between input paths. Use -- before a filename beginning with a dash.`;

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(args) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        mode: { type: "string", short: "m", default: "s2tw" },
        jieba: { type: "boolean", default: false },
        jobs: { type: "string", short: "j" },
        "output-dir": { type: "string", short: "o" },
        output: { type: "string" },
        dictionary: { type: "string", short: "d", multiple: true, default: [] },
        overwrite: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new CliUsageError(error.message);
  }

  if (parsed.values.output !== undefined && parsed.values["output-dir"] !== undefined) {
    throw new CliUsageError("Use only one of --output or --output-dir.");
  }
  const jobs = parsed.values.jobs === undefined ? null : Number(parsed.values.jobs);
  const options = {
    mode: parsed.values.mode,
    jieba: parsed.values.jieba,
    jobs,
    outputDirectory: parsed.values["output-dir"] ?? parsed.values.output ?? null,
    dictionaryFiles: parsed.values.dictionary,
    overwrite: parsed.values.overwrite,
    help: parsed.values.help,
    inputs: parsed.positionals,
  };

  if (options.jobs !== null
      && (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > MAX_JOBS)) {
    throw new CliUsageError(`--jobs must be an integer from 1 to ${MAX_JOBS}.`);
  }
  return options;
}

export async function loadCustomDictionaryFiles(filenames) {
  if (!filenames.length) return null;
  const entries = [];
  const sources = new Set();

  for (const filename of filenames) {
    const absolutePath = path.resolve(filename);
    let text;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read custom dictionary ${absolutePath}: ${error.message}`, { cause: error });
    }

    try {
      const fileEntries = /\.json$/i.test(absolutePath)
        ? parseDictionaryLibrary(text.replace(/^\uFEFF/, ""))
          .flatMap((dictionary) => parseCustomDictionary(dictionary.text))
        : parseCustomDictionary(text);
      if (!fileEntries.length) throw new Error("dictionary is empty");
      for (const [source, target] of fileEntries) {
        if (sources.has(source)) throw new Error(`duplicate source: ${source}`);
        sources.add(source);
        entries.push([source, target]);
        if (entries.length > MAX_CUSTOM_DICTIONARY_ENTRIES) {
          throw new Error(`combined dictionaries exceed ${MAX_CUSTOM_DICTIONARY_ENTRIES} entries`);
        }
      }
    } catch (error) {
      const line = error?.line ? ` at line ${error.line}` : "";
      throw new Error(
        `Invalid custom dictionary ${absolutePath}${line}: ${error.code || error.message}`,
        { cause: error },
      );
    }
  }

  return {
    id: `cli:${filenames.map((filename) => path.resolve(filename)).join("|")}`,
    entries,
  };
}

export function defaultJobCount(
  fileCount,
  cpuCount = os.availableParallelism?.() || os.cpus().length,
) {
  return Math.max(1, Math.min(4, fileCount, Math.max(1, cpuCount - 1)));
}

async function expandInputs(inputs) {
  const files = [];
  const failures = [];
  const seen = new Set();

  const addFile = (inputPath) => {
    const absolutePath = path.resolve(inputPath);
    const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(key)) return;
    seen.add(key);
    if (/\.epub$/i.test(absolutePath)) files.push(absolutePath);
    else failures.push({ inputPath: absolutePath, message: "Not an .epub file" });
  };

  for (const input of inputs) {
    const absolutePath = path.resolve(input);
    try {
      const inputStat = await stat(absolutePath);
      if (inputStat.isFile()) addFile(absolutePath);
      else if (inputStat.isDirectory()) {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        for (const entry of entries
          .filter((item) => item.isFile() && /\.epub$/i.test(item.name))
          .sort((first, second) => first.name.localeCompare(second.name))) {
          addFile(path.join(absolutePath, entry.name));
        }
      } else failures.push({ inputPath: absolutePath, message: "Unsupported input type" });
    } catch (error) {
      failures.push({ inputPath: absolutePath, message: error.message });
    }
  }
  return { files, failures };
}

export async function runConversionPool({
  files,
  config,
  jobs,
  outputDirectory,
  overwrite,
  customDictionary = null,
  onProgress,
}) {
  const results = new Array(files.length);
  const workers = new Set();
  let nextIndex = 0;

  async function runWorkerSlot(slot) {
    const worker = new Worker(workerUrl, { workerData: { config, customDictionary } });
    workers.add(worker);
    let activeIndex = null;
    let shuttingDown = false;

    await new Promise((resolve, reject) => {
      const dispatch = () => {
        if (nextIndex >= files.length) {
          shuttingDown = true;
          worker.postMessage({ type: "shutdown" });
          return;
        }
        activeIndex = nextIndex;
        nextIndex += 1;
        const inputPath = files[activeIndex];
        onProgress?.({
          type: "started",
          id: activeIndex,
          slot,
          total: files.length,
        });
        worker.postMessage({
          type: "convert",
          id: activeIndex,
          inputPath,
          outputDirectory: outputDirectory || path.dirname(inputPath),
          overwrite,
        });
      };

      worker.on("message", (message) => {
        if (message?.type === "progress") {
          onProgress?.({ ...message, slot, total: files.length });
          return;
        }
        if (message?.type !== "complete" && message?.type !== "failed") return;
        results[message.id] = message;
        onProgress?.({ ...message, slot, total: files.length });
        activeIndex = null;
        dispatch();
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        workers.delete(worker);
        if (shuttingDown && code === 0) resolve();
        else reject(new Error(
          `Conversion worker ${slot} exited with code ${code}`
            + (activeIndex === null ? "" : ` while processing ${files[activeIndex]}`),
        ));
      });
      dispatch();
    });
  }

  try {
    await Promise.all(Array.from({ length: jobs }, (_, index) => runWorkerSlot(index + 1)));
  } finally {
    await Promise.allSettled([...workers].map((worker) => worker.terminate()));
  }
  return results;
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    if (!options.inputs.length) throw new CliUsageError("At least one EPUB file or directory is required.");
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    console.error(`Error: ${error.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = resolveConfig(options.mode, options.jieba);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let customDictionary;
  try {
    customDictionary = await loadCustomDictionaryFiles(options.dictionaryFiles);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const { files, failures: preflightFailures } = await expandInputs(options.inputs);
  const outputDirectory = options.outputDirectory ? path.resolve(options.outputDirectory) : null;
  if (!files.length) {
    for (const failure of preflightFailures) {
      console.error(`Failed: ${failure.inputPath}: ${failure.message}`);
    }
    if (!preflightFailures.length) console.error("No EPUB files were found.");
    process.exitCode = 1;
    return;
  }

  const jobs = Math.min(options.jobs || defaultJobCount(files.length), files.length);
  const dictionarySummary = customDictionary
    ? `, ${customDictionary.entries.length} custom dictionary entries`
    : "";
  console.log(`Converting ${files.length} EPUB file(s) with ${jobs} worker(s), mode ${config}${dictionarySummary}.`);
  const progress = CliProgress.create(files, jobs);
  progress.start();
  let results;
  try {
    results = await runConversionPool({
      files,
      config,
      jobs,
      outputDirectory,
      overwrite: options.overwrite,
      customDictionary,
      onProgress: (message) => progress.update(message),
    });
  } finally {
    progress.finish();
  }

  for (const failure of preflightFailures) {
    console.error(`Failed: ${failure.inputPath}: ${failure.message}`);
  }
  const succeeded = results.filter((result) => result?.type === "complete").length;
  const failed = results.length - succeeded + preflightFailures.length;
  console.log(`Finished: ${succeeded} succeeded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

const isCommandLine = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCommandLine) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.stack || error.message}`);
    process.exitCode = 2;
  });
}
