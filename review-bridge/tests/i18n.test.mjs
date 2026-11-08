import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { serviceDown, serviceStatus } from "../features/setupCheck/pageService.mjs";
import { createTranslator, DEFAULT_LOCALE, systemLocale } from "../features/workOrder/i18n.mjs";

const locales = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "features", "workOrder", "locales");

// init writes the system's language (MDN: Intl's default "uses the current system settings"), matched to
// a pack by language and script after Add Likely Subtags; nothing that matches is English.
test("the system's language picks the pack with its language and script; anything else is the default", async () => {
  for (const [system, pack] of [["zh-TW", "zh-TW"], ["zh-Hant-HK", "zh-TW"], ["zh-Hant", "zh-TW"], ["zh-CN", DEFAULT_LOCALE], ["en-GB", "en"], ["ja-JP", DEFAULT_LOCALE], ["not a locale", DEFAULT_LOCALE]]) {
    assert.equal(await systemLocale({ locale: system }), pack, system);
  }
  assert.equal(DEFAULT_LOCALE, "en");
});

test("every pack has the same keys, and the card and its stop line are in each person's language", async () => {
  const packs = fs.readdirSync(locales).filter((name) => name.endsWith(".json")).map((name) => [name, Object.keys(JSON.parse(fs.readFileSync(path.join(locales, name), "utf8"))).sort()]);
  for (const [name, keys] of packs) assert.deepEqual(keys, packs[0][1], name);
  const zh = await createTranslator("zh-TW");
  const en = await createTranslator("en");
  assert.equal(en("card.needs_authorization", { command: "review-bridge start a.md" }), "Needs authorization. If the person says yes, run again: review-bridge start a.md --yes");
  assert.equal(zh("card.needs_authorization", { command: "review-bridge start a.md" }), "需要授權。人說好之後，再執行：review-bridge start a.md --yes");
  assert.equal(zh("card.ask"), "開始這份工作嗎？[y/N] ");
  assert.equal(en("card.ask"), "Start this work? [y/N] ");
  // A --yes that is refused stops the person too: their language, as the card.
  assert.equal(en("yes.expired", { until: "2026-11-08T01:00:00.000Z", again: "review-bridge start a.md" }), "The card was valid until 2026-11-08T01:00:00.000Z. Run: review-bridge start a.md and show the person the new card.");
  assert.equal(zh("yes.no_card", { again: "review-bridge start a.md" }), "這張工單沒有顯示過卡片，所以沒有可以照著跑的「好」。請執行：review-bridge start a.md，並把卡片給人看。");
  for (const key of ["yes.no_card", "yes.directory_card", "yes.old_card", "yes.changed", "yes.option", "yes.used", "yes.expired", "line.yes.no_card", "line.yes.changed", "line.yes.used", "line.yes.ran_meanwhile"]) {
    assert.ok(zh.has(key) && en.has(key), key);
  }
});

// The page service's lines follow the project's locale, as the database's lines beside them do (Fortes
// 2026-11-09); they used to be Chinese in every project. No page runs here: no session is recorded.
test("ps and down say the page's state in the project's language", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-page-words-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = {
    bridgeConfigPath: path.join(root, "bridge.json"), watchSessionPath: path.join(root, "watch-session.json"),
    watchUrlPath: path.join(root, "watch-url.txt"), logRoot: path.join(root, "logs"),
  };
  const said = async (call) => {
    const lines = [];
    await call({ paths, out: { write: (text) => lines.push(text) } });
    return lines.join("");
  };
  for (const [locale, notRunning, wasNot] of [
    ["zh-TW", "Bridge 沒在跑，執行 review-bridge up\n", "Bridge 沒在跑\n"],
    ["en", "Bridge is not running. Run: review-bridge up\n", "Bridge was not running.\n"],
  ]) {
    await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ locale }));
    assert.equal(await said(serviceStatus), notRunning, locale);
    assert.equal(await said(serviceDown), wasNot, locale);
  }
  // A project with no locale is English, the default.
  await fsp.writeFile(paths.bridgeConfigPath, "{}");
  assert.equal(await said(serviceStatus), "Bridge is not running. Run: review-bridge up\n");
});
