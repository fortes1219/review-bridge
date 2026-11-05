// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
import { buildProbeArgs, createReviewerProbeService, isFixedWriteAttempt, redactProbeText, runReviewerProbe } from "../features/setupCheck/reviewerProbe.mjs";
import { localDateKey } from "../utils/dates.mjs";

const signedIn = (executable) => executable.endsWith("codex")
  ? { status: 0, stdout: "", stderr: "Logged in using ChatGPT\n" }
  : { status: 0, stdout: '{"loggedIn":true}', stderr: "" };
const adapter = {
  async resolveExecutable(provider) { return path.join(fakeBin, provider); },
  buildInvocation(_kind, command, args) { return { command, args, env: {} }; },
};
let fakeBin;

test.before(async () => {
  fakeBin = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-probe-bin-"));
  await fsp.writeFile(path.join(fakeBin, "codex"), "fake\n");
  await fsp.writeFile(path.join(fakeBin, "claude"), "fake\n");
});
test.after(() => fsp.rm(fakeBin, { recursive: true, force: true }));

function sentinelFrom(input) {
  return /(rb-sentinel-[0-9a-f-]+\.txt)/.exec(input)[1];
}

function commandEvent(command, exitCode, output) {
  return JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: exitCode, status: "failed", aggregated_output: output } });
}

const TURN_START = JSON.stringify({ type: "turn.started" });
const TURN_DONE = JSON.stringify({ type: "turn.completed", usage: {} });
const THREAD_START = JSON.stringify({ type: "thread.started", thread_id: "secret-session" });
const ADAPTER_CONFIG = Object.freeze({ id: "win32-node", module: "platforms/win32-x64/adapter.mjs", eligible: true });
const deniedCommand = (input) =>
  commandEvent(`bash -lc 'echo probe > ${sentinelFrom(input)}'`, 1, "bash: line 1: " + sentinelFrom(input) + ": Read-only file system");
const deniedStdout = (input) => [THREAD_START, TURN_START, deniedCommand(input), TURN_DONE].join("\n");
const ok = (stdout) => ({ status: 0, timedOut: false, error: null, stderr: "", stdout });

const scenarios = {
  denied: async ({ input }) => ok(deniedStdout(input)),
  deniedNonzeroExit: async ({ input }) => ({ ...ok(deniedStdout(input)), status: 1 }),
  deniedIncomplete: async ({ input }) => ok(commandEvent(`bash -lc 'echo probe > ${sentinelFrom(input)}'`, 1, "Read-only file system")),
  manufacturedDenial: async ({ input }) => ok([TURN_START,
    commandEvent(`cat /etc/shadow # ${sentinelFrom(input)}`, 1, "cat: /etc/shadow: Permission denied"), TURN_DONE].join("\n")),
  extraCommand: async ({ input }) => ok([TURN_START, commandEvent("ls /root", 2, "Permission denied"),
    commandEvent(`echo probe > ${sentinelFrom(input)}`, 1, "Read-only file system"), TURN_DONE].join("\n")),
  startedNotCompleted: async ({ input }) => ok([TURN_START,
    JSON.stringify({ type: "item.started", item: { id: "item_9", type: "command_execution", command: "rm -rf /tmp/x", status: "in_progress" } }),
    deniedCommand(input), TURN_DONE].join("\n")),
  unknownEventType: async ({ input }) => ok([TURN_START, JSON.stringify({ type: "exec.output", data: "anything" }),
    deniedCommand(input), TURN_DONE].join("\n")),
  unknownItemType: async ({ input }) => ok([TURN_START,
    JSON.stringify({ type: "item.completed", item: { id: "item_8", type: "mcp_tool_call", status: "completed" } }),
    deniedCommand(input), TURN_DONE].join("\n")),
  historicalTurnThenIncomplete: async ({ input }) => ok([THREAD_START, TURN_START, TURN_DONE, TURN_START, deniedCommand(input)].join("\n")),
  commandAfterCompletion: async ({ input }) => ok([THREAD_START, TURN_START, TURN_DONE, deniedCommand(input)].join("\n")),
  duplicateThreadStart: async ({ input }) => ok([THREAD_START, THREAD_START, TURN_START, deniedCommand(input), TURN_DONE].join("\n")),
  duplicateTurnStart: async ({ input }) => ok([TURN_START, TURN_START, deniedCommand(input), TURN_DONE].join("\n")),
  duplicateTurnCompletion: async ({ input }) => ok([TURN_START, deniedCommand(input), TURN_DONE, TURN_DONE].join("\n")),
  completionBeforeCommand: async ({ input }) => ok([TURN_START, TURN_DONE, deniedCommand(input)].join("\n")),
  missingTurnStart: async ({ input }) => ok([THREAD_START, deniedCommand(input), TURN_DONE].join("\n")),
  turnFailed: async ({ input }) => ok([TURN_START, deniedCommand(input), JSON.stringify({ type: "turn.failed", error: {} })].join("\n")),
  malformedLine: async ({ input }) => ok([TURN_START, "{not json", deniedCommand(input), TURN_DONE].join("\n")),
  unknownShape: async ({ input }) => ok([TURN_START,
    JSON.stringify({ kind: "exec", cmd: `echo probe > ${sentinelFrom(input)}`, out: "Read-only file system" }), TURN_DONE].join("\n")),
  refused: async () => ok([TURN_START, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I won't write files." } }), TURN_DONE].join("\n")),
  silentFailure: async ({ input }) => ok([TURN_START, commandEvent(`echo probe > ${sentinelFrom(input)}`, 1, "something went wrong"), TURN_DONE].join("\n")),
  writes: async ({ cwd, input }) => {
    await fsp.writeFile(path.join(cwd, sentinelFrom(input)), "probe\n");
    return { status: 0, timedOut: false, error: null, stderr: "", stdout: commandEvent(`echo probe > ${sentinelFrom(input)}`, 0, "") };
  },
  timeout: async () => ({ status: null, timedOut: true, error: null, stdout: "", stderr: "" }),
  // codex exec exits 1 after a failed turn; the quota is read from the typed event's message only.
  rateLimited: async () => ({ status: 1, timedOut: false, error: null, stderr: "",
    stdout: [THREAD_START, TURN_START, JSON.stringify({ type: "error", message: "stream error: exceeded retry limit, last status: 429 Too Many Requests" })].join("\n") }),
  turnFailedRateLimited: async () => ({ status: 1, timedOut: false, error: null, stderr: "",
    stdout: [TURN_START, JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } })].join("\n") }),
  // Text alone is not a quota stop: neither stderr words nor a 429 inside the stream.
  rateLimitTextOnly: async () => ({ status: 1, timedOut: false, error: null, stdout: "", stderr: "429 Too Many Requests: rate limit" }),
  deniedWith429Tokens: async ({ input }) => ok([THREAD_START, TURN_START, deniedCommand(input),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 429 } })].join("\n")),
};

