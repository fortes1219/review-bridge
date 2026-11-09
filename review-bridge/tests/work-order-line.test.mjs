// RC3-PIPE-01: a directory of work orders is one line. Every model call here is the fake CLI.
// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords, stopPage } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { orderWorkOrders, signedOutProvider, stepOf, stopOfRun } from "../features/workOrder/line.mjs";
import { sealedText, workOrderIdOf } from "../features/workOrder/workOrderFormat.mjs";
import { latestCardsOfFiles, latestRunsOfWorkOrders } from "../features/workOrder/workOrderRecords.mjs";
import { isPidAlive } from "../service/agentCli/process.mjs";
import { activeLineSteps } from "../service/records/runRecords.mjs";
import { connect } from "../service/database/postgresServer.mjs";
import { getBridgePaths } from "../utils/paths.mjs";
import { KEYS, ptySkip, terminal } from "../../tests/pty.mjs";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtime, "..");
const bootstrap = path.join(runtime, "bootstrap.mjs");
const LIMIT = { timeout: 240_000 };

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function install(t, { withGit = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-line-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "line-demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await fsp.writeFile(path.join(root, "README.md"), "# demo\n");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (withGit) {
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "start");
  }
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const bridge = (args, env = {}) => spawnSync(process.execPath, [bootstrap, ...args], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
  t.after(async () => {
    await stopPage(root);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const paths = getBridgePaths(root, runtime, { privateRootName: ".review-bridge" });
  return { root, bridge, git, paths, dirOf: (name) => ".review-bridge/work-packages/" + name };
}

const order = (name, sentence = "Print a greeting from " + name + ".") => "# Work order: " + name + "\n\n<!-- bridge:requested_work -->\n## Work\n" + sentence
  + "\n\n<!-- bridge:acceptance -->\n## Acceptance\n- " + name + " is printed.\n";

async function directory(rt, name, files) {
  await fsp.mkdir(path.join(rt.root, rt.dirOf(name)), { recursive: true });
  for (const [file, text] of Object.entries(files)) await fsp.writeFile(path.join(rt.root, rt.dirOf(name), file), text ?? order(file.replace(/\.md$/, "")));
}

// The line in a process of its own, for a test that acts while it runs. Its stdout is kept and awaited.
function runInBackground(t, rt, args, env = {}) {
  const child = spawn(process.execPath, [bootstrap, ...args], { cwd: rt.root, windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  // A pipe a killed process's child holds open must not hold this up: exit, not close.
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return {
    child, exited, output: () => out,
    async saw(pattern, what = String(pattern)) {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const match = pattern.exec(out);
        if (match) return match;
        if (child.exitCode !== null || Date.now() > deadline) assert.fail("never printed " + what + ":\n" + out);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

// Waits until the writer's process of this run is on record, which is when a stop has something to kill.
async function writerRunning(rt, runId) {
  const file = path.join(rt.paths.runLocksDir, runId + ".process.json");
  const deadline = Date.now() + 120_000;
  for (;;) {
    const record = await fsp.readFile(file, "utf8").then(JSON.parse, () => null);
    if (record?.role === "writer") return record.pid;
    assert.ok(Date.now() < deadline, "the writer never started");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const runsOf = (rt) => queryRecords(
  "select r.run_id, r.conclusion, r.closed_reason, p.source_file, a.authorized_via, a.authorized_at from runs r join plans p using (plan_sha256) left join authorizations a on a.plan_sha256 = p.plan_sha256"
  + " where r.project_id = $1 order by r.created_at", [rt.paths.projectId]);

test("the step of a file name, and the order of a directory", () => {
  assert.deepEqual(["01-x.md", "01_x.md", "2-x.md", "02-y.md", "v1-x.md", "T001-x.md", "README.md", "007.md", "1x.md", "20261106-x.md"].map(stepOf),
    ["1", "1", "2", "2", null, null, null, null, null, "20261106"]);
  // One step, the name after the number first: x before y, though "02-y" sorts before "2-x" as text.
  assert.deepEqual(orderWorkOrders(["02-y.md", "2-x.md", "v1-x.md", "T001-x.md", "10-z.md", "1_a.md"]).map((item) => item.name),
    ["1_a.md", "2-x.md", "02-y.md", "10-z.md", "T001-x.md", "v1-x.md"]);
  // A number too long for a double is still exact.
  assert.deepEqual(orderWorkOrders(["90071992547409931-b.md", "90071992547409930-a.md"]).map((item) => item.name), ["90071992547409930-a.md", "90071992547409931-b.md"]);
  assert.deepEqual(orderWorkOrders(["01_c.md", "01-b.md", "01-a.md"]).map((item) => item.name), ["01-a.md", "01-b.md", "01_c.md"]);
});

test("what stops a line: a provider's sign-in or quota and a person's stop; a Bridge budget does not", async () => {
  const stopped = (reason, closed = "writer_failed") => stopOfRun({ closed_reason: closed, last_state: { failure: { reason, provider: "codex", reset_hint: null } } });
  assert.deepEqual(stopped("provider_signed_out"), { kind: "signed_out", provider: "codex" });
  assert.deepEqual(stopped("provider_usage_limit", "rate_limited"), { kind: "usage_limit", provider: "codex", resetHint: null });
  assert.equal(stopped("provider_error"), null);
  assert.equal(stopped("timeout", "writer_timeout"), null);
  for (const closedReason of ["token_limit", "usage_unknown", "rounds_exhausted", "superseded", "run_timeout", "review_hard_stop"]) assert.equal(stopOfRun({ closed_reason: closedReason, last_state: {} }), null, closedReason);
  assert.deepEqual(stopOfRun({ closed_reason: "stopped", last_state: {} }), { kind: "stopped" });
  const plan = { writer: { provider: "claude" }, reviewer: { provider: "codex" } };
  const asked = [];
  const answers = (next) => async (provider) => { asked.push(provider); return { next_action: next[provider] }; };
  assert.equal(await signedOutProvider(plan, answers({ claude: "none", codex: "sign_in" })), "codex");
  assert.equal(await signedOutProvider(plan, answers({ claude: "recheck_sign_in", codex: "none" })), null, "a state the CLI cannot name is not signed out");
  asked.length = 0;
  assert.equal(await signedOutProvider({ writer: { provider: "codex" }, reviewer: { provider: "codex" } }, answers({ codex: "none" })), null);
  assert.deepEqual(asked, ["codex"], "one provider in both roles is asked once");
});

test("a card lists the directory in order, prints no work order's text, and one yes runs each as its own run", LIMIT, async (t) => {
  const rt = await install(t);
  const secret = "Only-the-sealed-text-holds-this-sentence.";
  await directory(rt, "demo", {
    "zz.md": null, "03-d.md": null, "02_c.md": null, "02-b.md": null, "01_a.md": order("01_a", secret), "README.md": "# Read me\n\n<!-- bridge:readme -->\nNot a work order at all.\n",
  });
  const card = rt.bridge(["start", rt.dirOf("demo") + "/", "--fake-cli"]);
  assert.equal(card.status, 1, card.stderr);
  assert.match(card.stdout, /Directory \.review-bridge\/work-packages\/demo\/ {2}— 6 file\(s\): 0 delivered, 1 not a work order, 5 to run/);
  const rows = card.stdout.split("\n").filter((line) => /^ {2}\S+\.md /.test(line));
  assert.deepEqual(rows.map((line) => line.trim().split(/\s+/)[0]), ["01_a.md", "02-b.md", "02_c.md", "03-d.md", "README.md", "zz.md"]);
  assert.match(rows[1], /contract sha256 [0-9a-f]{4}…, 1 condition\(s\)$/);
  assert.match(rows[2], /\(same number as 02-b\.md; runs after it, by name\)/);
  assert.match(rows[4], /not a work order \(.+\) {3}\(skip\)$/);
  assert.match(card.stdout, /Runs in place, one after another\. A failed step does not stop the next\./);
  assert.match(card.stdout, /Needs authorization\. If the person says yes, run again: review-bridge start \.review-bridge\/work-packages\/demo --fake-cli --yes/);
  assert.equal(card.stdout.includes(secret), false, "the card holds no work order's text");
  assert.deepEqual(await queryRecords("select 1 from runs where project_id = $1", [rt.paths.projectId]), [], "nothing started without a yes");

  // The yes of the directory's card is not a yes to one of its files.
  const one = rt.bridge(["start", rt.dirOf("demo") + "/01_a.md", "--fake-cli", "--yes"]);
  assert.equal(one.status, 1);
  assert.match(one.stdout, /The last card shown for this work order was its directory's \(demo\/\)/);

  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /\[1\/5\] 01_a\.md started .+ \(run [0-9a-f-]{36}\)/);
  assert.match(ran.stdout, /\[5\/5\] zz\.md success /);
  const table = ran.stdout.slice(ran.stdout.indexOf("Line .review-bridge"));
  const lines = table.split("\n").slice(1).filter(Boolean);
  assert.deepEqual(lines.map((line) => line.trim().split(/\s+/).slice(0, 2)), [["01_a.md", "success"], ["02-b.md", "success"], ["02_c.md", "success"], ["03-d.md", "success"], ["zz.md", "success"]]);
  const runs = await runsOf(rt);
  assert.deepEqual(runs.map((run) => path.posix.basename(run.source_file)), ["01_a.md", "02-b.md", "02_c.md", "03-d.md", "zz.md"], "in the card's order, each its own run");
  assert.equal(new Set(runs.map((run) => run.run_id)).size, 5);
  assert.ok(runs.every((run) => run.authorized_via === "agent"));
  assert.equal(new Set(runs.map((run) => run.authorized_at.toISOString())).size, 1, "one yes, one moment");
  assert.equal((await queryRecords("select count(*)::int as n from authorizations a join plans p using (plan_sha256) where p.project_id = $1 and p.body->'line'->>'directory' = 'demo'", [rt.paths.projectId]))[0].n, 5);
  for (const name of ["01_a", "02-b", "02_c", "03-d", "zz"]) {
    const entries = await fsp.readdir(path.join(rt.root, ".review-bridge", "results", "demo", name));
    assert.ok(entries.some((entry) => entry.endsWith(" success.md")), name + ": " + entries.join(", "));
  }
  const yesAgain = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(yesAgain.status, 1);
  assert.match(yesAgain.stdout, /already said yes to/);
});

test("one failing does not stop the next, and the table says each", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": order("02-b", "FAILS-IN-REVIEW"), "03-c.md": null });
  const env = { FAKE_ON_REVIEW_FAIL: "02-b is printed" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--rounds", "1"], env).status, 1);
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--rounds", "1", "--yes"], env);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.deepEqual((await runsOf(rt)).map((run) => run.conclusion), ["success", "action_required", "success"]);
  const table = ran.stdout.slice(ran.stdout.indexOf("Line .review-bridge"));
  assert.match(table, /01-a\.md +success/);
  assert.match(table, /02-b\.md +action_required/);
  assert.match(table, /03-c\.md +success/);
  assert.doesNotMatch(table, /Stopped at/);
});

// The budget is the writer's and counts what it read new, wrote to the cache and wrote out, never what it
// read back from the cache (Owner 2026-11-08). The fake writer's counted tokens are 94 + 454 + 2352 per
// call, so a work order whose own budget is 1000 spends it on its first call; its cache reads, however
// many, count for nothing.
test("Bridge's own token budget, spent on a run, is that work order's: the next one still runs; cache reads spend none of it", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": "---\nbudget:\n  tokens: 1000\n---\n" + order("01-a"), "02-b.md": null });
  const env = { FAKE_CLAUDE_TOKENS: "99999999", FAKE_WRITER_ONLY: "1" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.deepEqual((await runsOf(rt)).map((run) => [run.closed_reason, run.conclusion]), [["token_limit", "failure"], ["review_pass", "success"]]);
  assert.doesNotMatch(ran.stdout, /Stopped at/);
});

test("one work order of the line short of what it must say stops the whole line before the card; each is told, its marker written back", LIMIT, async (t) => {
  const rt = await install(t);
  const noList = "# Work order: b\n\n<!-- bridge:requested_work -->\n## Work\nPrint b.\n";
  const chinese = "# Work order: c\n\n<!-- bridge:requested_work -->\n## Work\nPrint c.\n\n<!-- bridge:acceptance -->\n## 驗收\n一、c 印出來\n";
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": noList, "03-c.md": chinese });
  const refused = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /demo\/02-b\.md cannot start yet:\n- The acceptance list is missing/);
  assert.match(refused.stdout, /demo\/03-c\.md cannot start yet:\n- Line 9 is not an item of the acceptance list: start each item with "- "/);
  assert.doesNotMatch(refused.stdout, /Needs authorization|Directory \.review-bridge/, "no card");
  assert.equal(await fsp.readFile(path.join(rt.root, rt.dirOf("demo"), "02-b.md"), "utf8"), noList + "\n<!-- bridge:acceptance -->\n## Acceptance\n");
  assert.equal(await fsp.readFile(path.join(rt.root, rt.dirOf("demo"), "03-c.md"), "utf8"), chinese, "its marker is there: nothing to write back");
  assert.deepEqual(await runsOf(rt), []);
  await fsp.appendFile(path.join(rt.root, rt.dirOf("demo"), "02-b.md"), "- b is printed.\n");
  await fsp.writeFile(path.join(rt.root, rt.dirOf("demo"), "03-c.md"), chinese.replace("一、", "- "));
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]).status, 1);
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal((await runsOf(rt)).length, 3);
});

test("a provider that signed out during the work stops the line; started again, what was delivered is skipped and the rest is pending", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null, "03-c.md": null });
  const env = { FAKE_ON_SIGNED_OUT: "02-b is printed", FAKE_WRITER_ONLY: "1" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  assert.equal(ran.status, 75, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /Stopped at step 2: claude needs signing in again \(claude auth login\); 3 did not run\. After signing in, run start on this directory again: only what is pending runs\./);
  assert.match(ran.stdout, /03-c\.md +not run/);
  assert.equal((await runsOf(rt)).length, 2, "the third was not started");
  const again = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.match(again.stdout, /1 delivered, 0 not a work order, 2 to run/);
  assert.match(again.stdout, /01-a\.md +delivered \d{4}-\d{2}-\d{2} \d{2}:\d{2} {3}\(skip\)/);
  assert.match(again.stdout, /02-b\.md +contract sha256 /);
  assert.match(again.stdout, /03-c\.md +contract sha256 /);
});

test("a provider out of quota during the work stops the line the same way, and the run says rate_limited", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  const env = { FAKE_ON_OUT_OF_USAGE: "01-a is printed", FAKE_WRITER_ONLY: "1" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  assert.equal(ran.status, 75, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /Stopped at step 1: claude is out of quota; 2 did not run\./);
  assert.deepEqual((await runsOf(rt)).map((run) => run.closed_reason), ["rate_limited"]);
});

test("a line whose process is killed: the run closes as cancelled, and starting again opens a new run for it", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  const env = { FAKE_CLAUDE_SLEEP_MS: "90000" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const line = runInBackground(t, rt, ["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  const [, firstRun] = await line.saw(/\[1\/2\] 01-a\.md started .+ \(run ([0-9a-f-]{36})\)/);
  const writer = await writerRunning(rt, firstRun);
  t.after(() => { if (isPidAlive(writer)) process.kill(writer); });
  // On Windows this ends the process at once, on POSIX it reaches the line's handler: either way.
  line.child.kill("SIGTERM");
  await line.exited;
  const card = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(card.status, 1, card.stdout + card.stderr);
  assert.match(card.stdout, /01-a\.md +contract sha256 [0-9a-f]{4}…, 1 condition\(s\) {3}\(interrupted last time; starts a new run\)/);
  assert.equal((await queryRecords("select conclusion from runs where run_id = $1", [firstRun]))[0].conclusion, "cancelled");
  for (let waited = 0; isPidAlive(writer) && waited < 50; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isPidAlive(writer), false, "nothing of the old run keeps writing");
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const runs = await runsOf(rt);
  assert.deepEqual(runs.map((run) => [path.posix.basename(run.source_file), run.conclusion]), [["01-a.md", "cancelled"], ["01-a.md", "success"], ["02-b.md", "success"]]);
  assert.notEqual(runs[0].run_id, runs[1].run_id);
});

test("stop on the running step stops the whole line, and same-directory starts are refused meanwhile", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null, "03-c.md": null });
  const env = { FAKE_CLAUDE_SLEEP_MS: "90000", FAKE_ON_WRITER_SLEEP: "02-b is printed" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const line = runInBackground(t, rt, ["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  const [, secondRun] = await line.saw(/\[2\/3\] 02-b\.md started .+ \(run ([0-9a-f-]{36})\)/);
  await writerRunning(rt, secondRun);

  const refused = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, new RegExp("demo/ is running \\(run " + secondRun + ", step 2 of 3\\)\\. Run: review-bridge status to see its progress"));
  const file = rt.bridge(["start", rt.dirOf("demo") + "/03-c.md", "--fake-cli"]);
  assert.equal(file.status, 1);
  assert.match(file.stdout, /demo\/ is running/);
  const status = rt.bridge(["status"]);
  assert.match(status.stdout, new RegExp("demo/ step 2 of 3: 02-b\\.md running \\(run " + secondRun + "\\), started \\d{4}-"));
  const steps = JSON.parse(rt.bridge(["status", "--json"]).stdout).lines;
  assert.deepEqual(steps.map((step) => [step.line.directory, step.line.position, step.line.total]), [["demo", 2, 3]]);

  assert.equal(rt.bridge(["stop", secondRun]).status, 0);
  assert.equal(await line.exited, 130, line.output());
  assert.match(line.output(), /Stopped at step 2; 3 did not run\. To carry on, run start on this directory again: only what is pending runs\./);
  assert.match(line.output(), /01-a\.md +success/);
  assert.match(line.output(), /02-b\.md +cancelled/);
  assert.match(line.output(), /03-c\.md +not run/);
  assert.equal((await runsOf(rt)).length, 2);
  const again = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.match(again.stdout, /02-b\.md +contract sha256 [0-9a-f]{4}…, 1 condition\(s\) {3}\(interrupted last time; starts a new run\)/);
});

test("after the yes: a new file does not run, a renamed one is gone, an edited one is not what was said yes to", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null, "03-d.md": null });
  const env = { FAKE_CLAUDE_SLEEP_MS: "4000", FAKE_ON_WRITER_SLEEP: "01-a is printed" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const line = runInBackground(t, rt, ["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  await line.saw(/\[1\/3\] 01-a\.md started/);
  const dir = path.join(rt.root, rt.dirOf("demo"));
  await fsp.writeFile(path.join(dir, "04-e.md"), order("04-e"));
  await fsp.rename(path.join(dir, "03-d.md"), path.join(dir, "03-renamed.md"));
  await fsp.appendFile(path.join(dir, "02-b.md"), "- One more condition.\n");
  assert.equal(await line.exited, 1, line.output());
  assert.match(line.output(), /\[2\/3\] 02-b\.md skipped: changed after the card/);
  assert.match(line.output(), /\[3\/3\] 03-d\.md skipped: no longer there/);
  assert.match(line.output(), /02-b\.md +skipped +changed after the card/);
  assert.match(line.output(), /03-d\.md +skipped +no longer there/);
  assert.match(line.output(), /2 file\(s\) appeared after the plan and did not run; run start on this directory again\./);
  assert.deepEqual((await runsOf(rt)).map((run) => path.posix.basename(run.source_file)), ["01-a.md"]);
});

test("after the yes: a changed policy and an expired authorization skip what is left, with why, and extend nothing", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  const env = { FAKE_CLAUDE_SLEEP_MS: "4000", FAKE_ON_WRITER_SLEEP: "01-a is printed" };
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"], env).status, 1);
  const line = runInBackground(t, rt, ["start", rt.dirOf("demo"), "--fake-cli", "--yes"], env);
  const [, firstRun] = await line.saw(/\[1\/2\] 01-a\.md started .+ \(run ([0-9a-f-]{36})\)/);
  // Once the first one is past its own check of the policy.
  await writerRunning(rt, firstRun);
  await fsp.writeFile(rt.paths.policyOverridePath, JSON.stringify({ schema_version: 5, writer: { disallowed_tools: ["Agent"] } }));
  assert.equal(await line.exited, 1, line.output());
  assert.match(line.output(), /02-b\.md +skipped +Work plan is stale because effective policy changed/);
  assert.deepEqual((await runsOf(rt)).map((run) => path.posix.basename(run.source_file)), ["01-a.md"]);
  await fsp.rm(rt.paths.policyOverridePath, { force: true });

  await directory(rt, "later", { "01-c.md": null, "02-d.md": null });
  const laterEnv = { FAKE_CLAUDE_SLEEP_MS: "4000", FAKE_ON_WRITER_SLEEP: "01-c is printed" };
  assert.equal(rt.bridge(["start", rt.dirOf("later"), "--fake-cli"], laterEnv).status, 1);
  const later = runInBackground(t, rt, ["start", rt.dirOf("later"), "--fake-cli", "--yes"], laterEnv);
  await later.saw(/\[1\/2\] 01-c\.md started/);
  const [{ plan_sha256: sha }] = await queryRecords("select plan_sha256 from plans where project_id = $1 and source_file = $2 and shown_at is not null order by shown_at desc limit 1", [rt.paths.projectId, rt.dirOf("later") + "/02-d.md"]);
  const file = path.join(rt.paths.authorizationsDir, "plan-" + sha + ".json");
  const authorization = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...authorization, expires_at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(await later.exited, 1, later.output());
  assert.match(later.output(), /02-d\.md +skipped +Authorization is expired\./);
});

test("at a terminal: one yes, recorded as the terminal's; n authorizes nothing; Ctrl+C stops the line", { ...LIMIT, skip: ptySkip }, async (t) => {
  const rt = await install(t);
  const shell = (args, env = {}) => {
    const screen = terminal([bootstrap, ...args], { cwd: rt.root, env: { ...process.env, ...env } });
    t.after(() => screen.kill());
    return screen;
  };
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  const no = shell(["start", rt.dirOf("demo"), "--fake-cli"]);
  await no.waitFor(/Run these 2 in this order\? \[y\/N\]/);
  no.press("n" + KEYS.enter);
  assert.equal(await no.exited, 1);
  assert.match(no.text(), /Not started\. Nothing was authorized\./);
  const stale = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /No card was shown for this directory/);

  const yes = shell(["start", rt.dirOf("demo"), "--fake-cli"]);
  await yes.waitFor(/Run these 2 in this order\? \[y\/N\]/);
  yes.press("y" + KEYS.enter);
  assert.equal(await yes.exited, 0, yes.text());
  assert.deepEqual((await runsOf(rt)).map((run) => run.authorized_via), ["terminal", "terminal"]);

  await directory(rt, "slow", { "01-c.md": null, "02-d.md": null });
  const slow = shell(["start", rt.dirOf("slow"), "--fake-cli"], { FAKE_CLAUDE_SLEEP_MS: "90000" });
  await slow.waitFor(/Run these 2 in this order\? \[y\/N\]/);
  slow.press("y" + KEYS.enter);
  const [, runId] = await (async () => {
    await slow.waitFor(/\[1\/2\] 01-c\.md started/);
    return /\[1\/2\] 01-c\.md started .+ \(run\s+([0-9a-f-]{36})\)/s.exec(slow.text());
  })();
  await writerRunning(rt, runId);
  slow.press(KEYS.ctrlC);
  assert.equal(await slow.exited, 130, slow.text());
  assert.match(slow.text(), /Stopped at step 1; 2 did not run\./);
  assert.equal((await queryRecords("select status from runs where run_id = $1", [runId]))[0].status, "completed");
});

test("delivered is what the records say: skipped until its record is cleaned; a renamed file is its work order by the id the yes wrote", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null });
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]).status, 1);
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]).status, 0);
  const [{ run_id: runId }] = await runsOf(rt);
  const delivered = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  assert.match(delivered.stdout, /1 delivered, 0 not a work order, 0 to run/);
  assert.match(delivered.stdout, /Nothing to run\./);
  // The results folder says nothing either way.
  await fsp.rm(path.join(rt.root, ".review-bridge", "results"), { recursive: true, force: true });
  assert.match(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]).stdout, /1 delivered/);
  // Delivered is the work order's, by the card's rule (Fortes 2026-11-09): renamed, the id the yes wrote
  // into it says it is the same work order, still delivered.
  const dir = path.join(rt.root, rt.dirOf("demo"));
  await fsp.rename(path.join(dir, "01-a.md"), path.join(dir, "01-renamed.md"));
  const renamed = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
  assert.match(renamed.stdout, /1 delivered, 0 not a work order, 0 to run/);
  await fsp.rename(path.join(dir, "01-renamed.md"), path.join(dir, "01-a.md"));
  // The same text with its id taken out is a new work order, though its name is the delivered one's.
  const withId = await fsp.readFile(path.join(dir, "01-a.md"), "utf8");
  await fsp.writeFile(path.join(dir, "01-a.md"), sealedText(withId));
  const idless = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.match(idless.stdout, /0 delivered, 0 not a work order, 1 to run/);
  await fsp.writeFile(path.join(dir, "01-a.md"), withId);
  assert.match(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]).stdout, /1 delivered/);
  assert.equal(rt.bridge(["clean", runId]).status, 0);
  const cleaned = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.match(cleaned.stdout, /0 delivered, 0 not a work order, 1 to run/);
});

