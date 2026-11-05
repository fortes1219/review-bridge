// The four pairings of writer and reviewer (RC3-BLOCKER-02), each run from a real plan through the
// fake CLIs, which log every call. Which CLI each step reached, what it was told and what the run's
// records say are read from there and from the database, not from what Bridge says it did.
import { dataHome, queryRecords } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergePolicy } from "../policy/policyRules.mjs";
import { callRole, RoleCliNotReadyError, settleMcp } from "../service/index.mjs";
import { readIoEvents } from "../service/records/ioEvents.mjs";
import { readJson } from "../service/records/fileStore.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { latestResultCopy } from "./fixtures/resultCopies.mjs";

const runtimeSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtimeSource, "..");
const fixtures = path.join(runtimeSource, "tests", "fixtures");

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const BODY = [
  "# Work order: farm",
  "",
  "<!-- bridge:requested_work -->",
  "Build a small farm.",
  "",
  "<!-- bridge:acceptance -->",
  "- The farm is visible.",
].join("\n") + "\n";

async function install(t, writer, reviewer) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-roles-"));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", writer, "--reviewer", reviewer, "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const callLog = path.join(root, "calls.jsonl");
  const bridge = (args, env = {}) => spawnSync(process.execPath, [path.join(runtimeSource, "bootstrap.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, FAKE_CALL_LOG: callLog, ...env },
  });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const calls = async () => (await fsp.readFile(callLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { root, bridge, calls, paths: getBridgePaths(root, runtimeSource, { privateRootName: ".review-bridge" }) };
}

async function plan(rt, text = BODY, extra = [], name = "farm", env = {}) {
  const order = ".review-bridge/work-packages/" + name + ".md";
  await fsp.writeFile(path.join(rt.root, order), text);
  const planPath = path.join(rt.root, ".review-bridge", name + "-" + Math.random().toString(16).slice(2, 8) + ".plan.json");
  const planned = rt.bridge(["work-plan", order, "--fake-cli", "--breakpoint", "after the review", "--rounds", "1", "--call-timeout", "120000", "--out", planPath, ...extra], env);
  return { planned, order, planPath, plan: planned.status === 0 ? await readJson(planPath) : null };
}

const start = (rt, work, env = {}) => rt.bridge(["work-start", "--plan", work.planPath, "--approve", work.plan.plan_sha256, "--fake-cli", "--json"], env);
const argAfter = (args, name) => args[args.indexOf(name) + 1];

for (const [writer, reviewer] of [["claude", "codex"], ["codex", "codex"], ["codex", "claude"], ["claude", "claude"]]) {
  test("writer " + writer + ", reviewer " + reviewer + ": translation, work and review reach those CLIs, in separate sessions, and the records say so", { timeout: 240_000 }, async (t) => {
    const rt = await install(t, writer, reviewer);
    const work = await plan(rt);
    assert.equal(work.planned.status, 0, work.planned.stderr);
    const started = start(rt, work);
    assert.equal(started.status, 0, started.stderr + started.stdout);
    const calls = await rt.calls();
    assert.deepEqual(calls.map((call) => [call.mode, call.cli]), [
      ["translation", writer], ["check", reviewer], ["writer", writer], ["review", reviewer],
    ]);
    const sessions = calls.map((call) => call.session_id);
    assert.equal(new Set(sessions).size, 4, "every call is its own session: " + sessions.join(", "));
    const runId = work.plan.proposed_run_id;
    const usage = (await readIoEvents(rt.paths, runId)).filter((event) => event.event === "usage");
    assert.deepEqual(usage.map((event) => [event.role, event.provider]), [
      ["translator", writer], ["contract_checker", reviewer], ["writer", writer], ["reviewer", reviewer],
    ]);
    assert.deepEqual(usage.map((event) => event.session_id), sessions, "the record names the session the CLI reported");
    assert.ok(usage.every((event) => !event.parse_error), "each CLI's usage was read");
    const [row] = await queryRecords("select conclusion, writer_provider, writer_model, writer_effort, reviewer_provider, reviewer_model, reviewer_effort from runs where run_id = $1", [runId]);
    assert.deepEqual(row, {
      conclusion: "success", writer_provider: writer, writer_model: null, writer_effort: "medium", reviewer_provider: reviewer, reviewer_model: null, reviewer_effort: "medium",
    });
    const result = await latestResultCopy(rt.root, "farm");
    assert.match(result, new RegExp("^writer:\\n  provider: " + writer + "\\n  model: null  # .+\\n  effort: medium\\nreviewer:\\n  provider: " + reviewer + "\\n  model: null  # .+\\n  effort: medium\\n  mcp: \\[\\]\\n---", "m"));
  });
}

const ROLES_ORDER = "---\nwriter:\n  model: MODEL_W\n  effort: high\nreviewer: { model: MODEL_R, effort: low }\n---\n" + BODY;
const order = (modelWriter, modelReviewer) => ROLES_ORDER.replace("MODEL_W", modelWriter).replace("MODEL_R", modelReviewer);

test("the work order's model and effort reach each CLI by its own flags, in every call of that role", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  const work = await plan(rt, order("opus", "gpt-5.6-sol"));
  assert.equal(work.planned.status, 0, work.planned.stderr);
  assert.deepEqual([work.plan.writer.model, work.plan.writer.model_source, work.plan.writer.effort, work.plan.writer.effort_source], ["opus", "work_order", "high", "work_order"]);
  assert.deepEqual([work.plan.reviewer.model, work.plan.reviewer.effort], ["gpt-5.6-sol", "low"]);
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  for (const call of calls.filter((entry) => entry.cli === "claude")) {
    assert.deepEqual([argAfter(call.args, "--model"), argAfter(call.args, "--effort")], ["opus", "high"], call.mode);
  }
  for (const call of calls.filter((entry) => entry.cli === "codex")) {
    assert.equal(argAfter(call.args, "--model"), "gpt-5.6-sol", call.mode);
    assert.ok(call.args.includes('model_reasoning_effort="low"'), call.mode);
  }
  const [row] = await queryRecords("select writer_model, writer_effort, reviewer_model, reviewer_effort from runs where run_id = $1", [work.plan.proposed_run_id]);
  assert.deepEqual(row, { writer_model: "opus", writer_effort: "high", reviewer_model: "gpt-5.6-sol", reviewer_effort: "low" });
});

test("the other way round: Codex's writer takes them in its requests, Claude's reviewer by its flags", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "codex", "claude");
  const work = await plan(rt, order("gpt-5.6-sol", "sonnet"));
  assert.equal(work.planned.status, 0, work.planned.stderr);
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  const writer = calls.find((call) => call.mode === "writer");
  assert.deepEqual(writer.thread, { cwd: rt.root, approvalPolicy: "never", sandbox: "workspace-write", model: "gpt-5.6-sol" }, "writes to the workspace only, asks nobody");
  assert.deepEqual([writer.effort, writer.schema], ["high", true]);
  const translation = calls.find((call) => call.mode === "translation");
  assert.equal(argAfter(translation.args, "--sandbox"), "read-only");
  assert.ok(translation.args.includes('model_reasoning_effort="high"'));
  for (const call of calls.filter((entry) => entry.cli === "claude")) {
    assert.deepEqual([argAfter(call.args, "--model"), argAfter(call.args, "--effort")], ["sonnet", "low"], call.mode);
  }
});