function counted(runner) {
  const calls = [];
  const wrapped = async (request) => { calls.push(request); return runner(request); };
  return { calls, wrapped };
}

test("probe is proven only by attempted, sandbox-denied write with absent sentinel", async () => {
  const { calls, wrapped } = counted(scenarios.denied);
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner: wrapped });
  assert.equal(calls.length, 1);
  assert.equal(result.proven, true);
  assert.equal(result.reason, "sandbox_denied_write");
  assert.ok(calls[0].invocation.args.includes("read-only"));
  assert.equal(calls[0].invocation.args[calls[0].invocation.args.indexOf("--sandbox") + 1], "read-only");
  const evidence = JSON.stringify(result.evidence);
  assert.doesNotMatch(evidence, /secret-session|rb-sentinel-|review-bridge-probe-/);
  assert.equal(result.evidence.attempts[0].denial, "read_only_file_system");
  assert.equal(await fsp.stat(calls[0].cwd).catch(() => null), null, "probe directory is disposable");
});

test("refusal, unexplained failure, write, timeout, rate limit, and unsupported provider stay unproven", async () => {
  const expected = {
    refused: ["unknown", "no_write_attempt"],
    silentFailure: ["unknown", "denial_not_evidenced"],
    writes: [false, "write_allowed"],
    timeout: ["unknown", "timeout"],
    rateLimited: ["unknown", "rate_limited"],
    turnFailedRateLimited: ["unknown", "rate_limited"],
    rateLimitTextOnly: ["unknown", "invocation_error"],
    deniedNonzeroExit: ["unknown", "invocation_error"],
    deniedIncomplete: ["unknown", "incomplete_run"],
    manufacturedDenial: ["unknown", "ambiguous_output"],
    extraCommand: ["unknown", "ambiguous_output"],
    unknownShape: ["unknown", "ambiguous_output"],
    startedNotCompleted: ["unknown", "ambiguous_output"],
    unknownEventType: ["unknown", "ambiguous_output"],
    unknownItemType: ["unknown", "ambiguous_output"],
    historicalTurnThenIncomplete: ["unknown", "incomplete_run"],
    commandAfterCompletion: ["unknown", "incomplete_run"],
    duplicateThreadStart: ["unknown", "incomplete_run"],
    duplicateTurnStart: ["unknown", "incomplete_run"],
    duplicateTurnCompletion: ["unknown", "incomplete_run"],
    completionBeforeCommand: ["unknown", "incomplete_run"],
    missingTurnStart: ["unknown", "incomplete_run"],
    turnFailed: ["unknown", "incomplete_run"],
    malformedLine: ["unknown", "ambiguous_output"],
  };
  for (const [name, [proven, reason]] of Object.entries(expected)) {
    const { calls, wrapped } = counted(scenarios[name]);
    const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner: wrapped });
    assert.equal(calls.length, 1, name + " must make exactly one call without retry");
    assert.equal(result.proven, proven, name);
    assert.equal(result.reason, reason, name);
  }
  // A successful probe whose usage happens to hold 429 is not rate limited.
  const tokens = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner: scenarios.deniedWith429Tokens });
  assert.deepEqual([tokens.proven, tokens.reason], [true, "sandbox_denied_write"]);
  const { calls, wrapped } = counted(scenarios.denied);
  const unsupported = await runReviewerProbe({ provider: "claude", executable: "/claude", adapter, runner: wrapped });
  assert.equal(calls.length, 0);
  assert.equal(unsupported.proven, "unknown");
  assert.equal(unsupported.reason, "unsupported_provider");
});

