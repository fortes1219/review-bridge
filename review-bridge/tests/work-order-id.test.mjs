// The work order is the id Bridge writes into its front matter on the first yes (DECISIONS 2026-11-08
// 10:4x), as Docusaurus reads a document's id there. No database: the records are a stub.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildContract } from "../features/workOrder/contract.mjs";
import { writeWorkOrderIds } from "../features/workOrder/workOrderForm.mjs";
import { parseWorkOrder, sealedText, withWorkOrderId, workOrderIdOf } from "../features/workOrder/workOrderFormat.mjs";
import { cardStillMatches, identifyWorkOrder, latestRunsOfWorkOrders, sameFile } from "../features/workOrder/workOrderRecords.mjs";
import { digest } from "../utils/digest.mjs";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BODY = "# Farm\n\n<!-- bridge:requested_work -->\nBuild a farm.\n\n<!-- bridge:acceptance -->\n- The farm shows.\n";

test("the id goes into the front matter and comes out again: the person's text is left byte for byte", () => {
  const plain = withWorkOrderId(BODY, ID);
  assert.equal(plain, "---\nid: " + ID + "\n---\n" + BODY, "a file without front matter gets one holding only the id");
  assert.equal(workOrderIdOf(plain), ID);
  assert.equal(sealedText(plain), BODY);
  const theirs = "---\r\npriority: high\r\n# a comment of theirs\r\nsource_id: SHOP-1\r\n---\r\n" + BODY.replaceAll("\n", "\r\n");
  const marked = withWorkOrderId(theirs, ID);
  assert.equal(marked.split("\r\n").slice(0, 3).join("|"), "---|id: " + ID + "|priority: high", "their front matter keeps its lines, the id first, in their line endings");
  assert.equal(sealedText(marked), theirs);
  assert.equal(parseWorkOrder(sealedText(marked).trim()).frontmatter.source_id, "SHOP-1", "source_id stays the person's reference");
  assert.equal(withWorkOrderId(marked, OTHER), withWorkOrderId(theirs, OTHER), "an id there is replaced, not added twice");
  assert.equal(workOrderIdOf(BODY), null);
  assert.equal(sealedText(BODY), BODY);
  // The contract is cut from the sealed text, so writing the id changes no hash.
  const contractOf = (text) => digest(buildContract({ workPackage: { work_package_id: "farm", task_file: "farm.md", task: sealedText(text).trim() }, format: parseWorkOrder(sealedText(text).trim()) }));
  assert.equal(contractOf(plain), contractOf(BODY));
});

// The records as a stub: work orders by id, with the file the records last saw them in.
function records(orders) {
  return {
    async query(sql, values) {
      if (/select last_file_name from work_orders/.test(sql)) {
        const order = orders[values[0]];
        return { rows: order ? [{ last_file_name: order.file }] : [] };
      }
      if (/from work_order_versions/.test(sql)) {
        const order = orders[values[0]];
        return { rows: order ? [{ version_no: 1, content_sha256: digest(order.text), source_text: order.text, title: "Farm" }] : [] };
      }
      throw new Error("unexpected query: " + sql);
    },
  };
}