test("only a directory directly under work-packages/ is a line; flags about one work order are refused", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null });
  await fsp.mkdir(path.join(rt.root, rt.dirOf("demo"), "deeper"));
  await fsp.mkdir(path.join(rt.root, "elsewhere"));
  const root = rt.bridge(["start", ".review-bridge/work-packages/", "--fake-cli"]);
  assert.notEqual(root.status, 0);
  assert.match(root.stderr, /work-packages\/ itself is not a line: give a subdirectory or a file/);
  const deep = rt.bridge(["start", rt.dirOf("demo") + "/deeper/", "--fake-cli"]);
  assert.notEqual(deep.status, 0);
  assert.match(deep.stderr, /more than one level under work-packages\//);
  const outside = rt.bridge(["start", "elsewhere", "--fake-cli"]);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /is not under \.review-bridge\/work-packages\//);
  const flag = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--as-new"]);
  assert.notEqual(flag.status, 0);
  assert.match(flag.stderr, /are about one work order/);
  assert.deepEqual(await runsOf(rt), []);
});

test("a file name Bridge cannot use, and a budget the policy refuses, are listed and not run; the others go on, whatever their language", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "登入", {
    "01-a.md": null,
    "02-工單.md": order("chinese"),
    "03-over.md": "---\nbudget:\n  rounds: 999\n---\n" + order("over"),
    "04-x..md": order("dots"),
  });
  const card = rt.bridge(["start", rt.dirOf("登入"), "--fake-cli"]);
  assert.match(card.stdout, /0 delivered, 2 not a work order, 2 to run/);
  assert.match(card.stdout, /02-工單\.md +contract sha256 /);
  assert.match(card.stdout, /03-over\.md +not a work order \(line 3: budget\.rounds is 999, over the policy limit/);
  assert.match(card.stdout, /04-x\.\.md +not a work order \(its file name starts or ends with a dot or a space\)/);
  const ran = rt.bridge(["start", rt.dirOf("登入"), "--fake-cli", "--yes"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.deepEqual((await runsOf(rt)).map((run) => path.posix.basename(run.source_file)), ["01-a.md", "02-工單.md"]);
  assert.ok((await fsp.readdir(path.join(rt.root, ".review-bridge", "results", "登入", "02-工單"))).some((entry) => entry.endsWith(" success.md")));
});

test("a directory whose name holds a space prints a command that can be pasted back", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "исправить вход", { "01-a.md": null });
  const card = rt.bridge(["start", rt.dirOf("исправить вход"), "--fake-cli"]);
  assert.match(card.stdout, /run again: review-bridge start "\.review-bridge\/work-packages\/исправить вход" --fake-cli --yes/);
});

