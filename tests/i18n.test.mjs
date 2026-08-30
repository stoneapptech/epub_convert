import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator, DEFAULT_LOCALE, t } from "../static/i18n.js";

test("default locale resolves messages and interpolates parameters", () => {
  assert.equal(DEFAULT_LOCALE, "zh-Hant");
  assert.equal(t("app.file.size", { size: "2.5 MiB" }), "檔案大小：2.5 MiB");
  assert.equal(
    t("epub.error.pathCollision", { filename: "Text/章節.xhtml" }),
    "路徑重複：Text/章節.xhtml",
  );
});

test("unknown locale falls back to the default catalog", () => {
  const translate = createTranslator("not-yet-translated");
  assert.equal(translate("app.result.complete"), "轉換完成");
});

test("missing translation keys fail loudly", () => {
  assert.throws(() => t("missing.translation.key"), /Missing translation/);
});
