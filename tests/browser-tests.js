import OpenCC from "../vendor/opencc-wasm/esm/index.js";
import {
    TextReader,
    TextWriter,
    Uint8ArrayReader,
    Uint8ArrayWriter,
    ZipReader,
    ZipWriter,
} from "../vendor/zip.js/zip-core-external.min.js";
import { convertEpub } from "../static/epub-converter.js";
import {
    JIEBA_CONFIGS,
    MODE_GROUPS,
    resolveConfig,
    resolveMode,
    supportsJieba,
    supportsWordConversion,
} from "../static/modes.js";

const results = document.querySelector("#results");
const runButton = document.querySelector("#run-tests");
const encoder = new TextEncoder();
let exportedEpub = null;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function addResult(name, error = null) {
    const item = document.createElement("div");
    item.className = `item ${error ? "is-negative" : "is-positive"}`;
    item.textContent = error ? `失敗：${name} — ${error.message}` : `通過：${name}`;
    results.append(item);
}

async function createFixture(extraEntries = []) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
        level: 6,
        useWebWorkers: false,
        useCompressionStream: false,
    });
    await writer.add("mimetype", new TextReader("application/epub+zip"), { level: 0 });
    await writer.add(
        "META-INF/container.xml",
        new TextReader('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/书.opf"/></rootfiles></container>'),
    );
    await writer.add(
        "OEBPS/书.opf",
        new TextReader('<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>zh-CN</dc:language></metadata><manifest><item href="章节.xhtml"/><item href="图片.png"/></manifest></package>'),
    );
    await writer.add(
        "OEBPS/章节.xhtml",
        new TextReader('<html xmlns="http://www.w3.org/1999/xhtml"><body>汉字与软件<img src="图片.png"/></body></html>'),
    );
    await writer.add("OEBPS/图片.png", new Uint8ArrayReader(new Uint8Array([0, 1, 2, 127, 255])));
    for (const [name, data] of extraEntries) {
        const bytes = typeof data === "string" ? encoder.encode(data) : data;
        await writer.add(name, new Uint8ArrayReader(bytes));
    }
    return writer.close();
}

async function readArchive(bytes) {
    const reader = new ZipReader(new Uint8ArrayReader(bytes), {
        strictness: "strict",
        checkCrc32: true,
        checkOverlappingEntry: true,
        useWebWorkers: false,
        useCompressionStream: false,
    });
    const entries = await reader.getEntries();
    return { reader, entries, byName: new Map(entries.map((entry) => [entry.filename, entry])) };
}

async function testModeDefinitions() {
    const modes = Object.values(MODE_GROUPS).flat();
    assert(modes.length === 16, "預期 16 個一般模式");
    assert(new Set(modes).size === modes.length, "一般模式不可重複");
    for (const [base, jieba] of Object.entries(JIEBA_CONFIGS)) {
        assert(supportsJieba(base), `${base} 應支援 Jieba`);
        assert(resolveConfig(base, true) === jieba, `${base} 的 Jieba 映射錯誤`);
    }
    for (const mode of modes.filter((mode) => !supportsJieba(mode))) {
        assert(resolveConfig(mode, true) === mode, `${mode} 不應切換至 Jieba`);
    }

    const selections = [
        ["s2t", "standard", false, "s2t"],
        ["s2t", "tw", false, "s2tw"],
        ["s2t", "tw", true, "s2twp"],
        ["s2t", "hk", false, "s2hk"],
        ["s2t", "hk", true, "s2hkp"],
        ["t2s", "standard", false, "t2s"],
        ["t2s", "tw", false, "tw2s"],
        ["t2s", "tw", true, "tw2sp"],
        ["t2s", "hk", false, "hk2s"],
        ["t2s", "hk", true, "hk2sp"],
    ];
    for (const [direction, region, words, expected] of selections) {
        assert(resolveMode(direction, region, words) === expected, `${direction}/${region}/${words} 映射錯誤`);
    }
    assert(!supportsWordConversion("s2t", "standard"), "標準簡繁不應支援地區用詞轉換");
    assert(supportsWordConversion("s2t", "tw"), "台灣模式應支援地區用詞轉換");
    assert(supportsWordConversion("t2s", "hk"), "香港模式應支援地區用詞轉換");
}

async function testAllOpenCcConfigs() {
    const configs = [...Object.values(MODE_GROUPS).flat(), ...Object.values(JIEBA_CONFIGS)];
    for (const config of configs) {
        const converter = OpenCC.Converter({ config });
        const output = await converter("汉字繁體軟件");
        assert(typeof output === "string" && output.length > 0, `${config} 無法轉換文字`);
    }
}