test("no model anywhere: no CLI is told one, in any role", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "codex", "claude");
  const work = await plan(rt);
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  for (const call of await rt.calls()) {
    assert.equal(call.args.includes("--model"), false, call.mode);
    assert.equal(call.thread?.model, undefined, call.mode);
  }
});

test("Claude's sessions: a translation has no tool and no MCP server, a reviewer only reads, a writer keeps its own", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "claude");
  const started = start(rt, await plan(rt));
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  const translation = calls.find((call) => call.mode === "translation");
  assert.equal(argAfter(translation.args, "--tools"), "");
  assert.ok(translation.args.includes("--strict-mcp-config"), "19 MCP tools were in a real translation's session without this");
  for (const mode of ["check", "review"]) {
    const call = calls.find((entry) => entry.mode === mode);
    assert.equal(argAfter(call.args, "--permission-mode"), "plan", mode);
    assert.equal(argAfter(call.args, "--tools"), "Read,Grep,Glob", mode);
    assert.equal(argAfter(call.args, "--disallowedTools"), "Write,Edit,NotebookEdit,Bash,PowerShell", mode);
    assert.ok(call.args.includes("--strict-mcp-config"), mode);
    assert.ok(call.args.includes("--no-session-persistence"), mode);
  }
  const writer = calls.find((call) => call.mode === "writer");
  assert.equal(argAfter(writer.args, "--permission-mode"), "auto");
  assert.ok(writer.args.includes("--strict-mcp-config"), "the person's connectors are in no session");
  assert.equal(writer.args.includes("--mcp-config"), false, "this project has no .mcp.json");
});