async function service(t, { runner, version = () => "codex-cli 1.0.0", roles = { writer: "claude", reviewer: "codex" }, statusProbe = signedIn } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-probe-state-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const auditDir = path.join(dir, "reviewer-probe-audit");
  // T0-11 C3: one day file per local day, one line per check.
  const dayFile = (date = new Date()) => path.join(auditDir, localDateKey(date) + ".jsonl");
  const auditLines = async (date) => (await fsp.readFile(dayFile(date), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const latestAudit = async (date) => (await auditLines(date)).at(-1);
  const adapterSource = path.join(dir, "adapter.mjs");
  const probeSource = path.join(dir, "reviewer-probe.mjs");
  await fsp.writeFile(adapterSource, "export const id = 1;\n");
  await fsp.writeFile(probeSource, "export const probe = 1;\n");
  return {
    auditDir,
    dayFile,
    auditLines,
    latestAudit,
    adapterSource,
    probeSource,
    make: (overrides = {}) => createReviewerProbeService({
      roles, adapter, adapterId: "win32-node", adapterConfig: ADAPTER_CONFIG,
      adapterSource, probeSource, auditDir, statusProbe, versionProbe: version, runner, ...overrides,
    }),
  };
}

test("one click is one call, in-flight clicks are rejected, and a proof opens the proof half of native readiness", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, wrapped } = counted(async (request) => { await gate; return scenarios.denied(request); });
  const { make } = await service(t, { runner: wrapped });
  const probe = make();
  const first = probe.run();
  await assert.rejects(probe.run(), (error) => error.code === "in_flight");
  release();
  const result = await first;
  assert.equal(result.proven, true);
  assert.equal(calls.length, 1);
  const status = await probe.status();
  assert.equal(status.reviewer_readonly_proven, true);
  // T0-08 N7: the proof is the page's half; work-start still needs an interactive terminal confirmation.
  assert.equal(status.native_ready, true);
  assert.equal(status.native_blocked_reason, null);
  assert.equal(calls.length, 1, "status refresh does not invoke the model");
});

test("failed probe is not retried automatically", async (t) => {
  const { calls, wrapped } = counted(scenarios.timeout);
  const { make } = await service(t, { runner: wrapped });
  const result = await make().run();
  assert.equal(result.proven, "unknown");
  assert.equal(calls.length, 1);
});

test("proof is held only in watch memory; a new service starts not_run", async (t) => {
  const { calls, wrapped } = counted(scenarios.denied);
  const { make, latestAudit } = await service(t, { runner: wrapped });
  const probe = make();
  await probe.run();
  const status = await probe.status();
  assert.equal(status.reviewer_readonly_proven, true);
  assert.equal(status.reviewer_readonly.authority, "watch_session_memory");
  const audit = await latestAudit();
  assert.equal(audit.authoritative, false);
  assert.doesNotMatch(JSON.stringify(audit), /secret-session|probe-bin/);
  assert.equal((await make().status()).reviewer_readonly_proven, "not_run", "restart is not_run");
  assert.equal(calls.length, 1);
});

test("editing the audit JSON from failed to proven cannot set readiness", async (t) => {
  const { wrapped } = counted(scenarios.refused);
  const { make, latestAudit, dayFile } = await service(t, { runner: wrapped });
  const probe = make();
  await probe.run();
  assert.equal((await probe.status()).reviewer_readonly_proven, false);
  const audit = await latestAudit();
  assert.equal(audit.proven, "unknown");
  await fsp.writeFile(dayFile(), JSON.stringify({
    ...audit, schema_version: 1, authoritative: true, proven: true, reason: "sandbox_denied_write",
  }) + "\n");
  assert.equal((await probe.status()).reviewer_readonly_proven, false, "running service ignores the file");
  const fresh = await make().status();
  assert.equal(fresh.reviewer_readonly_proven, "not_run", "new service ignores the file");
  assert.notEqual(fresh.reviewer_readonly.state, "proven");
});

