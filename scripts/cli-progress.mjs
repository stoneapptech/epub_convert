import path from "node:path";
import stringWidth from "string-width";

const RENDER_INTERVAL_MS = 80;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MESSAGES = Object.freeze({
  "worker.progress.loadingOpenCC": () => "Loading OpenCC",
  "worker.progress.loadingDictionary": () => "Loading dictionary",
  "worker.progress.loadingCustomDictionary": () => "Loading custom dictionary",
  "epub.progress.validating": () => "Validating EPUB",
  "epub.progress.processing": ({ filename } = {}) => `Converting ${filename || "file"}`,
  "epub.progress.building": () => "Building EPUB",
  "epub.progress.compressing": ({ filename } = {}) => `Compressing ${filename || "file"}`,
  "epub.progress.complete": () => "Conversion complete",
  "epub.error.unsafePath": ({ filename } = {}) => `Unsafe archive path: ${filename || "unknown"}`,
  "epub.error.invalidUtf8": ({ entryName } = {}) => `Invalid UTF-8 in ${entryName || "archive entry"}`,
  "epub.error.splitOpenCC": () => "Unable to split input safely for OpenCC",
  "epub.error.openCC": ({ entryName } = {}) => `OpenCC failed for ${entryName || "archive entry"}`,
  "epub.error.invalidContainer": () => "Invalid META-INF/container.xml",
  "epub.error.readEntry": ({ filename } = {}) => `Unable to read ${filename || "archive entry"}`,
  "epub.error.invalidBytes": () => "Input must be an ArrayBuffer or Uint8Array",
  "epub.error.notEpub": () => "Input filename must end in .epub",
  "epub.error.invalidArchive": () => "Invalid EPUB archive",
  "epub.error.missingStructure": () => "EPUB structure is incomplete",
  "epub.error.encrypted": () => "Encrypted EPUB entries are not supported",
  "epub.error.symlink": () => "Symbolic links are not allowed in EPUB archives",
  "epub.error.pathCollision": ({ filename } = {}) => `Converted archive path collision: ${filename || "unknown"}`,
});

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function phasePercent(phase, phaseValue = 0) {
  const percent = clampPercent(phaseValue);
  switch (phase) {
    case "initializing-opencc": return 1;
    case "initializing-dictionary": return 4;
    case "initializing-custom-dictionary": return 7;
    case "reading": return 8 + percent * 0.02;
    case "converting": return 10 + percent * 0.65;
    case "building": return 78;
    case "compressing": return 80 + percent * 0.19;
    case "complete": return 100;
    default: return 0;
  }
}

function terminalText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function clipText(value, width) {
  const text = terminalText(value);
  if (stringWidth(text) <= width) return text;
  const ellipsis = "…";
  const targetWidth = Math.max(0, width - stringWidth(ellipsis));
  let output = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (stringWidth(output + segment) > targetWidth) break;
    output += segment;
  }
  return `${output}${ellipsis}`;
}