test("Codex's sessions turn apps and plugins off, in every call: translation, check, work and review", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "codex", "codex");
  const started = start(rt, await plan(rt));
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  assert.equal(calls.length, 4);
  for (const call of calls) assert.deepEqual(call.args.slice(0, 4), ["--disable", "apps", "--disable", "plugins"], call.mode);
});

for (const [label, env, shown] of [
  ["holds a connector's tools", { FAKE_CLAUDE_EXTRA_TOOLS: "mcp__claude_ai_Google_Drive__trash_file,mcp__claude_ai_Gmail__send" }, /mcp__claude_ai_Google_Drive__trash_file, mcp__claude_ai_Gmail__send/],
  ["does not show its tools", { FAKE_CLAUDE_NO_INIT: "1" }, /did not show which tools it held/],
]) {
  test("a translation session that " + label + " is not used: nothing is sealed, no work starts, and the result says why", { timeout: 240_000 }, async (t) => {
    const rt = await install(t, "claude", "codex");
    const work = await plan(rt);
    const started = start(rt, work, env);
    assert.equal(started.status, 1, started.stderr + started.stdout);
    assert.deepEqual((await rt.calls()).map((call) => call.mode), ["translation"], "no check and no writer after it");
    const runId = work.plan.proposed_run_id;
    const [row] = await queryRecords("select contract_sha256, closed_reason from runs where run_id = $1", [runId]);
    assert.deepEqual(row, { contract_sha256: null, closed_reason: "policy_failure" });
    const usage = (await readIoEvents(rt.paths, runId)).filter((event) => event.event === "usage");
    assert.equal(usage.length, 1, "what the call spent is still recorded");
    assert.match(await latestResultCopy(rt.root, "farm"), shown);
  });
}

test("a Claude writer in a project with .mcp.json gets that file; its translation does not", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  await fsp.writeFile(path.join(rt.root, ".mcp.json"), "{\"mcpServers\":{}}\n");
  const started = start(rt, await plan(rt));
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  const writer = calls.find((call) => call.mode === "writer");
  assert.ok(writer.args.includes("--strict-mcp-config"));
  assert.equal(argAfter(writer.args, "--mcp-config"), ".mcp.json");
  const translation = calls.find((call) => call.mode === "translation");
  assert.equal(translation.args.includes("--mcp-config"), false, "the project's servers are the writer's, not the translation's");
});