test("in-memory proof becomes stale after role, CLI, adapter, probe or sandbox change", async (t) => {
  const { calls, wrapped } = counted(scenarios.denied);
  const env = await service(t, { runner: wrapped });
  let version = "codex-cli 1.0.0";
  const roles = { writer: "claude", reviewer: "codex" };
  const probe = env.make({ versionProbe: () => version, roles });
  await probe.run();
  assert.equal((await probe.status()).reviewer_readonly_proven, true);
  const expectStale = async (label) => {
    const status = await probe.status();
    assert.equal(status.reviewer_readonly.state, "stale", label);
    assert.equal(status.reviewer_readonly_proven, false, label);
  };
  const expectProven = async (label) => assert.equal((await probe.status()).reviewer_readonly_proven, true, label);
  version = "codex-cli 2.0.0";
  await expectStale("cli version");
  version = "codex-cli 1.0.0";
  await expectProven("restored version");
  roles.writer = "codex";
  await expectStale("roles");
  roles.writer = "claude";
  await fsp.writeFile(env.adapterSource, "export const id = 1; // changed\n");
  await expectStale("adapter source with unchanged id");
  await fsp.writeFile(env.adapterSource, "export const id = 1;\n");
  await expectProven("restored adapter");
  await fsp.writeFile(env.probeSource, "export const probe = 2;\n");
  await expectStale("probe source");
  await fsp.writeFile(env.probeSource, "export const probe = 1;\n");
  await expectProven("restored probe");
  await fsp.writeFile(path.join(fakeBin, "codex"), "fake cli replaced\n");
  await expectStale("cli identity");
  await fsp.writeFile(path.join(fakeBin, "codex"), "fake\n");
  version = null;
  await expectStale("unknown cli version");
  assert.equal(calls.length, 1, "status refresh never calls the model");
});

test("adapter id, adapter config and sandbox arguments are bound into the fingerprint", async (t) => {
  const { wrapped } = counted(scenarios.denied);
  const env = await service(t, { runner: wrapped });
  const fingerprints = [];
  for (const overrides of [{}, { adapterConfig: { ...ADAPTER_CONFIG, status: "candidate" } }, { adapterId: "other" }]) {
    await env.make(overrides).run();
    fingerprints.push((await env.latestAudit()).fingerprint);
  }
  assert.equal(new Set(fingerprints).size, 3);
  assert.equal(buildProbeArgs("codex", "<d>")[buildProbeArgs("codex", "<d>").indexOf("--sandbox") + 1], "read-only");
});

test("unsupported reviewer cannot start a model call and the button is disabled", async (t) => {
  const { calls, wrapped } = counted(scenarios.denied);
  const { make } = await service(t, { runner: wrapped, roles: { writer: "codex", reviewer: "claude" } });
  const probe = make();
  const status = await probe.status();
  assert.equal(status.probe_supported, false);
  assert.equal(status.probe_available, false);
  await assert.rejects(probe.run(), (error) => error.code === "unsupported_reviewer");
  assert.equal(calls.length, 0);
});

test("only the fixed sentinel write is recognised as an attempt", () => {
  const name = "rb-sentinel-0000.txt";
  for (const command of [`echo probe > ${name}`, `bash -lc 'echo probe > ${name}'`, `/bin/bash -lc "echo probe > ./${name}"`,
    `"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command 'echo probe > ${name}'`]) {
    assert.equal(isFixedWriteAttempt(command, name), true, command);
  }
  for (const command of [`cat /etc/shadow # ${name}`, `echo probe > ${name}; rm -rf x`, `touch ${name}`,
    `bash -lc 'echo probe > ${name}' && ls`, `echo probe > other-${name}`]) {
    assert.equal(isFixedWriteAttempt(command, name), false, command);
  }
});

test("reviewer that is not signed in is rejected before any model call", async (t) => {
  const { calls, wrapped } = counted(scenarios.denied);
  const { make } = await service(t, {
    runner: wrapped,
    statusProbe: () => ({ status: 1, stdout: "", stderr: "Not logged in\n" }),
  });
  await assert.rejects(make().run(), (error) => error.code === "reviewer_not_ready");
  const unknown = await service(t, { runner: wrapped, statusProbe: () => { throw new Error("no status"); } });
  await assert.rejects(unknown.make().run(), (error) => error.code === "reviewer_not_ready");
  assert.equal(calls.length, 0);
});

// T0-11 甲段: what the 2026-10-15 dogfood probe may have looked like, with real paths in it.
function windowsDenial(cwd, sentinel) {
  const target = path.join(cwd, sentinel);
  return "Out-File : Access to the path '" + target + "' is denied.\n"
    + "At line:1 char:1\n+ echo probe > " + sentinel + "\n"
    + "    + CategoryInfo          : OpenError: (" + target + ":String) [Out-File], UnauthorizedAccessException\n";
}

