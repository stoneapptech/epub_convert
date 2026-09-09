import zhHant from "./locales/zh-Hant.js";

export const DEFAULT_LOCALE = "zh-Hant";

const catalogs = Object.freeze({
  [DEFAULT_LOCALE]: zhHant,
});

export function createTranslator(locale = DEFAULT_LOCALE) {
  const catalog = catalogs[locale] || catalogs[DEFAULT_LOCALE];

  return (key, parameters = {}) => {
    const message = catalog[key];
    if (message === undefined) {
      console.warn(`Missing translation: ${locale}/${key}`);
      return key;
    }

    return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name) => (
      Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder
    ));
  };
}

export const t = createTranslator();