test("a model that is not the role's CLI's is refused before any card, naming its line", { timeout: 120_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  const crossed = await plan(rt, order("gpt-5.6-sol", "opus"));
  assert.notEqual(crossed.planned.status, 0);
  assert.match(crossed.planned.stderr, /line 3: writer\.model: gpt-5\.6-sol is not a claude model/);
  assert.match(crossed.planned.stderr, /line 5: reviewer\.model: opus is not a codex model/);
  assert.equal(crossed.plan, null);
  // The same work order is fine once the flags fill the roles the other way round.
  const swapped = await plan(rt, order("gpt-5.6-sol", "opus"), ["--writer", "codex", "--reviewer", "claude"], "swapped");
  assert.equal(swapped.planned.status, 0, swapped.planned.stderr);
  // The policy's table is held to the same.
  await fsp.writeFile(rt.paths.policyOverridePath, JSON.stringify({ schema_version: 5, priority: { writer: { medium: { model: "opus" } } } }));
  const fromPolicy = await plan(rt, BODY, ["--writer", "codex"], "policy");
  assert.notEqual(fromPolicy.planned.status, 0);
  assert.match(fromPolicy.planned.stderr, /The policy's priority table gives the writer a model: opus is not a codex model/);
});

test("a policy that denies the writer tools is not ignored with a writer that cannot be told", { timeout: 120_000 }, async (t) => {
  const rt = await install(t, "codex", "codex");
  await fsp.writeFile(rt.paths.policyOverridePath, JSON.stringify({ schema_version: 5, writer: { disallowed_tools: ["Agent"] } }));
  const work = await plan(rt);
  assert.notEqual(work.planned.status, 0);
  assert.match(work.planned.stderr, /writer\.disallowed_tools \(Agent\) cannot be held to with codex as the writer/);
});

test("the plan seals the roles: bridge.json changed after it affects the next start only, and the card names them", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  const work = await plan(rt);
  const config = await readJson(rt.paths.bridgeConfigPath);
  const swapped = { ...config, roles: { ...config.roles, writer: { provider_id: "codex" }, reviewer: { provider_id: "claude" } } };
  await fsp.writeFile(rt.paths.bridgeConfigPath, JSON.stringify(swapped));
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.deepEqual((await rt.calls()).map((call) => call.cli), ["claude", "codex", "claude", "codex"], "this run keeps what its card showed");
  const card = rt.bridge(["start", work.order, "--fake-cli"]);
  assert.match(card.stdout, /^Writer: +codex \(config\), model the CLI's default \(priority table\), effort medium \(priority table\)$/m);
  assert.match(card.stdout, /^Reviewer: +claude \(config\), model the CLI's default \(priority table\), effort medium \(priority table\)$/m);
  assert.match(card.stdout, /by the writer \(codex\) and 2 check\(s\) by the reviewer \(claude\)/);
});

test("--writer and --reviewer fill the roles for one run; beside --yes they must be what the card showed", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  await fsp.writeFile(path.join(rt.root, ".review-bridge/work-packages/farm.md"), BODY);
  const order = ".review-bridge/work-packages/farm.md";
  const card = rt.bridge(["start", order, "--writer", "codex", "--reviewer", "codex", "--fake-cli"]);
  assert.match(card.stdout, /^Writer: +codex \(flag\)/m);
  assert.match(card.stdout, /^Reviewer: +codex \(flag\)/m);
  const other = rt.bridge(["start", order, "--writer", "claude", "--yes", "--fake-cli"]);
  assert.match(other.stdout, /--writer is not what the card showed/);
  const yes = rt.bridge(["start", order, "--writer", "codex", "--yes", "--fake-cli"]);
  assert.equal(yes.status, 0, yes.stderr + yes.stdout);
  assert.deepEqual((await rt.calls()).map((call) => call.cli), ["codex", "codex", "codex", "codex"]);
  assert.equal((await readJson(rt.paths.bridgeConfigPath)).roles.writer.provider_id, "claude", "bridge.json is not changed by a flag");
  const unknown = rt.bridge(["start", order, "--writer", "gemini", "--fake-cli"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /writer must be one of: claude, codex/);
});

const MCP_LIST = JSON.stringify([{ name: "node_repl", enabled: true }, { name: "docs_search", enabled: true }]);
const allowInPolicy = async (rt, names) => fsp.writeFile(rt.paths.policyOverridePath, JSON.stringify({ schema_version: 5, reviewer: { mcp_allow: names } }));
const offFlags = (args) => args.filter((arg) => /^mcp_servers\./.test(arg));

test("Codex: every server not on the list is off by name in every call, sealed in the plan; the card, the run and the result say the reviewer has none", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "codex", "codex");
  const work = await plan(rt, BODY, [], "farm", { FAKE_CODEX_MCP_LIST: MCP_LIST });
  assert.equal(work.planned.status, 0, work.planned.stderr);
  assert.deepEqual([work.plan.writer.mcp_off, work.plan.reviewer.mcp_off, work.plan.reviewer.mcp], [["node_repl", "docs_search"], ["node_repl", "docs_search"], []]);
  // Started under another list: the plan's holds, the list is not read again.
  const started = start(rt, work, { FAKE_CODEX_MCP_LIST: "fail" });
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  assert.equal(calls.length, 4);
  for (const call of calls) assert.deepEqual(offFlags(call.args), ["mcp_servers.node_repl.enabled=false", "mcp_servers.docs_search.enabled=false"], call.mode);
  const [row] = await queryRecords("select reviewer_mcp from runs where run_id = $1", [work.plan.proposed_run_id]);
  assert.deepEqual(row.reviewer_mcp, []);
  assert.match(await latestResultCopy(rt.root, "farm"), /^reviewer:\n  provider: codex\n(?:.*\n){2}  mcp: \[\]\n---/m);
  const card = rt.bridge(["start", work.order, "--fake-cli"], { FAKE_CODEX_MCP_LIST: MCP_LIST });
  assert.match(card.stdout, /^Reviewer MCP: none$/m);
});