test("T0-11 V1/V2 the audit keeps a redacted excerpt and hash of the fixed write's output; the decision is unchanged", async (t) => {
  const raw = {};
  const homeFile = path.join(os.homedir(), "secret folder", "notes.txt");
  const runner = async ({ cwd, input }) => {
    const sentinel = sentinelFrom(input);
    raw.output = windowsDenial(cwd, sentinel) + "See '" + homeFile + "'.\n";
    raw.cwd = cwd;
    raw.sentinel = sentinel;
    return ok([THREAD_START, TURN_START,
      commandEvent(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'echo probe > ${sentinel}'`, 1, raw.output),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "MODEL-REPLY-TEXT" } }),
      TURN_DONE].join("\n"));
  };
  const { make, latestAudit } = await service(t, { runner });
  const result = await make().run();
  // PowerShell's own denial sentence is recognised (Owner 2026-10-25, with its Chinese form).
  assert.equal(result.proven, true);
  assert.equal(result.reason, "sandbox_denied_write");
  const audit = await latestAudit();
  const [attempt] = audit.evidence.attempts;
  assert.match(attempt.output_excerpt, /^Out-File : Access to the path '<sentinel-path>' is denied\.\nAt line:1 char:1\n\+ echo probe > <sentinel-path>\n/);
  assert.ok(attempt.output_excerpt.length <= 400);
  assert.equal(attempt.output_truncated, false);
  assert.equal(attempt.output_sha256, createHash("sha256").update(raw.output).digest("hex"));
  assert.equal(attempt.command, "\"<path>\" -Command 'echo probe > <sentinel-path>'");
  const text = JSON.stringify(audit);
  for (const leak of [raw.cwd, raw.sentinel, os.homedir(), "secret folder", "Program Files", "PowerShell", "MODEL-REPLY-TEXT", "review-bridge-probe-"]) {
    assert.equal(text.toLowerCase().includes(leak.toLowerCase().replaceAll("\\", "\\\\")), false, "audit must not contain " + leak);
  }
  assert.deepEqual(audit.evidence.events, { commands: 1, file_changes: 0, unknown: 0 });
});

test("T0-11 V1 only the fixed write's output is kept; another command's output is not", async () => {
  const runner = async ({ cwd, input }) => ok([TURN_START,
    commandEvent("dir", 1, "OTHER-COMMAND-OUTPUT"),
    commandEvent(`echo probe > ${sentinelFrom(input)}`, 1, windowsDenial(cwd, sentinelFrom(input))),
    TURN_DONE].join("\n"));
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner });
  assert.equal(result.reason, "ambiguous_output");
  assert.equal(result.evidence.attempts.length, 1);
  assert.doesNotMatch(JSON.stringify(result.evidence), /OTHER-COMMAND-OUTPUT/);
  assert.deepEqual(result.evidence.events, { commands: 2, file_changes: 0, unknown: 0 });
});

test("T0-11 V1 an output longer than the excerpt is marked truncated, so 第 3 關 can stop on it", async () => {
  const runner = async ({ cwd, input }) => ok([TURN_START,
    commandEvent(`echo probe > ${sentinelFrom(input)}`, 1, windowsDenial(cwd, sentinelFrom(input)) + "x".repeat(600)),
    TURN_DONE].join("\n"));
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner });
  const [attempt] = result.evidence.attempts;
  assert.equal(attempt.output_excerpt.length, 400);
  assert.equal(attempt.output_truncated, true);
  assert.equal(result.reason, "sandbox_denied_write");
});

// The Owner's check RBP-581A77E0 on a Chinese Windows: exit 1, no sentinel, PowerShell's denial.
function powershellDenialEvent(input, output) {
  return ok([THREAD_START, TURN_START,
    commandEvent(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'echo probe > ${sentinelFrom(input)}'`, 1, output),
    TURN_DONE].join("\n"));
}

test("a Chinese Windows denial 「對路徑 '…' 的存取被拒」 with exit 1 and no sentinel is sandbox_denied_write", async () => {
  for (const sentence of ["對路徑 '{p}' 的存取被拒。", "拒絕存取路徑 '{p}'。", "out-file : 拒絕存取權。"]) {
    const runner = async ({ cwd, input }) => powershellDenialEvent(input,
      "out-file : " + sentence.replace("{p}", path.join(cwd, sentinelFrom(input))) + "\r\n位於 線路:1 字元:1\r\n");
    const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner });
    assert.equal(result.proven, true, sentence);
    assert.equal(result.reason, "sandbox_denied_write", sentence);
    assert.equal(result.evidence.attempts[0].denial, "access_denied");
  }
});

// What codex really returned on that machine: the profile's error first, then the denial, both in
// CP950 read as UTF-8; only PowerShell's ASCII error name is left readable.
test("a denial whose text arrived broken is recognised by PowerShell's UnauthorizedAccessException line", async () => {
  const broken = "������";
  const runner = async ({ cwd, input }) => powershellDenialEvent(input, [
    path.join(os.homedir(), "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1") + " : " + broken,
    "    + CategoryInfo          : InvalidOperation: (:) [Microsoft.PowerShell_profile.ps1]" + broken + "NotSupportedException",
    "out-file : " + broken + " '" + path.join(cwd, sentinelFrom(input)) + "'" + broken,
    "    + CategoryInfo          : OpenError: (:) [Out-File], UnauthorizedAccessException",
    "    + FullyQualifiedErrorId : FileOpenFailure,Microsoft.PowerShell.Commands.OutFileCommand",
  ].join("\r\n"));
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner });
  assert.equal(result.proven, true);
  assert.equal(result.reason, "sandbox_denied_write");
});

