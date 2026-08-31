import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomDictionaryError,
  mergeDictionaryLibraries,
  parseCustomDictionary,
  parseDictionaryLibrary,
  serializeDictionaryLibrary,
} from "../static/custom-dictionaries.js";

test("custom dictionaries use space-separated entries", () => {
  assert.deepEqual(parseCustomDictionary("电脑 電腦\n软件 軟體\n"), [
    ["电脑", "電腦"],
    ["软件", "軟體"],
  ]);
});

test("custom dictionaries reject malformed and duplicate entries", () => {
  assert.throws(() => parseCustomDictionary("missing-separator"), CustomDictionaryError);
  assert.throws(() => parseCustomDictionary("伺服器\t服務器"), CustomDictionaryError);
  assert.throws(() => parseCustomDictionary("詞 一\n詞 二"), (error) => (
    error.code === "duplicate-source" && error.line === 2
  ));
});

test("dictionary libraries round-trip and imports preserve name conflicts", () => {
  const current = [{ name: "小說", text: "软件 軟體" }];
  const imported = parseDictionaryLibrary(serializeDictionaryLibrary(current));
  assert.deepEqual(imported, current);
  assert.deepEqual(mergeDictionaryLibraries(current, imported), [
    current[0],
    { name: "小說 (2)", text: "软件 軟體" },
  ]);
});

test("custom dictionary entries compose after the configured OpenCC converter", async () => {
  const { default: OpenCC } = await import("../vendor/opencc-wasm/esm/index.js");
  const baseConverter = OpenCC.Converter({ config: "s2t" });
  const customConverter = OpenCC.CustomConverter([["電腦", "計算機"]]);

  assert.equal(customConverter(await baseConverter("电脑")), "計算機");
});

test("saved dictionary records cannot be empty", () => {
  assert.throws(
    () => serializeDictionaryLibrary([{ name: "empty", text: "# comments only" }]),
    (error) => error.code === "empty",
  );
});