test("a server on reviewer.mcp_allow stays on in the reviewer's calls only, as it is; the card says it is not checked, and the run and the result name it", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "codex", "codex");
  await allowInPolicy(rt, ["docs_search"]);
  const work = await plan(rt, BODY, [], "farm", { FAKE_CODEX_MCP_LIST: MCP_LIST });
  assert.equal(work.planned.status, 0, work.planned.stderr);
  assert.deepEqual([work.plan.reviewer.mcp_off, work.plan.reviewer.mcp], [["node_repl"], ["docs_search"]]);
  assert.deepEqual(work.plan.writer.mcp_off, ["node_repl", "docs_search"], "the writer keeps nothing, list or no list");
  const started = start(rt, work);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const calls = await rt.calls();
  assert.equal(calls.length, 4);
  for (const mode of ["translation", "writer"]) assert.deepEqual(offFlags(calls.find((call) => call.mode === mode).args), ["mcp_servers.node_repl.enabled=false", "mcp_servers.docs_search.enabled=false"], mode);
  for (const mode of ["check", "review"]) assert.deepEqual(offFlags(calls.find((call) => call.mode === mode).args), ["mcp_servers.node_repl.enabled=false"], mode);
  const [row] = await queryRecords("select reviewer_mcp from runs where run_id = $1", [work.plan.proposed_run_id]);
  assert.deepEqual(row.reviewer_mcp, ["docs_search"]);
  assert.match(await latestResultCopy(rt.root, "farm"), /^ {2}mcp: \["docs_search"\]$/m);
  const card = rt.bridge(["start", work.order, "--fake-cli"], { FAKE_CODEX_MCP_LIST: MCP_LIST });
  assert.match(card.stdout, /^Reviewer MCP: docs_search \(allowed by the policy, not checked to be read-only\)$/m);
});