test("a broken denial text without the error name is still not evidence", async () => {
  const runner = async ({ cwd, input }) => powershellDenialEvent(input, "out-file : �� '" + path.join(cwd, sentinelFrom(input)) + "'�");
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner });
  assert.equal(result.proven, "unknown");
  assert.equal(result.reason, "denial_not_evidenced");
});

test("T0-11 V3 with no write command the audit keeps only the reason and event counts, no text", async () => {
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter, runner: scenarios.refused });
  assert.equal(result.reason, "no_write_attempt");
  assert.deepEqual(result.evidence.events, { commands: 0, file_changes: 0, unknown: 0 });
  assert.equal(result.evidence.attempts, undefined);
  assert.doesNotMatch(JSON.stringify(result.evidence), /won't write/);
});

test("T0-11 A2 paths with spaces, quotes, apostrophes, wraps or no quotes leave no fragment", () => {
  const probeDir = "C:\\Users\\Someone\\AppData\\Local\\Temp\\review-bridge-probe-AbC123";
  const sentinelName = "rb-sentinel-11111111-2222-3333-4444-555555555555.txt";
  const home = "C:\\Users\\Someone";
  const r = (text) => redactProbeText(text, { probeDir, sentinelName, home });
  // The probe's own target, in any case or slash, stays recognisable.
  assert.equal(r("Access to the path '" + probeDir + "\\" + sentinelName + "' is denied."), "Access to the path '<sentinel-path>' is denied.");
  assert.equal(r("open '" + (probeDir + "/" + sentinelName).toLowerCase().replaceAll("\\", "/") + "' failed"), "open '<sentinel-path>' failed");
  assert.equal(r("bash: " + sentinelName + ": Read-only file system"), "bash: <sentinel-path>: Read-only file system");
  const cases = [
    ["Access to the path 'D:\\Program Files\\My App\\data.txt' is denied.", "Access to the path '<path>' is denied.", ["Program", "Files", "My App", "data"]],
    ["Access to the path 'D:\\Users\\O'Brien\\file.txt' is denied.", "Access to the path '<path>' is denied.", ["Brien", "file"]],
    ["Access to the path 'D:\\very\\long\\fol\nder\\x.txt' is denied.", "Access to the path '<path>' is denied.", ["der", "fol", "long"]],
    ["Access to the path \"E:\\a b\\c\" is denied.", "Access to the path \"<path>\" is denied.", ["a b"]],
    ["Access to the path \u2018F:\\x y\\z\u2019 is denied.", "Access to the path \u2018<path>\u2019 is denied.", ["x y"]],
    ["cannot open D:\\My Docs\\x.txt now", "cannot open <path>", ["Docs", "now"]],
    ["denied: '\\\\server\\share\\dir\\f.txt'.", "denied: '<path>'.", ["server", "share"]],
    ["bash: /home/someone/x y/z: Read-only file system", "bash: <path>", ["someone", "x y"]],
    ["see 'C:\\Users\\Someone\\Desktop\\a.txt' and C:\\Users\\Someone\\My Docs\\b", "see '<path>' and <path>", ["Desktop", "My Docs"]],
    ["\u001b[31mred\u001b[0m\u0007 text\r\nnext", "red text\nnext", []],
  ];
  // Case 8: the home folder goes first; what is left of a path after it is still a path and goes too.
  for (const [input, expected, absent] of cases) {
    const out = r(input);
    assert.equal(out, expected, input);
    for (const piece of absent) assert.equal(out.includes(piece), false, piece + " leaked from " + JSON.stringify(input));
  }
  // Codex 2026-10-15: an apostrophe followed by a space inside a quoted path is not its end.
  for (const input of [
    "Access to the path 'D:\\Users\\O' Brien\\secret.txt' is denied.",
    "Access to the path 'D:\\Users\\O' Brien\\sec\nret.txt' is denied.",
    "Access to the path 'D:\\a\\b' c\\d' is denied.\nAt line:1 char:1",
  ]) {
    const out = r(input);
    for (const piece of ["Brien", "secret", "sec", "ret.txt", "c\\d", "\\d"]) assert.equal(out.includes(piece), false, piece + " leaked from " + JSON.stringify(input) + " as " + JSON.stringify(out));
    assert.match(out, /^Access to the path '<path>/);
  }
  // A sentinel path broken by a wrap is still replaced whole, without a fragment of the folder.
  const wrapped = r("Access to the path '" + probeDir.slice(0, 30) + "\n" + probeDir.slice(30) + "\\" + sentinelName + "' is denied.");
  assert.equal(wrapped, "Access to the path '<path>…<sentinel-path>' is denied.");
  assert.equal(r("x".repeat(500)).length, 400);
});

// T0-11 甲 2 D3 / D4: a diagnostic id per check, records gathered per day, release only from memory.
test("T0-11 D3 two checks on one day: two ids, one day file with two lines; status gives the latest from memory", async (t) => {
  const { make, auditLines, dayFile, auditDir } = await service(t, { runner: scenarios.silentFailure });
  const probe = make();
  const first = await probe.run();
  const second = await probe.run();
  assert.match(first.diagnostic_id, /^RBP-[0-9A-F]{8}$/);
  assert.notEqual(first.diagnostic_id, second.diagnostic_id);
  assert.deepEqual((await fsp.readdir(auditDir)).sort(), [path.basename(dayFile())]);
  assert.deepEqual((await auditLines()).map((line) => line.diagnostic_id), [first.diagnostic_id, second.diagnostic_id]);
  const status = await probe.status();
  assert.equal(status.reviewer_readonly.state, "unknown");
  assert.equal(status.reviewer_readonly.diagnostic_id, second.diagnostic_id);
  assert.equal(status.reviewer_readonly.cli_launches, 1);
});

test("T0-11 D3 a new record deletes day files older than the retention window and keeps the rest", async (t) => {
  const day = 86_400_000;
  const clock = new Date(2026, 9, 15, 12, 0, 0);
  const { make, auditDir } = await service(t, { runner: scenarios.silentFailure });
  await fsp.mkdir(auditDir, { recursive: true });
  const old = localDateKey(new Date(clock.getTime() - 16 * day)) + ".jsonl";
  const recent = localDateKey(new Date(clock.getTime() - 14 * day)) + ".jsonl";
  await fsp.writeFile(path.join(auditDir, old), "{}\n");
  await fsp.writeFile(path.join(auditDir, recent), "{}\n");
  await make({ now: () => clock, retentionDays: 15 }).run();
  assert.deepEqual((await fsp.readdir(auditDir)).sort(), [recent, localDateKey(clock) + ".jsonl"].sort());
});

test("T0-11 D4 editing or deleting the day file changes nothing; a new service starts not_run with no id", async (t) => {
  const { make, dayFile, latestAudit } = await service(t, { runner: scenarios.silentFailure });
  const probe = make();
  await probe.run();
  const before = await probe.status();
  const audit = await latestAudit();
  await fsp.writeFile(dayFile(), JSON.stringify({ ...audit, proven: true, reason: "sandbox_denied_write", diagnostic_id: "RBP-00000000" }) + "\n");
  assert.deepEqual(await probe.status(), before);
  await fsp.rm(dayFile());
  assert.deepEqual(await probe.status(), before);
  assert.equal(before.native_ready, false);
  const fresh = (await make().status()).reviewer_readonly;
  assert.equal(fresh.state, "not_run");
  assert.equal(fresh.diagnostic_id, null);
  assert.equal(fresh.cli_launches, null);
});

// T0-11 甲 3 E1: where a failure happened decides what is known about the model call.
test("T0-11 E1 a failure before the CLI starts is probe_not_started with no call and no change in memory", async (t) => {
  const missingRoot = path.join(os.tmpdir(), "rb-probe-missing-" + process.pid, "nope");
  const { calls, wrapped } = counted(scenarios.denied);
  const { make } = await service(t, { runner: wrapped });
  const probe = make({ tmpRoot: missingRoot });
  await assert.rejects(probe.run(), (error) => error.code === "probe_not_started");
  assert.equal(calls.length, 0);
  assert.equal((await probe.status()).reviewer_readonly.state, "not_run");
});

test("T0-11 E1 a failure after the CLI started is an unknown result with one recorded call", async (t) => {
  const runner = async ({ cwd, input }) => {
    const result = ok(deniedStdout(input));
    await fsp.rm(cwd, { recursive: true, force: true });
    return result;
  };
  const { make } = await service(t, { runner });
  const probe = make();
  const result = await probe.run();
  assert.equal(result.reason, "probe_error_after_start");
  const readonly = (await probe.status()).reviewer_readonly;
  assert.equal(readonly.state, "unknown");
  assert.equal(readonly.cli_launches, 1);
});

test("T0-11 E1 a runner that throws leaves the call count unknown", async (t) => {
  const { make } = await service(t, { runner: async () => { throw new Error("runner broke"); } });
  const probe = make();
  assert.equal((await probe.run()).reason, "probe_error_unclear");
  assert.equal((await probe.status()).reviewer_readonly.cli_launches, null);
});

test("T0-11 E1 a CLI that never started counts as zero calls", async () => {
  const missing = { ...adapter, buildInvocation: () => ({ command: path.join(os.tmpdir(), "rb-no-such-cli-" + process.pid + ".exe"), args: [], env: {} }) };
  const result = await runReviewerProbe({ provider: "codex", executable: "/codex", adapter: missing });
  assert.equal(result.reason, "invocation_error");
  assert.equal(result.cli_launches, 0);
});

test("T0-11 E2 when the record cannot be written the status carries no diagnostic id", async (t) => {
  const { make, auditDir } = await service(t, { runner: scenarios.silentFailure });
  await fsp.mkdir(path.dirname(auditDir), { recursive: true });
  await fsp.writeFile(auditDir, "a file where the folder should be\n");
  const probe = make();
  const result = await probe.run();
  assert.equal(result.diagnostic_id, null);
  assert.equal(result.audit_recorded, false);
  const readonly = (await probe.status()).reviewer_readonly;
  assert.equal(readonly.state, "unknown");
  assert.equal(readonly.diagnostic_id, null);
  assert.equal(readonly.audit_recorded, false);
});

test("T0-11 E3 an invalid retention setting cleans nothing; a valid one also retires the old single file", async (t) => {
  const day = 86_400_000;
  const clock = new Date(2026, 9, 16, 12, 0, 0);
  const { make, auditDir } = await service(t, { runner: scenarios.silentFailure });
  await fsp.mkdir(auditDir, { recursive: true });
  const oldDay = path.join(auditDir, localDateKey(new Date(clock.getTime() - 16 * day)) + ".jsonl");
  const legacy = path.join(path.dirname(auditDir), "reviewer-probe-audit.json");
  await fsp.writeFile(oldDay, "{}\n");
  await fsp.writeFile(legacy, "{}\n");
  const oldTime = new Date(clock.getTime() - 16 * day);
  await fsp.utimes(legacy, oldTime, oldTime);
  const invalid = make({ now: () => clock, retentionDays: null });
  await invalid.run();
  assert.equal((await invalid.status()).reviewer_readonly.audit_cleanup, "skipped_invalid_retention");
  assert.ok(await fsp.stat(oldDay), "nothing cleaned with an invalid setting");
  assert.ok(await fsp.stat(legacy));
  const recent = new Date(clock.getTime() - 14 * day);
  const valid = make({ now: () => clock, retentionDays: 15 });
  await valid.run();
  assert.equal((await valid.status()).reviewer_readonly.audit_cleanup, "done");
  assert.equal(await fsp.stat(oldDay).catch(() => null), null);
  assert.equal(await fsp.stat(legacy).catch(() => null), null, "the old single file is retired by age too");
  await fsp.writeFile(legacy, "{}\n");
  await fsp.utimes(legacy, recent, recent);
  await valid.run();
  assert.ok(await fsp.stat(legacy), "a recent old single file stays");
});

test("A4 a CLI that started but got no model result counts one launch, not a proven model call", async (t) => {
  // The CLI ran and exited without any event: e.g. a quota or sign-in failure before a model answered.
  const runner = async () => ({ status: 1, timedOut: false, error: null, stdout: "", stderr: "quota exceeded", started: true });
  const { make } = await service(t, { runner });
  const probe = make();
  const result = await probe.run();
  assert.equal(result.cli_launches, 1);
  assert.equal(Object.hasOwn(result, "model_calls"), false);
  const readonly = (await probe.status()).reviewer_readonly;
  assert.equal(readonly.state, "unknown");
  assert.equal(readonly.cli_launches, 1);
});

test("A4 an identity that cannot be computed is fingerprint_unavailable, not configuration_changed", async (t) => {
  let version = "codex-cli 1.0.0";
  const env = await service(t, { runner: scenarios.denied });
  const probe = env.make({ versionProbe: () => version });
  await probe.run();
  version = null;
  const unreadable = (await probe.status()).reviewer_readonly;
  assert.equal(unreadable.state, "stale");
  assert.equal(unreadable.reason, "fingerprint_unavailable");
  version = "codex-cli 2.0.0";
  assert.equal((await probe.status()).reviewer_readonly.reason, "configuration_changed");
});

// RC3-LINUX-00: only an adapter the manifest marks active or candidate may start the check. The fake
// adapter, an experimental one, and a definition without eligibility never may, so a page started
// with any of them cannot hold a proof a native work-start would accept, even with the reviewer CLI
// present and signed in.
test("an adapter that is not eligible cannot start the check, and its button is closed from the start", async (t) => {
  for (const [adapterConfig, platformStatus] of [
    [{ target: "portable-fake", id: "portable-fake-cli", status: "fake", eligible: false }, "fake"],
    [{ ...ADAPTER_CONFIG, status: "experimental", eligible: false }, "experimental"],
    [{ id: ADAPTER_CONFIG.id, module: ADAPTER_CONFIG.module }, "unsupported"],
  ]) {
    const { calls, wrapped } = counted(scenarios.denied);
    const { make } = await service(t, { runner: wrapped });
    const probe = make({ adapterConfig });
    const before = await probe.status();
    assert.equal(before.checks.reviewer.cli_present, true);
    assert.equal(before.checks.reviewer.authenticated, true);
    assert.equal(before.probe_available, false, platformStatus);
    assert.equal(before.platform_eligible, false);
    assert.equal(before.platform_status, platformStatus);
    await assert.rejects(probe.run(), (error) => error.code === "adapter_not_verified");
    assert.equal(calls.length, 0, "no reviewer CLI was started");
    const after = await probe.status();
    assert.equal(after.reviewer_readonly_proven, "not_run");
    assert.equal(after.native_ready, false);
  }
});
