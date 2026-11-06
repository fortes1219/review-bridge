// A work order's file name in any language (Owner 2026-11-06). Every model call here is the fake CLI.
// Keeps the person's database out of these tests (see the fixture).
import { dataHome, queryRecords } from "./fixtures/isolatedDataHome.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { orderWorkOrders } from "../features/workOrder/line.mjs";
import { canonicalTaskFile } from "../features/workOrder/workOrderRecords.mjs";
import { nfc, workOrderNameProblem } from "../utils/workOrderName.mjs";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(runtime, "..");
const LIMIT = { timeout: 240_000 };
const WORK_ORDERS = ".review-bridge/work-packages/";

// グ is one code point in NFC and ク plus a combining mark in NFD, the form a macOS disk hands back.
const JAPANESE = "ログイン修正";
const NAMES = ["修登入總價", JAPANESE, "исправить вход", "إصلاح الدخول"];

const order = (name, text = "") => "# Work order: " + name + "\n\n<!-- bridge:requested_work -->\n## Work\nFix it.\n\n<!-- bridge:acceptance -->\n## Acceptance\n- " + name + " works." + text + "\n";

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function install(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-name-"));
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "name-demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
  const init = spawnSync(process.execPath, [
    path.join(packageRoot, "bridge.mjs"), "init", "--target", root, "--writer", "claude", "--reviewer", "codex", "--yes", "--fake-cli", "--port", String(await freePort()),
  ], { cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, REVIEW_BRIDGE_DATA_HOME: dataHome } });
  assert.equal(init.status, 0, init.stderr);
  const bridge = (args) => spawnSync(process.execPath, [path.join(runtime, "bootstrap.mjs"), ...args], { cwd: root, encoding: "utf8", windowsHide: true, env: process.env });
  t.after(async () => {
    bridge(["down"]);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const projectId = JSON.parse(await fsp.readFile(path.join(root, ".review-bridge", "bridge.json"), "utf8")).project_id;
  const write = (name, text = order(nfc(name))) => fsp.writeFile(path.join(root, WORK_ORDERS, name + ".md"), text);
  const results = (name) => fsp.readdir(path.join(root, ".review-bridge", "results", name));
  return { root, bridge, projectId, write, results };
}

test("what a work order's name may be", () => {
  for (const name of [...NAMES, "01-api_login.v2", "a b", "-x", "_x", "x-", "한글", "नमस्ते", "٠١-x", "c".repeat(80), "修".repeat(60)]) assert.equal(workOrderNameProblem(name), null, name);
  for (const [name, says] of [
    ["a/b", /path separator/], ["a\\b", /path separator/], ["../x", /path separator/],
    [" x", /starts or ends/], ["x ", /starts or ends/], [".x", /starts or ends/], ["x.", /starts or ends/], ["..", /starts or ends/],
    ["a  b", /single spaces/], ["a\tb", /single spaces/], ["a‏b", /single spaces/], ["a:b", /single spaces/], ["a*b", /single spaces/], ["😀", /single spaces/], ["", /single spaces/],
    ["c".repeat(81), /longer than/],
    // 61 characters of three bytes each: under the characters, over the bytes a file name beside it can hold.
    ["修".repeat(61), /longer than/],
  ]) assert.match(workOrderNameProblem(name), says, JSON.stringify(name));
  // The two forms of one name are one answer, and one order.
  assert.equal(workOrderNameProblem(JAPANESE.normalize("NFD")), null);
  assert.notEqual(JAPANESE.normalize("NFD"), JAPANESE);
  assert.deepEqual(orderWorkOrders(["01-" + JAPANESE.normalize("NFD") + ".md", "01-ロ.md"]).map((item) => nfc(item.name)), ["01-ロ.md", "01-" + JAPANESE + ".md"]);
});

test("the records name a file in NFC, whichever form the path came in", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-name-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  assert.equal(canonicalTaskFile(root, WORK_ORDERS + JAPANESE.normalize("NFD") + ".md"), WORK_ORDERS + JAPANESE + ".md");
  assert.equal(canonicalTaskFile(root, WORK_ORDERS + JAPANESE + ".md"), WORK_ORDERS + JAPANESE + ".md");
});

test("a work order named in any language goes from its card through its yes to a result under its own name", LIMIT, async (t) => {
  const rt = await install(t);
  for (const name of NAMES) {
    await rt.write(name);
    const file = WORK_ORDERS + name + ".md";
    const card = rt.bridge(["start", file, "--fake-cli"]);
    assert.equal(card.status, 1, name + ": " + card.stdout + card.stderr);
    assert.ok(card.stdout.includes("Work order:   " + file), name + ": " + card.stdout);
    assert.match(card.stdout, /Needs authorization/);
    assert.equal(rt.bridge(["start", file, "--fake-cli", "--yes"]).status, 1, name + ": the first yes ends at the sealed card");
    const ran = rt.bridge(["start", file, "--fake-cli", "--yes"]);
    assert.equal(ran.status, 0, name + ": " + ran.stdout + ran.stderr);
    const entries = await rt.results(name);
    assert.ok(entries.some((entry) => entry.startsWith(name + " ") && entry.endsWith(" success.md")), name + ": " + entries.join(", "));
  }
  const rows = await queryRecords("select p.source_file, p.body->>'work_package_id' as id, r.conclusion from runs r join plans p using (plan_sha256) where r.project_id = $1 order by r.created_at", [rt.projectId]);
  assert.deepEqual(rows, NAMES.map((name) => ({ source_file: WORK_ORDERS + name + ".md", id: name, conclusion: "success" })));
});