test("a list that cannot be read, or an allowed server that is not there, starts nothing and says why", { timeout: 180_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  const unreadable = await plan(rt, BODY, [], "unreadable", { FAKE_CODEX_MCP_LIST: "fail" });
  assert.notEqual(unreadable.planned.status, 0);
  assert.match(unreadable.planned.stderr, /could not read Codex's MCP servers, so it cannot turn off the ones this work must not have, and nothing was started/);
  const shaped = await plan(rt, BODY, [], "shaped", { FAKE_CODEX_MCP_LIST: "{\"not\":\"a list\"}" });
  assert.match(shaped.planned.stderr, /its answer is not a list/);
  const odd = await plan(rt, BODY, [], "odd", { FAKE_CODEX_MCP_LIST: JSON.stringify([{ name: "a.b; rm -rf /" }]) });
  assert.match(odd.planned.stderr, /a name Bridge cannot turn off by name/);
  await allowInPolicy(rt, ["absent"]);
  const absent = await plan(rt, BODY, [], "absent", { FAKE_CODEX_MCP_LIST: MCP_LIST });
  assert.match(absent.planned.stderr, /reviewer\.mcp_allow names absent, which Codex does not load here/);
  await fsp.rm(rt.paths.policyOverridePath, { force: true });
  // With no Codex in the run, its list is not asked for.
  const noCodex = await plan(rt, BODY, ["--writer", "claude", "--reviewer", "claude"], "no-codex", { FAKE_CODEX_MCP_LIST: "fail" });
  assert.equal(noCodex.planned.status, 0, noCodex.planned.stderr);
  assert.deepEqual([noCodex.plan.writer.mcp_off, noCodex.plan.reviewer.mcp_off, noCodex.plan.reviewer.mcp], [[], [], []]);
});

test("a Codex that is not there or not signed in is the first thing said, the list only after it; with no Codex in the run, neither is asked", async () => {
  const asked = [];
  const settle = (roles, nextAction) => settleMcp({
    ...roles, allow: [], cwd: os.tmpdir(),
    checkCodex: async () => { asked.push("check"); return nextAction; },
    listCodex: async () => { asked.push("list"); throw new Error("config.toml could not be read."); },
  });
  for (const [nextAction, hint] of [["install_cli", /^The reviewer \(codex\) is not installed and signed in\. Install the codex CLI, then sign it in: codex login$/], ["sign_in", /^The reviewer \(codex\) is not installed and signed in\. Sign it in: codex login$/], ["recheck_sign_in", /Sign it in: codex login$/]]) {
    asked.length = 0;
    await assert.rejects(settle({ writer: "claude", reviewer: "codex" }, nextAction), (error) => error instanceof RoleCliNotReadyError && hint.test(error.message) && !/MCP/.test(error.message));
    assert.deepEqual(asked, ["check"], "the list is not read");
  }
  await assert.rejects(settle({ writer: "codex", reviewer: "claude" }, "sign_in"), /^RoleCliNotReadyError|The writer \(codex\) is not installed and signed in/);
  // Ready, and the list still cannot be read: only now is the list mentioned.
  asked.length = 0;
  await assert.rejects(settle({ writer: "claude", reviewer: "codex" }, "none"), /could not read Codex's MCP servers.*config\.toml could not be read/);
  assert.deepEqual(asked, ["check", "list"]);
  asked.length = 0;
  assert.deepEqual(await settle({ writer: "claude", reviewer: "claude" }, "sign_in"), { writerOff: [], reviewerOff: [], reviewerMcp: [] });
  assert.deepEqual(asked, [], "no Codex in the run: neither is asked");
});

test("at the command line: a missing Codex is said as such in the role it fills; a person with no Codex and no Codex role never sees MCP", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "codex");
  const order = ".review-bridge/work-packages/native.md";
  await fsp.writeFile(path.join(rt.root, order), BODY);
  const absent = { CODEX_REVIEW_CLI: path.join(rt.root, "absent-codex"), CLAUDE_REVIEW_CLI: path.join(rt.root, "absent-claude") };
  const planOnly = rt.bridge(["work-plan", order, "--breakpoint", "after the review"], absent);
  assert.notEqual(planOnly.status, 0);
  assert.match(planOnly.stderr, /The reviewer \(codex\) is not installed and signed in\. Install the codex CLI, then sign it in: codex login/);
  assert.doesNotMatch(planOnly.stderr, /MCP/);
  const reviewer = rt.bridge(["start", order], absent);
  assert.equal(reviewer.status, 1, reviewer.stderr);
  assert.match(reviewer.stdout, /^Reviewer read-only check: not passed \(the reviewer CLI is not installed and signed in\)\nInstall the codex CLI and sign it in \(codex login\), then run: review-bridge start /m);
  assert.doesNotMatch(reviewer.stdout + reviewer.stderr, /MCP/);
  const writer = rt.bridge(["start", order, "--writer", "codex", "--reviewer", "claude"], absent);
  assert.equal(writer.status, 1, writer.stderr);
  assert.match(writer.stdout, /^Writer: not ready \(the writer CLI is not installed and signed in\)\nInstall the codex CLI and sign it in \(codex login\), then run: review-bridge start /m);
  assert.doesNotMatch(writer.stdout + writer.stderr, /MCP/);
  // No Codex role: nothing about Codex or its list, even with Codex absent. Its check stops at Claude's own CLI.
  const noCodex = rt.bridge(["start", order, "--writer", "claude", "--reviewer", "claude"], absent);
  assert.equal(noCodex.status, 1, noCodex.stderr);
  assert.match(noCodex.stdout, /Reviewer read-only check: not passed/);
  assert.doesNotMatch(noCodex.stdout + noCodex.stderr, /MCP|codex/i);
});

