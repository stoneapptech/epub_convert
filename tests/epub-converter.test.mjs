import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import OpenCC from "opencc-wasm";

import {
    EpubConversionError,
    convertOpenCcText,
    isAcceptedEpubMimetype,
} from "../static/epub-converter.js";

const utf8Encoder = new TextEncoder();

test("EPUB mimetype validation tolerates whitespace and ASCII case", () => {
    assert.equal(isAcceptedEpubMimetype("application/epub+zip"), true);
    assert.equal(isAcceptedEpubMimetype("\uFEFF  Application/EPUB+ZIP\r\n"), true);
    assert.equal(isAcceptedEpubMimetype("application/zip"), false);
    assert.equal(isAcceptedEpubMimetype(""), false);
});

test("large OpenCC input is converted in safe UTF-8 chunks", async () => {
    const input = `${"简体中文🙂，软件转换。".repeat(8_000)}结尾`;
    const chunks = [];
    const converter = async (chunk) => {
        chunks.push(chunk);
        return chunk;
    };

    const output = await convertOpenCcText(converter, input, "OEBPS/chapter.xhtml");

    assert.equal(output, input);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.ok(utf8Encoder.encode(chunk).byteLength <= 16 * 1024);
        assert.doesNotMatch(chunk[0] || "", /[\uDC00-\uDFFF]/u);
        assert.doesNotMatch(chunk.at(-1) || "", /[\uD800-\uDBFF]/u);
    }
});

test("OpenCC failures include the EPUB entry and chunk diagnostics", async () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        await assert.rejects(
            convertOpenCcText(
                async () => {
                    throw new WebAssembly.RuntimeError("index out of bounds");
                },
                "简体内容".repeat(10_000),
                "OEBPS/large.xhtml",
            ),
            (error) => {
                assert.ok(error instanceof EpubConversionError);
                assert.equal(error.code, "opencc-conversion");
                assert.equal(error.messageKey, "epub.error.openCC");
                assert.deepEqual(error.messageParameters, { entryName: "OEBPS/large.xhtml" });
                assert.equal(error.entryName, "OEBPS/large.xhtml");
                assert.ok(error.diagnostics.chunkCount > 1);
                assert.ok(error.diagnostics.chunkBytes <= 16 * 1024);
                return true;
            },
        );
    } finally {
        console.error = originalConsoleError;
    }
});

test("conversion workers and shared runtime do not depend on UI translations", () => {
    for (const filename of [
        "static/convert-worker.js",
        "static/conversion-runtime.js",
        "static/epub-converter.js",
        "scripts/node-convert-worker.mjs",
    ]) {
        const source = readFileSync(filename, "utf8");
        assert.doesNotMatch(source, /i18n\.js/u, filename);
        assert.doesNotMatch(source, /\bt\s*\(/u, filename);
    }
});

test("large input completes with the pinned OpenCC WASM converter", async () => {
    const converter = OpenCC.Converter({ config: "s2t" });
    const input = "简体中文软件转换。".repeat(12_000);

    const output = await convertOpenCcText(converter, input, "OEBPS/large.xhtml");

    assert.ok(output.startsWith("簡體中文軟件轉換。"));
    assert.equal(output.length, input.length);
});