function progressBackground(start, end, completed, ansiBackground) {
  const filled = Math.max(0, Math.min(end, completed) - start);
  const incomplete = Math.max(0, end - start - filled);
  if (!ansiBackground) return `${"█".repeat(filled)}${" ".repeat(incomplete)}`;
  return `${filled ? `\x1b[7m${" ".repeat(filled)}\x1b[27m` : ""}${" ".repeat(incomplete)}`;
}

function progressDetail(text, start, completed, ansiBackground) {
  if (!ansiBackground || !text) return text;
  let output = "";
  let position = start;
  let reversed = false;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const nextReversed = position < completed;
    if (nextReversed !== reversed) {
      output += nextReversed ? "\x1b[7m" : "\x1b[27m";
      reversed = nextReversed;
    }
    output += segment;
    position += stringWidth(segment);
  }
  return `${output}${reversed ? "\x1b[27m" : ""}`;
}

function format(percent, width = 24, detail = "", ansiBackground = false) {
  const value = clampPercent(percent);
  const completed = Math.round((value / 100) * width);
  const text = clipText(detail, width);
  const textWidth = stringWidth(text);
  const leftPadding = Math.floor(Math.max(0, width - textWidth) / 2);
  const textEnd = leftPadding + textWidth;
  const body = progressBackground(0, leftPadding, completed, ansiBackground)
    + progressDetail(text, leftPadding, completed, ansiBackground)
    + progressBackground(textEnd, width, completed, ansiBackground);
  return `[${body}${ansiBackground ? "\x1b[0m" : ""}] ${Math.round(value)
    .toString()
    .padStart(3)}%`;
}

function presentationMessage(message, fallback = "Unknown error") {
  if (message?.label) return message.label;
  if (message?.messageKey && MESSAGES[message.messageKey]) {
    return MESSAGES[message.messageKey](message.messageParameters);
  }
  return message?.message || fallback;
}

function elapsedSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

class Renderer {
  constructor(files, concurrency = files.length, stream = process.stdout) {
    this.stream = stream;
    this.interactive = Boolean(stream.isTTY);
    this.ansiBackground = this.interactive
      && !("NO_COLOR" in process.env)
      && process.env.FORCE_COLOR !== "0"
      && process.env.TERM !== "dumb";
    this.items = files.map((file) => ({
      filename: path.basename(file), percent: 0, phase: "queued", label: "Queued", settled: false, failed: false,
    }));
    this.slots = Array.from({ length: Math.max(1, concurrency) }, (_, index) => ({
      number: index + 1, itemId: null, filename: "", percent: 0, label: "Waiting",
    }));
    this.rendered = false;
    this.renderedLineCount = 0;
    this.timer = null;
    this.lastRenderAt = 0;
    this.nonInteractivePhases = new Map();
  }

  start() {
    if (this.interactive) this.render(true);
  }

  update(message) {
    const item = this.items[message.id];
    if (!item) return;
    const slot = this.slots[Math.max(0, (message.slot || 1) - 1)];
    if (slot && slot.itemId !== message.id) {
      Object.assign(slot, { itemId: message.id, filename: item.filename, percent: 0, label: "Starting" });
    }
    if (message.type === "started") {
      Object.assign(item, { phase: "starting", label: "Starting" });
    } else if (message.type === "progress") {
      item.phase = message.phase;
      item.percent = Math.max(item.percent, phasePercent(message.phase, message.percent));
      item.label = terminalText(presentationMessage(message, message.phase));
      if (slot) Object.assign(slot, { percent: item.percent, label: item.label });
      if (!this.interactive && this.nonInteractivePhases.get(message.id) !== message.phase) {
        this.nonInteractivePhases.set(message.id, message.phase);
        this.stream.write(`[${message.id + 1}/${this.items.length}] ${terminalText(item.filename)}: ${item.label}\n`);
      }
    } else if (message.type === "complete" || message.type === "failed") {
      Object.assign(item, {
        percent: 100,
        settled: true,
        failed: message.type === "failed",
        label: message.type === "failed" ? "Failed" : "Done",
      });
      const elapsed = Number.isFinite(message.elapsedMs) ? ` (${elapsedSeconds(message.elapsedMs)})` : "";
      const resultMessage = message.type === "complete"
        ? `Done: ${message.outputPath}${elapsed}`
        : `Failed: ${item.filename}: ${presentationMessage(message.error)}${elapsed}`;
      if (slot) Object.assign(slot, { itemId: null, filename: "", percent: 0, label: "Waiting" });
      this.printAbove(resultMessage);
    }
    if (this.interactive) this.scheduleRender();
  }

  settledCount() {
    return this.items.filter((item) => item.settled).length;
  }

  lines() {
    const columns = Math.max(20, Number(this.stream.columns) || 100);
    const lines = this.slots.filter((slot) => slot.itemId !== null).map((slot) => {
      const filename = slot.filename || `Worker ${slot.number}`;
      const titleWidth = Math.min(stringWidth(filename), Math.max(8, Math.floor(columns * 0.3)));
      const title = clipText(filename, titleWidth);
      const prefix = `${title} `;
      const barWidth = Math.max(1, columns - stringWidth(prefix) - 7);
      return `${prefix}${format(slot.percent, barWidth, slot.label, this.ansiBackground)}`;
    });
    const settled = this.settledCount();
    if (settled < this.items.length) {
      const totalPercent = this.items.length > 0 ? (settled / this.items.length) * 100 : 100;
      const totalBarWidth = Math.max(1, columns - stringWidth("Total ") - 7);
      lines.push(`Total ${format(
        totalPercent,
        totalBarWidth,
        `${settled}/${this.items.length} files`,
        this.ansiBackground,
      )}`);
    }
    return lines;
  }

  eraseRenderedLines() {
    if (!this.interactive || !this.rendered || this.renderedLineCount === 0) {
      this.rendered = false;
      this.renderedLineCount = 0;
      return false;
    }
    const lineCount = this.renderedLineCount;
    this.stream.write(`\x1b[${lineCount}A`);
    this.stream.write(Array.from({ length: lineCount }, () => "\x1b[2K\r\n").join(""));
    this.stream.write(`\x1b[${lineCount}A`);
    this.rendered = false;
    this.renderedLineCount = 0;
    return true;
  }

  printAbove(message) {
    const text = clipText(message, Math.max(20, Number(this.stream.columns) || 100));
    if (!this.interactive || !this.rendered) {
      this.stream.write(`${text}\n`);
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.eraseRenderedLines();
    this.stream.write(`${text}\n`);
    this.render(true);
  }

  scheduleRender() {
    if (this.timer !== null) return;
    const delay = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - this.lastRenderAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render();
    }, delay);
  }

  render(force = false) {
    if (!this.interactive) return;
    if (!force && performance.now() - this.lastRenderAt < RENDER_INTERVAL_MS) {
      this.scheduleRender();
      return;
    }
    const lines = this.lines();
    this.eraseRenderedLines();
    this.stream.write(lines.map((line) => `\x1b[2K\r${line}\n`).join(""));
    this.rendered = true;
    this.renderedLineCount = lines.length;
    this.lastRenderAt = performance.now();
  }

  finish() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.eraseRenderedLines();
  }
}

export const CliProgress = Object.freeze({
  create(files, concurrency, stream) {
    return new Renderer(files, concurrency, stream);
  },
  format,
  phasePercent,
});
