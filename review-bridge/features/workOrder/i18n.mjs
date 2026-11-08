// Language packs. Bridge's own human-facing text comes from
// `locales/<lang>.json`; internal codes stay language-neutral. A missing key
// returns the key itself so a gap in a pack never breaks a delivery.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LOCALE = "en";
const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "locales");
const cache = new Map();

export async function availableLocales() {
  const entries = await fsp.readdir(localesDir).catch(() => []);
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
}

async function loadPack(locale) {
  if (!cache.has(locale)) {
    const text = await fsp.readFile(path.join(localesDir, locale + ".json"), "utf8").catch(() => null);
    cache.set(locale, text ? JSON.parse(text) : null);
  }
  return cache.get(locale);
}

// One key's text in every language Bridge has: what it wrote in one language is still read in another.
export async function inEveryLocale(key) {
  const packs = await Promise.all((await availableLocales()).map(loadPack));
  return packs.map((pack) => pack?.[key]).filter(Boolean);
}

// The language of the person's system, the one init writes into bridge.json: what Intl reports (MDN: a
// DateTimeFormat made with no arguments "uses the current system settings"), matched to a language pack by
// language and script after Add Likely Subtags (Intl.Locale maximize: zh-TW and zh-Hant-HK are both
// zh-Hant, zh-CN is zh-Hans). The default when no pack matches or Intl cannot tell.
export async function systemLocale({ locale = new Intl.DateTimeFormat().resolvedOptions().locale } = {}) {
  let wanted;
  try {
    wanted = new Intl.Locale(locale).maximize();
  } catch {
    return DEFAULT_LOCALE;
  }
  for (const name of await availableLocales()) {
    const pack = new Intl.Locale(name).maximize();
    if (pack.language === wanted.language && pack.script === wanted.script) return name;
  }
  return DEFAULT_LOCALE;
}

// The locale named in bridge.json, or the default; an unknown name falls back to the default.
export async function resolveLocale(paths) {
  const config = await fsp.readFile(paths.bridgeConfigPath, "utf8").then((text) => JSON.parse(text), () => ({}));
  const requested = typeof config?.locale === "string" ? config.locale.trim() : "";
  if (requested && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(requested) && (await loadPack(requested))) return requested;
  return DEFAULT_LOCALE;
}

export async function createTranslator(locale = DEFAULT_LOCALE) {
  const pack = (await loadPack(locale)) || (await loadPack(DEFAULT_LOCALE)) || {};
  const t = (key, vars = {}) => {
    const template = Object.hasOwn(pack, key) ? pack[key] : key;
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (name in vars && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match));
  };
  t.locale = locale;
  t.has = (key) => Object.hasOwn(pack, key);
  return t;
}
