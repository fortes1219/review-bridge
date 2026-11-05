// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectDoctor } from "../features/doctor/index.mjs";
import { consoleEncodingHint, PROFILE_LINE } from "../features/doctor/consoleEncoding.mjs";
import { getBridgePaths } from "../utils/paths.mjs";

// doctor tells a Windows user when PowerShell does not write UTF-8 (Codex's Chinese output then
// arrives broken) and how to fix it; the code page is passed in, so the runner's own does not matter.
const sourceBridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function project(t) {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-doctor-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const bridgeRoot = path.join(repoRoot, ".runtime");
  await fsp.mkdir(path.join(bridgeRoot, "config"), { recursive: true });
  await fsp.copyFile(path.join(sourceBridgeRoot, "config", "default-policy.json"), path.join(bridgeRoot, "config", "default-policy.json"));
  const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName: ".review-bridge" });
  await fsp.mkdir(path.dirname(paths.bridgeConfigPath), { recursive: true });
  await fsp.writeFile(paths.bridgeConfigPath, JSON.stringify({ schema_version: 4, project_id: randomUUID(), roles: { writer: { provider_id: "claude" }, reviewer: { provider_id: "codex" } } }));
  return paths;
}

const doctor = (paths, platform, codePage) => inspectDoctor({
  paths, adapter: { target: "test", id: "test" }, manifest: { commands: [] }, platform, codePage,
});

test("on Windows doctor names the profile line when PowerShell writes code page 950, and says nothing for UTF-8", async (t) => {
  const paths = await project(t);
  const big5 = await doctor(paths, "win32", 950);
  assert.equal(big5.platform.powershell_code_page, 950);
  const hint = big5.warnings.find((line) => line.startsWith("PowerShell writes in code page 950"));
  assert.ok(hint, JSON.stringify(big5.warnings));
  assert.ok(hint.includes("$PROFILE") && hint.includes(PROFILE_LINE) && hint.includes("pwsh"));
  const utf8 = await doctor(paths, "win32", 65001);
  assert.equal(utf8.warnings.some((line) => line.includes("PowerShell")), false);
  // The filesystem checked is the state's, where the locks are, not the project's (RC3-FIX-02).
  assert.equal(utf8.state_filesystem.path, path.resolve(paths.stateRoot));
});

test("doctor asks nothing about PowerShell off Windows, and says so when PowerShell could not be asked", async (t) => {
  const paths = await project(t);
  const linux = await doctor(paths, "linux", null);
  assert.equal(Object.hasOwn(linux.platform, "powershell_code_page"), false);
  assert.equal(linux.warnings.some((line) => line.includes("PowerShell")), false);
  assert.equal(consoleEncodingHint({ platform: "darwin", codePage: 950 }), null);
  assert.match(consoleEncodingHint({ platform: "win32", codePage: null }), /^Could not ask PowerShell .*\$PROFILE.*\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8$/);
});