test("the work order a file is: its id; none is new; a moved file keeps it; a copy beside the original is new, a hard link to it is the same; content is never compared", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-order-id-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await fsp.mkdir(path.join(repoRoot, "wp"));
  const text = BODY.trim();
  const identify = (db, fileName, id) => identifyWorkOrder(db, { projectId: "p", fileName, text, id, repoRoot });

  const fresh = await identify(records({}), "wp/farm.md", null);
  assert.equal(fresh.decision, "new");
  assert.match(fresh.work_order_id, /^[0-9a-f-]{36}$/, "the card makes the id the yes will write");
  // Two work orders from one template and no source_id: each new, never a rename of the other.
  assert.notEqual((await identify(records({}), "wp/barn.md", null)).work_order_id, fresh.work_order_id);

  const known = records({ [ID]: { file: "wp/farm.md", text } });
  assert.deepEqual([(await identify(known, "wp/farm.md", ID)).decision, (await identify(known, "wp/farm.md", ID)).work_order_id], ["same", ID]);
  // Moved or renamed: the old file is gone, the id is the work order.
  const moved = await identify(known, "wp/line/01-farm.md", ID);
  assert.deepEqual([moved.decision, moved.work_order_id, moved.moved_from], ["same", ID, "wp/farm.md"]);
  // A copy: the file the records saw still holds the id and is another file, so this one is a new work order.
  await fsp.writeFile(path.join(repoRoot, "wp", "farm.md"), withWorkOrderId(BODY, ID));
  await fsp.copyFile(path.join(repoRoot, "wp", "farm.md"), path.join(repoRoot, "wp", "farm-copy.md"));
  const copy = await identify(known, "wp/farm-copy.md", ID);
  assert.equal(copy.decision, "new");
  assert.notEqual(copy.work_order_id, ID);
  assert.equal(copy.copy_of, "wp/farm.md");
  // A hard link: the other name of the same file (the same device and inode, as find -samefile tells it)
  // is the same work order, never a copy whose new id would overwrite the one both names hold.
  await fsp.link(path.join(repoRoot, "wp", "farm.md"), path.join(repoRoot, "wp", "farm-link.md"));
  const linked = await identify(known, "wp/farm-link.md", ID);
  assert.deepEqual([linked.decision, linked.work_order_id, linked.copy_of], ["same", ID, undefined]);
  assert.equal(await sameFile(repoRoot, "wp/farm.md", "wp/farm-link.md"), true);
  assert.equal(await sameFile(repoRoot, "wp/farm.md", "wp/farm-copy.md"), false);
  // A file system that gives no file id cannot tell a link from a copy: refused, not guessed.
  const noIds = { stat: async () => ({ dev: 7n, ino: 0n }) };
  await assert.rejects(sameFile(repoRoot, "wp/farm.md", "wp/farm-link.md", noIds), /gives no file id/);
  // An id the records do not know (cleared, or from elsewhere) is kept.
  assert.deepEqual([(await identify(records({}), "wp/farm.md", OTHER)).decision, (await identify(records({}), "wp/farm.md", OTHER)).work_order_id], ["new", OTHER]);
});

// The card and the yes know a work order by one rule, the front matter id (Fortes 2026-11-09): a file
// without one is new at both steps, even under a name the records last saw for another work order.
test("a file without an id is a new work order at the card and at the yes; a file with one is that work order at both", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-order-id-yes-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const text = BODY.trim();
  const known = records({ [ID]: { file: "wp/farm.md", text } });
  const identify = (fileName, id, extra = {}) => identifyWorkOrder(known, { projectId: "p", fileName, text, id, repoRoot, ...extra });

  // The name the records last saw for ID, written over without its id: new at the card, taken at the yes.
  const rewritten = await identify("wp/farm.md", null);
  assert.equal(rewritten.decision, "new");
  assert.notEqual(rewritten.work_order_id, ID);
  assert.equal(rewritten.file_id, null);
  assert.equal(cardStillMatches(rewritten, BODY), true);

  // With its id: that work order at the card, and at the yes while the file still holds it.
  const kept = await identify("wp/farm.md", ID);
  assert.deepEqual([kept.decision, kept.work_order_id, kept.file_id], ["same", ID, ID]);
  assert.equal(cardStillMatches(kept, withWorkOrderId(BODY, ID)), true);

  // A new card whose file gained an id since (another card's yes wrote it) shows another work order
  // than the file is now; one whose id was taken out shows one the file no longer is.
  assert.equal(cardStillMatches(rewritten, withWorkOrderId(BODY, ID)), false);
  assert.equal(cardStillMatches(kept, BODY), false);
  // --as-new is meant new, whatever id the file holds.
  const asNew = await identify("wp/farm.md", ID, { asNew: true });
  assert.equal(asNew.decision, "new");
  assert.equal(cardStillMatches(asNew, withWorkOrderId(BODY, OTHER)), true);
  // A plan from inline text has no work order to check.
  assert.equal(cardStillMatches(undefined, BODY), true);
});

