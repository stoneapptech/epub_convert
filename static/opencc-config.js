export const MODE_GROUPS = Object.freeze({
  standard: ["s2t", "t2s"],
  taiwan: ["s2tw", "tw2s", "s2twp", "tw2sp"],
  hongKong: ["s2hk", "hk2s", "s2hkp", "hk2sp"],
  regional: ["t2tw", "tw2t", "t2hk", "hk2t"],
  japanese: ["jp2t", "t2jp"],
});

export const JIEBA_CONFIGS = Object.freeze({
  s2twp: "s2twp_jieba",
  tw2sp: "tw2sp_jieba",
  s2hkp: "s2hkp_jieba",
  hk2sp: "hk2sp_jieba",
});

const OUTPUT_LANGUAGES = Object.freeze({
  s2t: "zh-Hant",
  t2s: "zh-CN",
  s2tw: "zh-TW",
  tw2s: "zh-CN",
  s2twp: "zh-TW",
  tw2sp: "zh-CN",
  s2hk: "zh-HK",
  hk2s: "zh-CN",
  s2hkp: "zh-HK",
  hk2sp: "zh-CN",
  t2tw: "zh-TW",
  tw2t: "zh-Hant",
  t2hk: "zh-HK",
  hk2t: "zh-Hant",
  jp2t: "zh-Hant",
  t2jp: "ja",
});

const ALL_MODES = new Set(Object.values(MODE_GROUPS).flat());

export function resolveConfig(mode, useJieba = false) {
  if (!ALL_MODES.has(mode)) throw new Error(`Unknown OpenCC mode: ${mode}`);
  return useJieba && JIEBA_CONFIGS[mode] ? JIEBA_CONFIGS[mode] : mode;
}

export function supportsJieba(mode) {
  return Object.hasOwn(JIEBA_CONFIGS, mode);
}

export function outputLanguage(config) {
  const baseConfig = config.replace(/_jieba$/, "");
  return OUTPUT_LANGUAGES[baseConfig] ?? null;
}
