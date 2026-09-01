import { outputLanguage } from "./opencc-config.js";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  configure,
} from "../vendor/zip.js/zip-core-external.min.js";

const EPUB_MIMETYPE = "application/epub+zip";
const CONVERTIBLE_EXTENSIONS = new Set(["htm", "html", "xhtml", "ncx", "opf"]);
const OPENCC_CHUNK_BYTES = 16 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export function isAcceptedEpubMimetype(value) {
  return typeof value === "string"
    && value.trim().toLowerCase() === EPUB_MIMETYPE;
}

configure({
  useWebWorkers: false,
  useCompressionStream: false,
  workerURI: new URL("../vendor/zip.js/zip-web-worker.js", import.meta.url).href,
  wasmURI: new URL("../vendor/zip.js/zip-module.wasm", import.meta.url).href,
  maxWorkers: 1,
});

export class EpubConversionError extends Error {
  constructor(code, messageKey, entryName = null, cause = null, diagnostics = null, messageParameters = {}) {
    super(messageKey, cause ? { cause } : undefined);
    this.name = "EpubConversionError";
    this.code = code;
    this.messageKey = messageKey;
    this.messageParameters = messageParameters;
    this.entryName = entryName;
    this.diagnostics = diagnostics;
  }
}

function report(onProgress, phase, current, total, messageKey, messageParameters = {}) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  onProgress?.({ phase, current, total, percent, messageKey, messageParameters });
}

function extensionOf(filename) {
  const match = filename.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function isConvertibleFile(entry) {
  return !entry.directory && (
    CONVERTIBLE_EXTENSIONS.has(extensionOf(entry.filename)) ||
    entry.filename === "META-INF/container.xml"
  );
}

function assertSafeOutputPath(filename) {
  const parts = filename.split("/");
  if (
    !filename ||
    filename.startsWith("/") ||
    filename.includes("\\") ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new EpubConversionError("unsafe-path", "epub.error.unsafePath", filename, null, null, { filename });
  }
}

function decodeUtf8(bytes, entryName) {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: utf8Decoder.decode(bytes), hasBom };
  } catch (error) {
    throw new EpubConversionError("invalid-encoding", "epub.error.invalidUtf8", entryName, error, null, { entryName });
  }
}

function encodeUtf8(text, withBom) {
  const encoded = utf8Encoder.encode(text);
  if (!withBom) return encoded;
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

function largestUtf8SliceEnd(text, start, maxBytes) {
  let low = start + 1;
  let high = Math.min(text.length, start + maxBytes);
  let best = start;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const byteLength = utf8Encoder.encode(text.slice(start, middle)).byteLength;
    if (byteLength <= maxBytes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best > start && /[\uD800-\uDBFF]/.test(text[best - 1]) && /[\uDC00-\uDFFF]/.test(text[best])) {
    best -= 1;
  }
  return best;
}

function preferredChunkEnd(text, start, maximumEnd) {
  const minimumEnd = start + Math.floor((maximumEnd - start) * 0.75);
  for (let index = maximumEnd; index > minimumEnd; index -= 1) {
    if (/[\s>！？!?；;，,]/u.test(text[index - 1])) return index;
  }
  return maximumEnd;
}

function splitOpenCcInput(text) {
  if (utf8Encoder.encode(text).byteLength <= OPENCC_CHUNK_BYTES) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const maximumEnd = largestUtf8SliceEnd(text, start, OPENCC_CHUNK_BYTES);
    if (maximumEnd <= start) {
      throw new EpubConversionError("opencc-split", "epub.error.splitOpenCC");
    }
    const end = preferredChunkEnd(text, start, maximumEnd);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function convertOpenCcText(converter, text, entryName, kind = "content") {
  const chunks = kind === "content" ? splitOpenCcInput(text) : [text];
  const output = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      output.push(await converter(chunk));
    } catch (error) {
      const diagnostics = {
        kind,
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        chunkCharacters: chunk.length,
        chunkBytes: utf8Encoder.encode(chunk).byteLength,
        inputCharacters: text.length,
        inputBytes: utf8Encoder.encode(text).byteLength,
      };
      console.error("[EPUB converter] OpenCC call failed", {
        error,
        entryName,
        diagnostics,
      });
      throw new EpubConversionError(
        "opencc-conversion",
        "epub.error.openCC",
        entryName,
        error,
        diagnostics,
        { entryName },
      );
    }
  }

  return output.join("");
}

function updatePackageLanguage(content, config) {
  const language = outputLanguage(config);
  if (!language) return content;

  const convertibleLanguage = /^(?:zh|cmn)(?:[-_](?:hans|hant|cn|tw|hk|mo|sg))?$|^ja(?:[-_][a-z0-9]+)?$/i;
  return content.replace(
    /(<dc:language\b[^>]*>)([\s\S]*?)(<\/dc:language\s*>)/gi,
    (match, opening, value, closing) =>
      convertibleLanguage.test(value.trim()) ? `${opening}${language}${closing}` : match,
  );
}

