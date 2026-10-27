// The tests (T0-06): the one verification command a run will execute. It is chosen at
// compile time from the profile-approved rules the installer copied into bridge.json,
// sealed into the plan for the human to approve, re-checked at authorization, and run
// exactly as sealed after the writer finishes. No model takes part in any of it.
import fsp from "node:fs/promises";
import path from "node:path";

import { runProcess } from "../../service/index.mjs";

export const NOT_CONFIGURED_LABEL = "沒有設定測試";
export const TEST_TAIL_BYTES = 4 * 1024;
export const NPM_PLACEHOLDER = /no test specified/i;

export function testLabel(command) {
  return "跑現有測試：" + command;
}

async function exists(root, relative) {
  return await fsp.stat(path.join(root, relative)).then(() => true, () => false);
}

function rootGlobRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replaceAll("*", ".*").replaceAll("?", ".") + "$", "i");
}

async function rootGlobMatch(root, pattern) {
  const matcher = rootGlobRegex(pattern);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && matcher.test(entry.name)).map((entry) => entry.name);
}

// Every condition is a file check; the evidence names what was found, the reasons what was not.
export async function evaluateRule(repoRoot, rule, platform = process.platform) {
  const evidence = [];
  const reasons = [];
  if (rule.platform && rule.platform !== platform) reasons.push("只用於 " + rule.platform);
  if (Array.isArray(rule.platforms) && !rule.platforms.includes(platform)) reasons.push("只用於 " + rule.platforms.join("/"));
  if (Array.isArray(rule.files_any) && rule.files_any.length) {
    const found = [];
    for (const file of rule.files_any) if (await exists(repoRoot, file)) found.push(file);
    if (found.length) evidence.push(...found);
    else reasons.push("沒有 " + rule.files_any.join(" 或 "));
  }
  if (Array.isArray(rule.files_none) && rule.files_none.length) {
    for (const file of rule.files_none) if (await exists(repoRoot, file)) reasons.push("有 " + file + "，另一條優先");
  }
  if (Array.isArray(rule.root_globs_any) && rule.root_globs_any.length) {
    const found = [];
    for (const pattern of rule.root_globs_any) found.push(...(await rootGlobMatch(repoRoot, pattern)));
    if (found.length) evidence.push(...found);
    else reasons.push("根目錄沒有 " + rule.root_globs_any.join(" 或 "));
  }
  if (rule.package_script) {
    const manifest = await fsp.readFile(path.join(repoRoot, "package.json"), "utf8").then((text) => JSON.parse(text), () => null);
    const script = manifest?.scripts?.[rule.package_script];
    if (typeof script !== "string" || !script.trim()) reasons.push("package.json 沒有 scripts." + rule.package_script);
    else if (NPM_PLACEHOLDER.test(script)) reasons.push("scripts." + rule.package_script + " 還是 npm 的預設占位");
    else evidence.push("package.json scripts." + rule.package_script);
  }
  return { ok: reasons.length === 0, evidence, reasons };
}

// G2.1–G2.3: the first rule whose conditions hold is the test command, run after every writer call
// whatever the work changes. A project whose rules give none still starts, and every record says
// its tests are not configured, with what was checked; nothing is skipped silently.
export async function selectTest({ repoRoot, bridgeConfig, platform = process.platform }) {
  const rules = Array.isArray(bridgeConfig?.test?.rules) ? bridgeConfig.test.rules : [];
  const checked = [];
  for (const rule of rules) {
    if (typeof rule?.command !== "string" || !rule.command.trim()) continue;
    const result = await evaluateRule(repoRoot, rule, platform);
    if (result.ok) {
      return {
        kind: "command",
        command: rule.command,
        label: testLabel(rule.command),
        source: "profile:" + (bridgeConfig.test.profile_id || "unknown"),
        rule,
        evidence: result.evidence,
      };
    }
    checked.push({ command: rule.command, reasons: result.reasons });
  }
  return { kind: "not_configured", command: null, label: NOT_CONFIGURED_LABEL, checked };
}

// G2.5: the sealed rule must still hold when the human approves.
export async function recheckTest(repoRoot, test, platform = process.platform) {
  if (!test || test.kind !== "command") return { ok: true, reasons: [] };
  const result = await evaluateRule(repoRoot, test.rule, platform);
  return { ok: result.ok, reasons: result.reasons };
}

// The sealed string is handed to the platform shell as one line (node: cmd.exe /d /s /c on
// win32 with verbatim arguments, /bin/sh -c elsewhere); nothing is parsed or re-quoted here.
export function shellInvocation(command, env = process.env) {
  return { command, args: [], shell: true, env };
}

// Only the last 4 KB are read; a large test log never enters memory whole.
async function tail(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, TEST_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle) await handle.close();
  }
}

// G3.2–G3.3: run the sealed command string through the platform shell, in the repo root,
// with the sealed timeout; the result is an event, never a finding.
export async function runTest({ paths, test, stdoutPath, stderrPath, timeoutMs, onSpawn = null }) {
  if (!test || test.kind !== "command") {
    return { event: "test_result", kind: "not_configured", command: null, label: NOT_CONFIGURED_LABEL, passed: null };
  }
  // A missing or broken limit must not mean "no limit".
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("The tests have no valid time limit: " + timeoutMs);
  const startedAt = Date.now();
  // On timeout runProcess terminates the whole tree while the shell is alive (process.mjs).
  const result = await runProcess({
    invocation: shellInvocation(test.command),
    cwd: paths.repoRoot,
    stdoutPath,
    stderrPath,
    timeoutMs,
    onSpawn,
  });
  const passed = !result.timedOut && result.exitCode === 0;
  return {
    event: "test_result",
    kind: "command",
    command: test.command,
    label: test.label,
    exit_code: result.exitCode,
    timed_out: Boolean(result.timedOut),
    ...(result.tree_kill ? { tree_kill: result.tree_kill } : {}),
    duration_ms: Date.now() - startedAt,
    passed,
    stdout_tail: await tail(stdoutPath),
    stderr_tail: await tail(stderrPath),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
}

// G3.6: two failures in a row with the same delta mean the writer changed nothing.
export function sameDelta(previous, current) {
  const key = (entry) => entry.path + "@" + (entry.after_sha256 ?? "deleted");
  const a = new Set((previous || []).map(key));
  const b = new Set((current || []).map(key));
  return a.size === b.size && [...a].every((item) => b.has(item));
}
