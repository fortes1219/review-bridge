import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJson, readJson } from "../core/io.mjs";
import { targetKey } from "../core/platform.mjs";
import { runProcess } from "../core/process.mjs";

const confirmationFlag = "--confirm-live-model-calls";
const maxBudgetUsdPerCall = 0.25;
if (!process.argv.slice(2).includes(confirmationFlag)) {
  throw new Error(
    "This smoke makes exactly two live Claude model calls. Re-run with "
      + confirmationFlag + " after approving that usage.",
  );
}

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readJson(path.join(bridgeRoot, "manifest.json"));
const target = targetKey(process.platform, process.arch);
const definition = manifest.adapters?.[target];

if (!definition?.module) {
  throw new Error("No adapter definition exists for native target " + target + ".");
}

const modulePath = path.resolve(bridgeRoot, definition.module);
const adapter = await import(pathToFileURL(modulePath).href);
const claude = await adapter.resolveExecutable("claude");
const sessionId = crypto.randomUUID();
const nonce = "RB_" + crypto.randomBytes(12).toString("hex").toUpperCase();
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-live-claude-smoke-"));

async function invoke(label, sessionArgs, prompt) {
  const stdoutPath = path.join(tempRoot, label + ".stdout.json");
  const stderrPath = path.join(tempRoot, label + ".stderr.log");
  const args = [
    "-p",
    ...sessionArgs,
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--effort", "low",
    "--output-format", "json",
    "--max-budget-usd", String(maxBudgetUsdPerCall),
  ];
  const invocation = adapter.buildInvocation("claude", claude, args);
  const processResult = await runProcess({
    invocation,
    cwd: tempRoot,
    input: prompt,
    stdoutPath,
    stderrPath,
    timeoutMs: 120_000,
  });
  const stdout = await fsp.readFile(stdoutPath, "utf8").catch(() => "");
  const stderr = await fsp.readFile(stderrPath, "utf8").catch(() => "");
  if (processResult.timedOut) {
    throw new Error(label + " timed out after 120 seconds.");
  }
  if (!stdout.trim()) {
    throw new Error(
      label + " returned no JSON output (exit " + processResult.exitCode + "): " + stderr.trim(),
    );
  }
  let result;
  try {
    result = parseJson(stdout);
  } catch (error) {
    throw new Error(
      label + " returned invalid JSON (exit " + processResult.exitCode + "): " + error.message,
    );
  }
  if (processResult.exitCode !== 0 || result.is_error === true) {
    throw new Error(
      label + " failed with exit " + processResult.exitCode
        + ", subtype " + String(result.subtype || "unknown")
        + ": " + String(result.result || stderr || "unknown Claude error").trim(),
    );
  }
  if (String(result.session_id || "") !== sessionId) {
    throw new Error(label + " session ID drifted from the requested UUID.");
  }
  return result;
}

try {
  const first = await invoke(
    "first-session-id",
    ["--session-id", sessionId],
    "Remember this nonce for the next turn: " + nonce
      + ". Reply with exactly FIRST_OK and do not use tools.",
  );
  if (String(first.result || "").trim() !== "FIRST_OK") {
    throw new Error("The --session-id call returned an unexpected response.");
  }

  const resumed = await invoke(
    "second-resume",
    ["--resume", sessionId],
    "Reply with exactly the nonce I asked you to remember in the previous turn. Do not use tools.",
  );
  if (String(resumed.result || "").trim() !== nonce) {
    throw new Error("The --resume call did not recover the prior-turn nonce.");
  }

  process.stdout.write(JSON.stringify({
    valid: true,
    target,
    adapter: definition.id,
    manifest_status: definition.status,
    claude_executable: claude,
    session_id_preserved: true,
    resumed_context_verified: true,
    live_model_calls: 2,
    safety: {
      safe_mode: true,
      tools_disabled: true,
      temporary_working_directory: true,
      max_budget_usd_per_call: maxBudgetUsdPerCall,
    },
  }, null, 2) + "\n");
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}
