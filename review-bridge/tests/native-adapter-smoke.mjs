import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJson } from "../core/io.mjs";
import { targetKey } from "../core/platform.mjs";
import { runProcess } from "../core/process.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readJson(path.join(bridgeRoot, "manifest.json"));
const target = targetKey(process.platform, process.arch);
const definition = manifest.adapters?.[target];

if (!definition?.module) {
  throw new Error("No adapter definition exists for native target " + target + ".");
}

const modulePath = path.resolve(bridgeRoot, definition.module);
const adapter = await import(pathToFileURL(modulePath).href);
for (const method of ["resolveExecutable", "buildInvocation", "notify"]) {
  if (typeof adapter[method] !== "function") {
    throw new Error("Adapter " + target + " is missing " + method + "().");
  }
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-native-smoke-"));
const results = {};
try {
  for (const kind of ["codex", "claude"]) {
    const executable = await adapter.resolveExecutable(kind);
    const invocation = adapter.buildInvocation(kind, executable, ["--version"]);
    const stdoutPath = path.join(tempRoot, kind + ".stdout.log");
    const stderrPath = path.join(tempRoot, kind + ".stderr.log");
    const result = await runProcess({
      invocation,
      cwd: os.homedir(),
      stdoutPath,
      stderrPath,
      timeoutMs: 15_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      const stderr = await fsp.readFile(stderrPath, "utf8").catch(() => "");
      throw new Error(kind + " --version failed: " + stderr.trim());
    }
    results[kind] = {
      executable,
      version: (await fsp.readFile(stdoutPath, "utf8")).trim(),
    };
  }

  process.stdout.write(JSON.stringify({
    valid: true,
    target,
    adapter: definition.id,
    manifest_status: definition.status,
    runtime_verified: definition.runtime_verified,
    cli: results,
    note: "This smoke does not call either model.",
  }, null, 2) + "\n");
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}
