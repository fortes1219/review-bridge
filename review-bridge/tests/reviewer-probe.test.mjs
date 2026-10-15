import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
import { buildProbeArgs, createReviewerProbeService, isFixedWriteAttempt, redactProbeText, runReviewerProbe } from "../core/reviewer-probe.mjs";

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
const ADAPTER_CONFIG = Object.freeze({ id: "win32-node", module: "platforms/win32-x64/adapter.mjs" });
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
  rateLimited: async () => ({ status: 1, timedOut: false, error: null, stdout: "", stderr: "429 Too Many Requests: rate limit" }),
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
  const { calls, wrapped } = counted(scenarios.denied);
  const unsupported = await runReviewerProbe({ provider: "claude", executable: "/claude", adapter, runner: wrapped });
  assert.equal(calls.length, 0);
  assert.equal(unsupported.proven, "unknown");
  assert.equal(unsupported.reason, "unsupported_provider");
});

async function service(t, { runner, version = () => "codex-cli 1.0.0", roles = { writer: "claude", reviewer: "codex" }, statusProbe = signedIn } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-probe-state-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const auditPath = path.join(dir, "reviewer-probe-audit.json");
  const adapterSource = path.join(dir, "adapter.mjs");
  const probeSource = path.join(dir, "reviewer-probe.mjs");
  await fsp.writeFile(adapterSource, "export const id = 1;\n");
  await fsp.writeFile(probeSource, "export const probe = 1;\n");
  return {
    auditPath,
    adapterSource,
    probeSource,
    make: (overrides = {}) => createReviewerProbeService({
      roles, adapter, adapterId: "win32-node", adapterConfig: ADAPTER_CONFIG,
      adapterSource, probeSource, auditPath, statusProbe, versionProbe: version, runner, ...overrides,
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
  const { make, auditPath } = await service(t, { runner: wrapped });
  const probe = make();
  await probe.run();
  const status = await probe.status();
  assert.equal(status.reviewer_readonly_proven, true);
  assert.equal(status.reviewer_readonly.authority, "watch_session_memory");
  const audit = JSON.parse(await fsp.readFile(auditPath, "utf8"));
  assert.equal(audit.authoritative, false);
  assert.doesNotMatch(JSON.stringify(audit), /secret-session|probe-bin/);
  assert.equal((await make().status()).reviewer_readonly_proven, "not_run", "restart is not_run");
  assert.equal(calls.length, 1);
});

test("editing the audit JSON from failed to proven cannot set readiness", async (t) => {
  const { wrapped } = counted(scenarios.refused);
  const { make, auditPath } = await service(t, { runner: wrapped });
  const probe = make();
  await probe.run();
  assert.equal((await probe.status()).reviewer_readonly_proven, false);
  const audit = JSON.parse(await fsp.readFile(auditPath, "utf8"));
  assert.equal(audit.proven, "unknown");
  await fsp.writeFile(auditPath, JSON.stringify({
    ...audit, schema_version: 1, authoritative: true, proven: true, reason: "sandbox_denied_write",
  }));
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
    fingerprints.push(JSON.parse(await fsp.readFile(env.auditPath, "utf8")).fingerprint);
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
  const { make, auditPath } = await service(t, { runner });
  const result = await make().run();
  // V2: this sentence is not a recognised denial in 甲段; the result stays unknown.
  assert.equal(result.proven, "unknown");
  assert.equal(result.reason, "denial_not_evidenced");
  const audit = JSON.parse(await fsp.readFile(auditPath, "utf8"));
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