test("a Claude reviewer: nothing on the list, no server at all; on the list, only those from .mcp.json; the writer's rule does not change", { timeout: 240_000 }, async (t) => {
  const rt = await install(t, "claude", "claude");
  await fsp.writeFile(path.join(rt.root, ".mcp.json"), JSON.stringify({ mcpServers: { docs_search: { command: "a" }, deploy: { command: "b" } } }));
  const none = start(rt, await plan(rt));
  assert.equal(none.status, 0, none.stderr + none.stdout);
  const first = await rt.calls();
  for (const mode of ["check", "review"]) {
    const call = first.find((entry) => entry.mode === mode);
    assert.ok(call.args.includes("--strict-mcp-config"), mode);
    assert.equal(call.args.includes("--mcp-config"), false, mode);
  }
  await fsp.rm(path.join(rt.root, "calls.jsonl"));
  await allowInPolicy(rt, ["docs_search"]);
  const work = await plan(rt, BODY + "\n", [], "listed");
  assert.equal(work.planned.status, 0, work.planned.stderr);
  const listed = start(rt, work);
  assert.equal(listed.status, 0, listed.stderr + listed.stdout);
  const calls = await rt.calls();
  for (const mode of ["check", "review"]) {
    const call = calls.find((entry) => entry.mode === mode);
    assert.ok(call.args.includes("--strict-mcp-config"), mode);
    assert.deepEqual(Object.keys(JSON.parse(argAfter(call.args, "--mcp-config")).mcpServers), ["docs_search"], mode);
    assert.equal(argAfter(call.args, "--allowedTools"), "mcp__docs_search", mode);
  }
  const writer = calls.find((call) => call.mode === "writer");
  assert.equal(argAfter(writer.args, "--mcp-config"), ".mcp.json", "the writer takes the project's whole file, as before");
  assert.equal(calls.find((call) => call.mode === "translation").args.includes("--mcp-config"), false);
  const [row] = await queryRecords("select reviewer_mcp from runs where run_id = $1", [work.plan.proposed_run_id]);
  assert.deepEqual(row.reviewer_mcp, ["docs_search"]);
  await allowInPolicy(rt, ["docs_search", "absent"]);
  const refused = await plan(rt, BODY, [], "refused");
  assert.match(refused.planned.stderr, /names absent, which is not in this project's \.mcp\.json/);
});

test("reviewer.mcp_allow takes server names, and a project adds to it", () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(runtimeSource, "config", "default-policy.json"), "utf8"));
  assert.deepEqual(defaults.reviewer.mcp_allow, []);
  assert.deepEqual(mergePolicy(defaults, { schema_version: 5, reviewer: { mcp_allow: ["b", "a"] } }).reviewer.mcp_allow, ["a", "b"]);
  assert.throws(() => mergePolicy(defaults, { schema_version: 5, reviewer: { mcp_allow: ["a.b"] } }), /must be a list of MCP server names/);
  assert.throws(() => mergePolicy(defaults, { schema_version: 5, reviewer: { mcp_allow: "a" } }), /must be a list of MCP server names/);
  assert.throws(() => mergePolicy(defaults, { schema_version: 5, reviewer: { effort: "high" } }), /Unknown project policy override key: reviewer\.effort/);
});

// A role's call, straight to a fake CLI, for what a whole run cannot be made to do.
function fakeAdapter(env = {}) {
  return {
    async resolveExecutable() { return process.execPath; },
    buildInvocation(kind, executable, args) {
      return { command: executable, args: [path.join(fixtures, "fake-" + kind + ".mjs"), ...args], env: { ...process.env, ...env } };
    },
  };
}

test("a Codex writer's usage limit and timeout are told apart from any other failure, and its stderr is kept", { timeout: 120_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-role-call-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fsp.mkdir(path.join(dir, ".review-bridge"));
  await fsp.writeFile(path.join(dir, ".review-bridge", "bridge.json"), JSON.stringify({ project_id: "00000000-0000-4000-8000-000000000000" }));
  const request = (name) => ({
    access: "write", role: "writer", call: 1, prompt: "[REVIEW_BRIDGE_MODE: WRITER_ONLY]\n", schemaPath: path.join(runtimeSource, "features", "workOrder", "schemas", "writer.result.schema.json"),
    model: null, effort: "low", cwd: dir, stdoutPath: path.join(dir, name + ".events.jsonl"), stderrPath: path.join(dir, name + ".stderr.log"), answerPath: path.join(dir, name + ".json"), timeoutMs: 20_000,
  });
  const limited = await callRole("codex", { ...request("limited"), adapter: fakeAdapter({ FAKE_CLAUDE_RESULT: "RATE_LIMIT" }) });
  assert.deepEqual([limited.failed, limited.timedOut, limited.complete], [true, false, false]);
  assert.match((await limited.failureTexts()).join("\n"), /usage limit/);
  assert.equal(limited.usage.partial, true);
  const slow = await callRole("codex", { ...request("slow"), timeoutMs: 1_000, adapter: fakeAdapter({ FAKE_CLAUDE_SLEEP_MS: "30000" }) });
  assert.deepEqual([slow.failed, slow.timedOut], [true, true]);
  const loud = await callRole("codex", { ...request("loud"), adapter: fakeAdapter({ FAKE_CODEX_STDERR: String(1024 * 1024) }) });
  assert.deepEqual([loud.failed, loud.complete], [false, true]);
  assert.ok((await fsp.stat(request("loud").stderrPath)).size > 1024 * 1024);
  assert.equal((await readJson(request("loud").answerPath)).event, "writer.result");
  await assert.rejects(callRole("gemini", request("x")), /No way to call gemini/);
});