function validateContainerXml(content, entryNames) {
  const rootfiles = [...content.matchAll(/\bfull-path\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  if (!rootfiles.length || !rootfiles.some((path) => entryNames.has(path))) {
    throw new EpubConversionError("invalid-epub", "epub.error.invalidContainer", "META-INF/container.xml");
  }
}

function metadataOptions(entry) {
  return {
    lastModDate: entry.lastModDate,
    lastAccessDate: entry.lastAccessDate,
    creationDate: entry.creationDate,
    comment: entry.comment || undefined,
    internalFileAttributes: entry.internalFileAttributes,
    externalFileAttributes: entry.externalFileAttributes,
  };
}

async function readEntryBytes(entry) {
  try {
    return await entry.getData(new Uint8ArrayWriter(), {
      checkCrc32: true,
      checkOverlappingEntry: true,
      useWebWorkers: false,
      useCompressionStream: false,
    });
  } catch (error) {
    throw new EpubConversionError("archive-entry", "epub.error.readEntry", entry.filename, error, null, { filename: entry.filename });
  }
}

export async function convertEpub({ bytes, filename, config, converter, onProgress }) {
  if (!(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array)) {
    const error = new TypeError("epub.error.invalidBytes");
    error.code = "invalid-bytes";
    error.messageKey = "epub.error.invalidBytes";
    error.messageParameters = {};
    throw error;
  }
  if (!/\.epub$/i.test(filename)) {
    throw new EpubConversionError("not-epub", "epub.error.notEpub");
  }

  report(onProgress, "reading", 0, 1, "epub.progress.validating");
  const zipReader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), {
    strictness: "strict",
    checkCrc32: true,
    checkOverlappingEntry: true,
    useWebWorkers: false,
    useCompressionStream: false,
  });

  let entries;
  try {
    entries = await zipReader.getEntries();
  } catch (error) {
    await zipReader.close().catch(() => { });
    throw new EpubConversionError("invalid-archive", "epub.error.invalidArchive", null, error);
  }

  try {
    const entryNames = new Set(entries.map((entry) => entry.filename));
    const mimetypeEntry = entries.find((entry) => entry.filename === "mimetype" && !entry.directory);
    const containerEntry = entries.find((entry) => entry.filename === "META-INF/container.xml" && !entry.directory);

    if (!mimetypeEntry || !containerEntry) {
      throw new EpubConversionError("invalid-epub", "epub.error.missingStructure");
    }
    if (entries.some((entry) => entry.encrypted)) {
      throw new EpubConversionError("encrypted", "epub.error.encrypted");
    }
    if (entries.some((entry) => entry.symlink)) {
      throw new EpubConversionError("unsafe-path", "epub.error.symlink");
    }

    const mimetypeBytes = await readEntryBytes(mimetypeEntry);
    const { text: mimetype } = decodeUtf8(mimetypeBytes, "mimetype");
    if (!isAcceptedEpubMimetype(mimetype)) {
      throw new EpubConversionError("invalid-epub", "epub.error.invalidArchive", "mimetype");
    }

    const containerBytes = await readEntryBytes(containerEntry);
    const { text: containerXml } = decodeUtf8(containerBytes, "META-INF/container.xml");
    validateContainerXml(containerXml, entryNames);

    const outputEntries = [];
    const outputNames = new Set();
    const workEntries = entries.filter((entry) => entry.filename !== "mimetype");
    const conversionTotal = workEntries.filter(isConvertibleFile).length;
    let conversionCurrent = 0;

    for (const entry of workEntries) {
      const convertible = isConvertibleFile(entry);

      const convertedName = await convertOpenCcText(converter, entry.filename, entry.filename, "path");
      assertSafeOutputPath(convertedName);
      if (outputNames.has(convertedName) || convertedName === "mimetype") {
        throw new EpubConversionError("path-collision", "epub.error.pathCollision", convertedName, null, null, { filename: convertedName });
      }
      outputNames.add(convertedName);

      if (entry.directory) {
        outputEntries.push({ entry, filename: convertedName, bytes: null });
        continue;
      }

      let entryBytes = await readEntryBytes(entry);
      if (convertible) {
        report(onProgress, "converting", conversionCurrent, conversionTotal, "epub.progress.processing", { filename: entry.filename });
        const decoded = decodeUtf8(entryBytes, entry.filename);
        let convertedText = await convertOpenCcText(converter, decoded.text, entry.filename);
        if (extensionOf(entry.filename) === "opf") {
          convertedText = updatePackageLanguage(convertedText, config);
        }
        entryBytes = encodeUtf8(convertedText, decoded.hasBom);
        conversionCurrent += 1;
      }
      outputEntries.push({ entry, filename: convertedName, bytes: entryBytes });
    }

    report(onProgress, "building", 0, 1, "epub.progress.building");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter(), {
      level: 6,
      useWebWorkers: false,
      useCompressionStream: false,
    });

    await zipWriter.add("mimetype", new TextReader(EPUB_MIMETYPE), {
      level: 0,
      lastModDate: mimetypeEntry.lastModDate,
      internalFileAttributes: mimetypeEntry.internalFileAttributes,
      externalFileAttributes: mimetypeEntry.externalFileAttributes,
    });

    for (let index = 0; index < outputEntries.length; index += 1) {
      const outputEntry = outputEntries[index];
      const options = {
        ...metadataOptions(outputEntry.entry),
        directory: outputEntry.entry.directory,
        level: outputEntry.entry.directory ? 0 : 6,
      };
      const reader = outputEntry.entry.directory ? undefined : new Uint8ArrayReader(outputEntry.bytes);
      await zipWriter.add(outputEntry.filename, reader, options);
      report(onProgress, "compressing", index + 1, outputEntries.length, "epub.progress.compressing", { filename: outputEntry.filename });
    }

    const outputBytes = await zipWriter.close();
    const baseName = filename.replace(/\.epub$/i, "");
    const convertedBaseName = (
      await convertOpenCcText(converter, baseName, filename, "filename")
    ).trim() || baseName;
    report(onProgress, "complete", 1, 1, "epub.progress.complete");
    return { bytes: outputBytes, filename: `${convertedBaseName}.epub` };
  } finally {
    await zipReader.close().catch(() => { });
  }
}
