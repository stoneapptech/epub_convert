import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import stringWidth from "string-width";
import test from "node:test";

import {
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  configure,
} from "@zip.js/zip.js";

import {
  HELP,
  defaultJobCount,
  loadCustomDictionaryFiles,
  parseCliArgs,
  runConversionPool,
} from "../scripts/convert.mjs";
import { CliProgress } from "../scripts/cli-progress.mjs";

configure({ useWebWorkers: false, useCompressionStream: false });

async function createFixture(title) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useCompressionStream: false,
  });
  await writer.add("mimetype", new TextReader("application/epub+zip"), { level: 0 });
  await writer.add("META-INF/container.xml", new TextReader(
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  ));
  await writer.add("OEBPS/content.opf", new TextReader(
    `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>zh-CN</dc:language><dc:title>${title}</dc:title></metadata></package>`,
  ));
  await writer.add("OEBPS/章节.xhtml", new TextReader(
    `<?xml version="1.0"?><html><body>简体中文软件：${title}</body></html>`,
  ));
  return writer.close();
}

async function readEntryText(archivePath, entryName) {
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(archivePath)), {
    useWebWorkers: false,
    useCompressionStream: false,
    checkCrc32: true,
  });
  try {
    const entries = await reader.getEntries();
    const entry = entries.find(({ filename }) => filename === entryName);
    assert.ok(entry, `Missing ${entryName}`);
    return entry.getData(new TextWriter());
  } finally {
    await reader.close();
  }
}

test("CLI arguments and default concurrency are bounded", () => {
  assert.doesNotMatch(readFileSync("scripts/convert.mjs", "utf8"), /i18n\.js/u);
  assert.match(HELP, /automatic: up to 4; maximum: 64/);
  assert.deepEqual(parseCliArgs([
    "--mode=s2t",
    "--jobs", "3",
    "--jieba",
    "--output", "converted",
    "--dictionary", "terms.txt",
    "-d", "names.json",
    "--overwrite",
    "one.epub",
  ]), {
    mode: "s2t",
    jieba: true,
    jobs: 3,
    outputDirectory: "converted",
    dictionaryFiles: ["terms.txt", "names.json"],
    overwrite: true,
    help: false,
    inputs: ["one.epub"],
  });
  assert.equal(defaultJobCount(20, 16), 4);
  assert.equal(defaultJobCount(2, 16), 2);
  assert.throws(() => parseCliArgs(["--jobs", "0", "one.epub"]), /--jobs/);

  const interspersed = parseCliArgs([
    "one.epub",
    "-j3",
    "two.epub",
    "--mode", "t2s",
    "--output-dir", "converted",
  ]);
  assert.deepEqual(interspersed.inputs, ["one.epub", "two.epub"]);
  assert.equal(interspersed.jobs, 3);
  assert.equal(interspersed.mode, "t2s");
  assert.equal(interspersed.outputDirectory, "converted");
});