// A directory's line asks the records by the same rule (Fortes 2026-11-09): delivered and interrupted are
// the work order's, never the name's.
test("a line finds each file's latest run by its front matter id: none is new, a copy is new, a hard link and a rename are the work order", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-order-id-line-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await fsp.mkdir(path.join(repoRoot, "wp"));
  await fsp.writeFile(path.join(repoRoot, "wp", "01-a.md"), withWorkOrderId(BODY, ID));
  await fsp.copyFile(path.join(repoRoot, "wp", "01-a.md"), path.join(repoRoot, "wp", "02-copy.md"));
  await fsp.link(path.join(repoRoot, "wp", "01-a.md"), path.join(repoRoot, "wp", "03-link.md"));
  const asked = [];
  const db = {
    async query(sql, values) {
      asked.push(values);
      assert.match(sql, /join work_orders w on w\.work_order_id = o\.id and w\.project_id = \$1/);
      // The records last saw ID in 01-a.md, delivered; OTHER is a work order of another name.
      const run = { run_id: "r1", status: "completed", conclusion: "success", closed_reason: "review_pass", closed_at: "2026-11-09T00:00:00Z" };
      const recorded = { [ID]: "wp/01-a.md", [OTHER]: "wp/gone.md" };
      return { rows: values[1].map((file, index) => ({ file, work_order_id: values[2][index], last_file_name: recorded[values[2][index]], ...run })) };
    },
  };
  const latest = await latestRunsOfWorkOrders(db, {
    projectId: "p", repoRoot, orders: [
      { file: "wp/01-a.md", id: ID }, { file: "wp/02-copy.md", id: ID }, { file: "wp/03-link.md", id: ID },
      { file: "wp/04-renamed.md", id: OTHER }, { file: "wp/05-new.md", id: null },
    ],
  });
  assert.deepEqual([...latest.keys()].sort(), ["wp/01-a.md", "wp/03-link.md", "wp/04-renamed.md"]);
  assert.deepEqual(asked[0][1], ["wp/01-a.md", "wp/02-copy.md", "wp/03-link.md", "wp/04-renamed.md"], "a file without an id is not asked for");
  // A directory where no file holds an id asks nothing.
  assert.equal((await latestRunsOfWorkOrders(db, { projectId: "p", repoRoot, orders: [{ file: "wp/05-new.md", id: null }] })).size, 0);
  assert.equal(asked.length, 1);
});

test("after the yes the id is written into the file; nothing else changes, and a file changed since the card is left alone", async (t) => {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-work-order-id-write-"));
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const file = path.join(repoRoot, "farm.md");
  await fsp.writeFile(file, BODY);
  const plan = { task_file: "farm.md", task_sha256: digest(BODY.trim()), work_order: { work_order_id: ID } };
  await writeWorkOrderIds({ repoRoot }, [plan]);
  assert.equal(await fsp.readFile(file, "utf8"), "---\nid: " + ID + "\n---\n" + BODY);
  await writeWorkOrderIds({ repoRoot }, [plan]);
  assert.equal(await fsp.readFile(file, "utf8"), "---\nid: " + ID + "\n---\n" + BODY, "written once");
  const edited = path.join(repoRoot, "barn.md");
  await fsp.writeFile(edited, BODY + "- Edited after the card.\n");
  await writeWorkOrderIds({ repoRoot }, [{ ...plan, task_file: "barn.md" }]);
  assert.equal(await fsp.readFile(edited, "utf8"), BODY + "- Edited after the card.\n", "not what was said yes to: left as it is");
});