async function testEpubConversion() {
    const input = await createFixture();
    const converter = OpenCC.Converter({ config: "s2tw" });
    const output = await convertEpub({
        bytes: input,
        filename: "测试.epub",
        config: "s2tw",
        converter,
    });
    exportedEpub = output.bytes;
    assert(output.filename === "測試.epub", "輸出檔名未轉換");

    const archive = await readArchive(output.bytes);
    try {
        const { entries, byName } = archive;
        assert(entries[0].filename === "mimetype", "mimetype 不是第一個項目");
        assert(entries[0].compressionMethod === 0, "mimetype 未使用 STORE");
        assert(byName.has("OEBPS/書.opf"), "OPF 路徑未轉換");
        assert(byName.has("OEBPS/章節.xhtml"), "XHTML 路徑未轉換");
        assert(byName.has("OEBPS/圖片.png"), "二進位資源路徑未轉換");

        const container = await byName.get("META-INF/container.xml").getData(new TextWriter());
        const opf = await byName.get("OEBPS/書.opf").getData(new TextWriter());
        const chapter = await byName.get("OEBPS/章節.xhtml").getData(new TextWriter());
        const image = await byName.get("OEBPS/圖片.png").getData(new Uint8ArrayWriter());
        assert(container.includes("OEBPS/書.opf"), "container.xml 的 OPF 參照未轉換");
        assert(opf.includes("zh-TW"), "OPF 語言未更新");
        assert(opf.includes("章節.xhtml") && opf.includes("圖片.png"), "OPF 內部參照未轉換");
        assert(chapter.includes("漢字") && !chapter.includes("汉字"), "XHTML 文字未轉換");
        assert(image.every((value, index) => value === [0, 1, 2, 127, 255][index]), "二進位內容已改變");
    } finally {
        await archive.reader.close();
    }
}

async function testConversionWorker() {
    const input = await createFixture();
    const inputBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    const worker = new Worker(new URL("../static/convert-worker.js", import.meta.url), { type: "module" });
    try {
        const result = await new Promise((resolve, reject) => {
            worker.addEventListener("message", (event) => {
                if (event.data?.type === "complete") {
                    resolve(event.data);
                }
                if (event.data?.type === "error") {
                    reject(new Error(event.data.error?.message || "Worker 轉換失敗"));
                }
            });
            worker.addEventListener("error", (event) => {
                reject(event.error || new Error(event.message));
            });
            worker.postMessage(
                { type: "convert", bytes: inputBuffer, filename: "工作测试.epub", config: "s2tw" },
                [inputBuffer],
            );
        });
        assert(result.filename === "工作測試.epub", "Worker 未回傳轉換後檔名");
        const archive = await readArchive(new Uint8Array(result.bytes));
        try {
            assert(archive.entries[0].filename === "mimetype", "Worker 輸出的 EPUB 無效");
        } finally {
            await archive.reader.close();
        }
    } finally {
        worker.terminate();
    }
}

async function testInvalidArchive() {
    let error;
    try {
        await convertEpub({
            bytes: new Uint8Array([1, 2, 3]),
            filename: "broken.epub",
            config: "s2tw",
            converter: async (text) => text,
        });
    } catch (caught) {
        error = caught;
    }
    assert(error?.code === "invalid-archive", "損壞的 ZIP 未被拒絕");
}

async function testInvalidUtf8() {
    const input = await createFixture([["OEBPS/bad.xhtml", new Uint8Array([0xc3, 0x28])]]);
    let error;
    try {
        await convertEpub({
            bytes: input,
            filename: "bad.epub",
            config: "s2tw",
            converter: async (text) => text,
        });
    } catch (caught) {
        error = caught;
    }
    assert(error?.code === "invalid-encoding", "無效 UTF-8 未被拒絕");
}

async function testPathCollision() {
    const input = await createFixture([
        ["OEBPS/one.xhtml", "<html/>"],
        ["OEBPS/two.xhtml", "<html/>"],
    ]);
    const converter = async (text) => text.replace("one.xhtml", "same.xhtml").replace("two.xhtml", "same.xhtml");
    let error;
    try {
        await convertEpub({ bytes: input, filename: "collision.epub", config: "s2tw", converter });
    } catch (caught) {
        error = caught;
    }
    assert(error?.code === "path-collision", "轉換後路徑碰撞未被拒絕");
}

const tests = [
    ["模式與 Jieba 映射", testModeDefinitions],
    ["全部 OpenCC 設定可載入", testAllOpenCcConfigs],
    ["EPUB 轉換與 WASM ZIP 封裝", testEpubConversion],
    ["Web Worker 完整轉換", testConversionWorker],
    ["拒絕損壞的 ZIP", testInvalidArchive],
    ["拒絕無效 UTF-8", testInvalidUtf8],
    ["拒絕轉換後路徑碰撞", testPathCollision],
];

async function runTests() {
    results.replaceChildren();
    runButton.disabled = true;
    runButton.classList.add("is-loading");
    let failures = 0;
    for (const [name, test] of tests) {
        try {
            await test();
            addResult(name);
        } catch (error) {
            addResult(name, error);
            failures += 1;
        }
    }
    runButton.classList.remove("is-loading");
    runButton.disabled = false;
    document.body.dataset.testStatus = failures ? "failed" : "passed";
    if (!failures && exportedEpub && new URLSearchParams(location.search).has("export")) {
        const binary = Array.from(exportedEpub, (byte) => String.fromCharCode(byte)).join("");
        const exportNode = document.createElement("pre");
        exportNode.id = "exported-epub";
        exportNode.hidden = true;
        exportNode.textContent = btoa(binary);
        document.body.append(exportNode);
    }
}

runButton.addEventListener("click", runTests);

if (new URLSearchParams(location.search).has("autorun")) {
    runTests();
}
