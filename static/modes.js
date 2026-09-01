import { t } from "./i18n.js";
export {
    JIEBA_CONFIGS,
    MODE_GROUPS,
    outputLanguage,
    resolveConfig,
    supportsJieba,
} from "./opencc-config.js";

export const MODE_SELECTIONS = Object.freeze({
    s2t: Object.freeze({
        standard: Object.freeze({ characters: "s2t", words: null }),
        tw: Object.freeze({ characters: "s2tw", words: "s2twp" }),
        hk: Object.freeze({ characters: "s2hk", words: "s2hkp" }),
    }),
    t2s: Object.freeze({
        standard: Object.freeze({ characters: "t2s", words: null }),
        tw: Object.freeze({ characters: "tw2s", words: "tw2sp" }),
        hk: Object.freeze({ characters: "hk2s", words: "hk2sp" }),
    }),
});

export function resolveMode(direction, region, useWordConversion = false) {
    const selection = MODE_SELECTIONS[direction]?.[region];
    if (!selection) {
        throw new Error(t("modes.error.selection", { direction, region }));
    }
    return useWordConversion && selection.words ? selection.words : selection.characters;
}

export function supportsWordConversion(direction, region) {
    return Boolean(MODE_SELECTIONS[direction]?.[region]?.words);
}
