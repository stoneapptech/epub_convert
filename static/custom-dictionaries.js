export const CUSTOM_DICTIONARY_LIBRARY_VERSION = 1;
export const MAX_CUSTOM_DICTIONARIES = 100;
export const MAX_CUSTOM_DICTIONARY_ENTRIES = 10_000;
export const MAX_CUSTOM_DICTIONARY_TEXT_LENGTH = 1024 * 1024;

export class CustomDictionaryError extends Error {
  constructor(code, line = null) {
    super(code);
    this.name = "CustomDictionaryError";
    this.code = code;
    this.line = line;
  }
}

export function parseCustomDictionary(text) {
  if (typeof text !== "string") throw new CustomDictionaryError("invalid-text");
  if (text.length > MAX_CUSTOM_DICTIONARY_TEXT_LENGTH) {
    throw new CustomDictionaryError("too-large");
  }

  const entries = [];
  const sources = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(\S+) +(.+)$/);
    if (!match) throw new CustomDictionaryError("invalid-entry", lineNumber);

    const source = match[1].trim();
    const target = match[2].trim();
    if (!source || !target) throw new CustomDictionaryError("invalid-entry", lineNumber);
    if (sources.has(source)) throw new CustomDictionaryError("duplicate-source", lineNumber);
    sources.add(source);
    entries.push([source, target]);
    if (entries.length > MAX_CUSTOM_DICTIONARY_ENTRIES) {
      throw new CustomDictionaryError("too-many-entries", lineNumber);
    }
  }
  return entries;
}

function normalizeRecord(record) {
  if (!record || typeof record.name !== "string" || typeof record.text !== "string") {
    throw new CustomDictionaryError("invalid-library");
  }
  const name = record.name.trim();
  if (!name || name.length > 100) throw new CustomDictionaryError("invalid-name");
  if (!parseCustomDictionary(record.text).length) {
    throw new CustomDictionaryError("empty");
  }
  return { name, text: record.text };
}

export function parseDictionaryLibrary(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new CustomDictionaryError("invalid-library");
  }
  if (data?.version !== CUSTOM_DICTIONARY_LIBRARY_VERSION || !Array.isArray(data.dictionaries)) {
    throw new CustomDictionaryError("invalid-library");
  }
  if (data.dictionaries.length > MAX_CUSTOM_DICTIONARIES) {
    throw new CustomDictionaryError("too-many-dictionaries");
  }
  return data.dictionaries.map(normalizeRecord);
}

export function serializeDictionaryLibrary(dictionaries) {
  const normalized = dictionaries.map(normalizeRecord);
  return JSON.stringify({
    version: CUSTOM_DICTIONARY_LIBRARY_VERSION,
    dictionaries: normalized,
  }, null, 2);
}

export function mergeDictionaryLibraries(current, imported) {
  const merged = current.map(normalizeRecord);
  const names = new Set(merged.map((item) => item.name));
  for (const record of imported.map(normalizeRecord)) {
    let name = record.name;
    let suffix = 2;
    while (names.has(name)) {
      name = `${record.name} (${suffix})`;
      suffix += 1;
    }
    names.add(name);
    merged.push({ ...record, name });
    if (merged.length > MAX_CUSTOM_DICTIONARIES) {
      throw new CustomDictionaryError("too-many-dictionaries");
    }
  }
  return merged;
}