test("one name in NFD and in NFC is one work order, with one results folder", LIMIT, async (t) => {
  const rt = await install(t);
  const decomposed = JAPANESE.normalize("NFD");
  await rt.write(decomposed);
  assert.equal(rt.bridge(["start", WORK_ORDERS + decomposed + ".md", "--fake-cli"]).status, 1);
  assert.equal(rt.bridge(["start", WORK_ORDERS + decomposed + ".md", "--fake-cli", "--yes"]).status, 1);
  const first = rt.bridge(["start", WORK_ORDERS + decomposed + ".md", "--fake-cli", "--yes"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const [{ work_order_id: id, last_file_name: recorded }] = await queryRecords("select work_order_id, last_file_name from work_orders where project_id = $1", [rt.projectId]);
  assert.equal(recorded, WORK_ORDERS + JAPANESE + ".md");
  assert.deepEqual(await rt.results(JAPANESE).then((entries) => entries.map(nfc).filter((entry) => entry.endsWith(".md")).length), 1);

  // A file another work order is not "gone" when the disk holds its name in the other form, so a similar
  // new file is not guessed to be it renamed.
  await rt.write("copy of it", order(JAPANESE));
  const copy = rt.bridge(["start", WORK_ORDERS + "copy of it.md", "--fake-cli"]);
  assert.match(copy.stdout, /New work order/, copy.stdout);

  // The same name in the other form, where the disk tells the two apart.
  await fsp.rm(path.join(rt.root, WORK_ORDERS, decomposed + ".md"));
  await rt.write(JAPANESE);
  const again = rt.bridge(["start", WORK_ORDERS + JAPANESE + ".md", "--fake-cli"]);
  assert.match(again.stdout, /still version 1/, again.stdout);
  assert.equal(rt.bridge(["start", WORK_ORDERS + JAPANESE + ".md", "--fake-cli", "--yes"]).status, 1);
  assert.equal(rt.bridge(["start", WORK_ORDERS + JAPANESE + ".md", "--fake-cli", "--yes"]).status, 0);
  const rows = await queryRecords("select work_order_id from runs where project_id = $1", [rt.projectId]);
  assert.deepEqual(rows.map((row) => row.work_order_id), [id, id]);
  assert.deepEqual((await fsp.readdir(path.join(rt.root, ".review-bridge", "results"))).map(nfc), [JAPANESE]);
});

test("in a directory, delivered holds across the two forms, and both forms side by side are not run twice", LIMIT, async (t) => {
  const rt = await install(t);
  const dir = WORK_ORDERS + "line/";
  await fsp.mkdir(path.join(rt.root, dir));
  const decomposed = "01-" + JAPANESE.normalize("NFD");
  await fsp.writeFile(path.join(rt.root, dir, decomposed + ".md"), order(JAPANESE));
  assert.equal(rt.bridge(["start", dir, "--fake-cli"]).status, 1);
  assert.equal(rt.bridge(["start", dir, "--fake-cli", "--yes"]).status, 1);
  assert.equal(rt.bridge(["start", dir, "--fake-cli", "--yes"]).status, 0);
  await fsp.rm(path.join(rt.root, dir, decomposed + ".md"));
  await fsp.writeFile(path.join(rt.root, dir, "01-" + JAPANESE + ".md"), order(JAPANESE));
  const card = rt.bridge(["start", dir, "--fake-cli"]);
  assert.match(card.stdout, /1 delivered, 0 not a work order, 0 to run/, card.stdout);
  // Only where a disk keeps both: on one that folds them this is one file, and the card says so.
  await fsp.writeFile(path.join(rt.root, dir, decomposed + ".md"), order(JAPANESE));
  const entries = await fsp.readdir(path.join(rt.root, dir));
  if (entries.length === 2) assert.match(rt.bridge(["start", dir, "--fake-cli"]).stdout, /its name is the same as .+ in another Unicode form/);
});

test("a name Bridge cannot use is refused before any card, and says why", LIMIT, async (t) => {
  const rt = await install(t);
  const refused = (args, says) => {
    const result = rt.bridge(["start", ...args, "--fake-cli"]);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, says, args.join(" ") + ": " + result.stderr);
    assert.doesNotMatch(result.stdout, /Needs authorization/);
  };
  await rt.write(" lead");
  refused([WORK_ORDERS + " lead.md"], /" lead" starts or ends with a dot or a space\. Rename the file, or give --work-package\./);
  await rt.write("x.");
  refused([WORK_ORDERS + "x..md"], /"x\." starts or ends with a dot or a space/);
  await rt.write("a  b");
  refused([WORK_ORDERS + "a  b.md"], /can only have letters, digits and marks of any language/);
  await rt.write("fine");
  refused([WORK_ORDERS + "fine.md", "--work-package", "a/b"], /"a\/b" has a path separator in it/);
  assert.deepEqual(await queryRecords("select 1 from plans where project_id = $1", [rt.projectId]), []);
});
