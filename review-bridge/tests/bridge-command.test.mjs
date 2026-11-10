import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bridgeCommand, bridgeRunner } from "../utils/bridgeCommand.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The user agents the package managers set (their first word is what create-vite reads), and the line
// each one prints: the package manager's one-off form, no version, so the latest.
const CASES = [
  ["npm/11.13.0 node/v24.16.0 win32 x64 workspaces/false", "npx review-bridge"],
  ["pnpm/10.4.1 npm/? node/v22.12.0 linux x64", "pnpm dlx review-bridge"],
  ["yarn/4.6.0 npm/? node/v22.12.0 darwin arm64", "yarn dlx review-bridge"],
  ["yarn/1.22.22 npm/? node/v22.12.0 linux x64", "npx review-bridge"],
  ["bun/1.2.4 npm/? node/v22.6.0 linux x64", "bun x review-bridge"],
  ["deno/2.2.0 npm/? deno/2.2.0 linux x86_64", "deno run -A npm:review-bridge"],
  ["cnpm/9.4.0 npm/? node/v22.12.0 linux x64", "npx review-bridge"],
];

test("a printed Bridge command is the package manager's one-off form, npx when none is named", () => {
  for (const [agent, runner] of CASES) assert.equal(bridgeRunner({ npm_config_user_agent: agent }), runner, agent);
  assert.equal(bridgeRunner({}), "npx review-bridge", "a global install, run by its name, has no user agent");
  assert.equal(bridgeCommand("start .review-bridge/work-packages/a.md --yes", { npm_config_user_agent: CASES[0][0] }), "npx review-bridge start .review-bridge/work-packages/a.md --yes");
  assert.equal(bridgeCommand("", {}), "npx review-bridge");
});

// The function only helps where it is called: a line still naming `review-bridge <command>` prints a
// command an npx user does not have. Every file npm ships is read; only --help names the program itself,
// as Vite's help does (router/help.mjs, and the commands' own notes in router/index.mjs).
test("no shipped line tells the person to run a bare review-bridge command; --help alone names the program", () => {
  const verbs = "graph|stop|down|up|upgrade|vscode|start|status|resume|clean|init|logs|doctor|uninstall|work-start|work-plan|backup|roles-check|--help|ps|watch";
  const bare = new RegExp("(?<![.\\w$/@:-])review-bridge (?:" + verbs + ")\\b");
  const shipped = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).files;
  const files = [];
  const queue = shipped.filter((entry) => !entry.startsWith("!")).map((entry) => path.join(packageRoot, entry));
  while (queue.length) {
    const next = queue.shift();
    if (!fs.existsSync(next)) continue;
    if (fs.statSync(next).isDirectory()) {
      if (path.basename(next) === "tests") continue;
      for (const name of fs.readdirSync(next)) queue.push(path.join(next, name));
    } else if (/\.(mjs|json|md)$/.test(next)) files.push(next);
  }
  const help = path.join(packageRoot, "review-bridge", "router", "help.mjs");
  const commandTable = path.join(packageRoot, "review-bridge", "router", "index.mjs");
  const found = [];
  for (const file of files) {
    if (file === help || path.basename(file) === "README.md") continue;
    fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (file.endsWith(".mjs") && (trimmed.startsWith("//") || trimmed.startsWith("*"))) return;
      if (file === commandTable && trimmed.startsWith("note:")) return;
      if (bare.test(line)) found.push(path.relative(packageRoot, file).replaceAll("\\", "/") + ":" + (index + 1));
    });
  }
  assert.ok(files.length > 50, "the shipped files were read (" + files.length + ")");
  assert.deepEqual(found, []);
});
