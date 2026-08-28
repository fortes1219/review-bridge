#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testPath = path.join(packageRoot, "review-bridge", "tests", "state-v4.acceptance.test.mjs");
const evidenceRoot = path.join(packageRoot, "docs", "evidence");
const platformLabel = `${process.platform}-${process.arch}`;
const rawName = `state-v4-acceptance-${platformLabel}-20260828.tap`;
const rawPath = path.join(evidenceRoot, rawName);
const manifestPath = path.join(evidenceRoot, `state-v4-acceptance-${platformLabel}-20260828.json`);
const command = `node --test --test-reporter=tap ${path.relative(packageRoot, testPath).replaceAll("\\", "/")}`;

function detectWindowsFilesystem(location) {
  if (process.platform !== "win32") return { volume: path.parse(location).root, filesystem_type: "not-detected" };
  const drive = path.parse(location).root.slice(0, 2);
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `([System.IO.DriveInfo]::new('${drive}')).DriveFormat`,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Could not detect the real local filesystem: " + (result.stderr || result.stdout).trim());
  }
  return { volume: drive, filesystem_type: result.stdout.trim() };
}

await fsp.mkdir(evidenceRoot, { recursive: true });
const ac16Root = await fsp.mkdtemp(path.join(packageRoot, ".ac16-volume-"));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testPath], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, REVIEW_BRIDGE_AC16_ROOT: ac16Root },
});
await fsp.rm(ac16Root, { recursive: true, force: true });
const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
await fsp.writeFile(rawPath, raw, "utf8");
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("State v4 acceptance failed; inspect " + rawPath);
const expectedSkipped = process.platform === "win32" ? 0 : 1;
if (!/# suites 20(?:\r?\n|$)/.test(raw) || !/# fail 0(?:\r?\n|$)/.test(raw)
    || !(new RegExp(`# skipped ${expectedSkipped}(?:\\r?\\n|$)`).test(raw))) {
  throw new Error("Acceptance output is incomplete, failed, or skipped; inspect " + rawPath);
}
const filesystem = detectWindowsFilesystem(ac16Root);
const timestamp = new Date().toISOString();
const evidence = {
  schema_version: 1,
  contract: "Review Bridge State Contract v4",
  generated_at: timestamp,
  command,
  runtime: process.version,
  operating_system: `${os.type()} ${os.release()} ${process.arch}`,
  filesystem,
  raw_output: path.relative(packageRoot, rawPath).replaceAll("\\", "/"),
  acceptance: Array.from({ length: 20 }, (_, index) => {
    const id = "AC-" + String(index + 1).padStart(2, "0");
    return {
      id,
      primary_test: "review-bridge/tests/state-v4.acceptance.test.mjs",
      top_level_suite: id === "AC-15"
        ? "AC-15 / R7 unsafe synchronized or network storage fails preflight"
        : id === "AC-20"
          ? "AC-20 / R2 the same approved plan cannot start twice"
          : id,
      command,
      result: id === "AC-16" && process.platform !== "win32" ? "SKIP" : "PASS",
      timestamp,
      runtime: process.version,
      operating_system: `${os.type()} ${os.release()} ${process.arch}`,
      filesystem_type: id === "AC-16" ? filesystem.filesystem_type : null,
      volume: id === "AC-16" ? filesystem.volume : null,
      raw_output: path.relative(packageRoot, rawPath).replaceAll("\\", "/"),
    };
  }),
};
await fsp.writeFile(manifestPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  ok: true,
  suites: 20,
  skipped: expectedSkipped,
  evidence: path.relative(packageRoot, manifestPath).replaceAll("\\", "/"),
  raw_output: evidence.raw_output,
  filesystem,
}, null, 2) + "\n");