test("CLI progress renders file bars and a total file count", () => {
  assert.equal(CliProgress.phasePercent("converting", 50), 42.5);
  assert.equal(CliProgress.phasePercent("compressing", 100), 99);
  assert.equal(CliProgress.format(50, 10), "[█████     ]  50%");
  assert.match(CliProgress.format(50, 20, "Converting"), /Converting/);
  assert.doesNotMatch(CliProgress.format(50, 20, "Converting"), /░/);

  const output = [];
  const renderer = CliProgress.create(["one.epub", "two.epub"], 2, {
    isTTY: false,
    write(value) { output.push(value); },
  });
  renderer.update({ type: "progress", id: 0, slot: 1, phase: "converting", percent: 50, label: "Converting" });
  renderer.update({ type: "started", id: 1, slot: 2 });
  assert.equal(renderer.lines().length, 3);
  assert.match(renderer.lines()[0], /Converting/);
  assert.match(renderer.lines().at(-1), /^Total /);
  assert.match(renderer.lines().at(-1), /0\/2 files/);
  assert.doesNotMatch(renderer.lines().at(-1), /░/);
  renderer.update({ type: "complete", id: 0, slot: 1, outputPath: "converted/one.epub" });
  assert.match(renderer.lines().at(-1), /1\/2 files/);
  renderer.update({ type: "failed", id: 1, slot: 2, error: { message: "Invalid EPUB" } });
  assert.deepEqual(renderer.lines(), []);
  assert.doesNotMatch(output.join(""), /^\d+\/\d+\s/m);
  renderer.finish();
  assert.doesNotMatch(output.join(""), /Total \[/);

  const ttyOutput = [];
  const ttyRenderer = CliProgress.create(["one.epub"], 1, {
    isTTY: true,
    columns: 40,
    write(value) { ttyOutput.push(value); },
  });
  ttyRenderer.start();
  assert.match(ttyRenderer.lines().at(-1), /0\/1 files/);
  ttyRenderer.update({ type: "started", id: 0, slot: 1 });
  assert.equal(ttyRenderer.lines().length, 2);
  assert.ok(ttyRenderer.lines().every((line) => stringWidth(line) <= 40));
  ttyRenderer.update({
    type: "complete",
    id: 0,
    slot: 1,
    outputPath: "converted/one.epub",
    elapsedMs: 500,
  });
  assert.deepEqual(ttyRenderer.lines(), []);
  ttyRenderer.finish();
  assert.equal(ttyRenderer.rendered, false);
  assert.match(ttyOutput.join(""), /Done: converted\/one\.epub \(0\.50s\)/);

  const cjkRenderer = CliProgress.create(["文学少女.04 背负污名的天使.epub"], 1, {
    isTTY: true,
    columns: 80,
    write() {},
  });
  cjkRenderer.update({
    type: "progress",
    id: 0,
    slot: 1,
    phase: "compressing",
    percent: 90,
    label: "Compressing OPS/images/184052066945.jpg",
  });
  assert.ok(cjkRenderer.lines().every((line) => stringWidth(line) <= 80));
  cjkRenderer.finish();
});

test("Node worker pool converts EPUBs in parallel with WASM zip.js", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "epub-convert-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "output");
  try {
    const inputs = [
      path.join(temporaryDirectory, "简一.epub"),
      path.join(temporaryDirectory, "简二.epub"),
      path.join(temporaryDirectory, "损坏.epub"),
    ];
    await Promise.all(inputs.slice(0, 2).map(async (input, index) => {
      await writeFile(input, await createFixture(`第${index + 1}本书`));
    }));
    await writeFile(inputs[2], "not a ZIP archive");
    const dictionaryPath = path.join(temporaryDirectory, "terms.txt");
    await writeFile(dictionaryPath, "软件 程式\n");
    const customDictionary = await loadCustomDictionaryFiles([dictionaryPath]);
    assert.deepEqual(customDictionary.entries, [["软件", "程式"]]);

    const progressMessages = [];
    const results = await runConversionPool({
      files: inputs,
      config: "s2t",
      jobs: 2,
      outputDirectory,
      overwrite: false,
      customDictionary,
      onProgress: (message) => progressMessages.push(message),
    });

    assert.equal(results.length, 3);
    assert.equal(results.filter(({ type }) => type === "complete").length, 2);
    assert.equal(results.filter(({ type }) => type === "failed").length, 1);
    assert.ok(progressMessages.some((message) => (
      message.type === "progress"
      && message.phase === "compressing"
      && message.percent > 0
    )));
    const firstOutput = path.join(outputDirectory, "簡一.epub");
    const content = await readEntryText(firstOutput, "OEBPS/章節.xhtml");
    assert.match(content, /簡體中文程式/);
    const packageDocument = await readEntryText(firstOutput, "OEBPS/content.opf");
    assert.match(packageDocument, /<dc:language>zh-Hant<\/dc:language>/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