test("a card made before a file changed is not taken by --yes, and in a Git project the card counts what is uncommitted", LIMIT, async (t) => {
  const rt = await install(t, { withGit: true });
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  await fsp.writeFile(path.join(rt.root, "scratch.txt"), "mine\n");
  const card = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.match(card.stdout, /Working tree has 1 uncommitted file\(s\); they will be listed in each result's third list\./);
  await fsp.appendFile(path.join(rt.root, rt.dirOf("demo"), "02-b.md"), "- One more.\n");
  const refused = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /The directory changed after you saw the card/);
  assert.deepEqual(await runsOf(rt), []);
  const added = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]);
  assert.equal(added.status, 1);
  await fsp.writeFile(path.join(rt.root, rt.dirOf("demo"), "03-c.md"), order("03-c"));
  const ran = rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /03-c\.md +appeared after the card {3}\(skip\)/);
  assert.match(ran.stdout, /1 file\(s\) appeared after the plan and did not run/);
  assert.equal((await runsOf(rt)).length, 2);
});

test("every query a line adds reads what this directory needs, whatever the history holds", LIMIT, async (t) => {
  const rt = await install(t);
  await directory(rt, "demo", { "01-a.md": null, "02-b.md": null });
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli"]).status, 1);
  assert.equal(rt.bridge(["start", rt.dirOf("demo"), "--fake-cli", "--yes"]).status, 0);
  const client = await connect(path.join(dataHome, "postgres"), { database: "bridge" });
  // Closed by the test itself: install added its cleanup first, and node:test runs after hooks in the
  // order they were added, so `down` would stop the server under this open connection (57P01).
  try {
    const projectId = rt.paths.projectId;
    const files = [rt.dirOf("demo") + "/01-a.md", rt.dirOf("demo") + "/02-b.md"];
    // A history a small table would hide: other work orders of this project, and many plans and runs of
    // this very work order, finished. On a table of a few rows a planner's choice of index proves nothing.
    const HISTORY = 3000;
    await client.query("begin");
    await client.query("create temp table seed_orders on commit drop as select w.* from work_orders w cross join generate_series(1, $1::int) where w.project_id = $2 and w.last_file_name = $3", [HISTORY, projectId, files[0]]);
    await client.query("update seed_orders set work_order_id = gen_random_uuid(), last_file_name = 'old/' || gen_random_uuid()");
    await client.query("insert into work_orders select * from seed_orders");
    await client.query("create temp table seed_plans on commit drop as select p.* from plans p cross join generate_series(1, $1::int) where p.project_id = $2 and p.source_file = $3", [HISTORY, projectId, files[0]]);
    await client.query("update seed_plans set plan_sha256 = md5(random()::text) || md5(random()::text), proposed_run_id = gen_random_uuid(), shown_at = shown_at - interval '1 day'");
    await client.query("insert into plans select * from seed_plans");
    await client.query("create temp table seed_runs on commit drop as select r.* from runs r join plans p using (plan_sha256) cross join generate_series(1, $1::int) where p.project_id = $2 and p.source_file = $3", [HISTORY, projectId, files[0]]);
    await client.query("alter table seed_runs add column row_id serial");
    await client.query("alter table seed_plans add column row_id serial");
    await client.query("update seed_runs r set run_id = gen_random_uuid(), created_at = r.created_at - interval '1 day', plan_sha256 = s.plan_sha256 from seed_plans s where s.row_id = r.row_id");
    await client.query("alter table seed_runs drop column row_id");
    await client.query("insert into runs select * from seed_runs");
    await client.query("commit");
    const [{ work_order_id: workOrderId }] = (await client.query("select work_order_id from work_orders where project_id = $1 and last_file_name = $2", [projectId, files[0]])).rows;
    // A closed run's entry stays in a partial index until vacuum, and each costs a look at the table, so
    // what this file's earlier tests left would count against the query being measured.
    await client.query("vacuum analyze work_orders, plans, runs");
    const explained = async (read) => {
      let plan = "";
      await read({ query: async (sql, values) => { plan = (await client.query("explain (analyze, buffers) " + sql, values)).rows.map((row) => row["QUERY PLAN"]).join("\n"); return { rows: [{ work_order_id: workOrderId }] }; } });
      t.diagnostic(plan);
      return plan;
    };
    // The blocks the lookup of these two files touched when it ran (planning has its own count), far below
    // the history behind them.
    const buffers = (plan) => Math.max(...[...plan.split("Planning:")[0].matchAll(/Buffers: shared (?:hit=(\d+))?(?: read=(\d+))?/g)].map((match) => Number(match[1] || 0) + Number(match[2] || 0)));
    // Each file is the work order its front matter id names (the yes above wrote both ids): one probe of
    // the primary key, however many other work orders the project holds.
    const orders = await Promise.all(files.map(async (file) => ({ file, id: workOrderIdOf(await fsp.readFile(path.join(rt.root, file), "utf8")) })));
    assert.ok(orders.every((order) => order.id), "the yes wrote each file's id");
    const latest = await explained((db) => latestRunsOfWorkOrders(db, { projectId, repoRoot: rt.root, orders }));
    assert.match(latest, /work_orders_pkey/);
    assert.match(latest, /runs_by_work_order/);
    assert.ok(buffers(latest) < 60, latest);
    const cards = await explained((db) => latestCardsOfFiles(db, { projectId, files }));
    assert.match(cards, /plans_shown_by_file/);
    assert.ok(buffers(cards) < 60, cards);
    // Blocks say nothing here: vacuum does not shrink an index, so this one's pages depend on what ran
    // before it (1 on one machine, 83 on another). What must hold is that a partial index holding only
    // running runs gives nothing to throw away, however long the history behind it.
    const active = await explained((db) => activeLineSteps(db, projectId));
    assert.match(active, /Index Scan using runs_active\w* on runs r .*rows=0(?:\.0+)? loops=1/, active);
    assert.doesNotMatch(active, /Rows Removed by Filter: [1-9]/, active);
    t.diagnostic("runs_active_by_work_order: " + (await client.query("select pg_relation_size('runs_active_by_work_order') as bytes")).rows[0].bytes + " bytes");
  } finally {
    await client.end();
  }
});
