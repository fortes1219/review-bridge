// Language packs. Bridge's own human-facing text comes from
// `locales/<lang>.json`; internal codes stay language-neutral. A missing key
// returns the key itself so a gap in a pack never breaks a delivery.
import fs from "node:fs";
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

// The person's language as create-vue finds it (utils/getLanguage.ts getLocale, ECOSYSTEM-REFERENCES A): the POSIX
// variables LC_ALL, LC_MESSAGES and LANG first, then what Intl reports (MDN: a DateTimeFormat made with
// no arguments "uses the current system settings"), then English. A POSIX value is cut at its charset
// (zh_TW.UTF-8 is zh-TW), and the C locale, POSIX's own name for it included, is English. Node on Windows
// reads the system and not these variables, so this is what lets a person, or a test, choose there.
export function shellLocale(env = process.env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || new Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const tag = String(raw).split(".")[0].replace("_", "-");
  return tag === "C" || tag === "POSIX" ? "en-US" : tag;
}

// The language init writes into bridge.json and speaks in: the person's (shellLocale), matched to a
// language pack by language and script after Add Likely Subtags (Intl.Locale maximize: zh-TW, zh-HK and
// zh-MO are zh-Hant, zh-CN and zh-SG zh-Hans, as create-vue links them). The default when no pack matches
// or the tag is not one.
export async function systemLocale({ locale = shellLocale() } = {}) {
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

function translatorOf(pack, locale) {
  const t = (key, vars = {}) => {
    const template = Object.hasOwn(pack, key) ? pack[key] : key;
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (name in vars && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match));
  };
  t.locale = locale;
  t.has = (key) => Object.hasOwn(pack, key);
  return t;
}

export async function createTranslator(locale = DEFAULT_LOCALE) {
  return translatorOf((await loadPack(locale)) || (await loadPack(DEFAULT_LOCALE)) || {}, locale);
}

// The default language's words, for a caller that has no language of its own to say them in (upgrade's
// last lines, a helper called without one); read once.
let english = null;
export function defaultTranslator() {
  english ??= translatorOf(JSON.parse(fs.readFileSync(path.join(localesDir, DEFAULT_LOCALE + ".json"), "utf8")), DEFAULT_LOCALE);
  return english;
}
