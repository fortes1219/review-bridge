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
import { identifyWorkOrder } from "../features/workOrder/workOrderRecords.mjs";
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

test("the work order a file is: its id; none is new; a moved file keeps it; a copy beside the original is new; content is never compared", async (t) => {
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
  // A copy: the file the records saw still holds the id, so this one is a new work order.
  await fsp.writeFile(path.join(repoRoot, "wp", "farm.md"), withWorkOrderId(BODY, ID));
  const copy = await identify(known, "wp/farm-copy.md", ID);
  assert.equal(copy.decision, "new");
  assert.notEqual(copy.work_order_id, ID);
  assert.equal(copy.copy_of, "wp/farm.md");
  // An id the records do not know (cleared, or from elsewhere) is kept.
  assert.deepEqual([(await identify(records({}), "wp/farm.md", OTHER)).decision, (await identify(records({}), "wp/farm.md", OTHER)).work_order_id], ["new", OTHER]);
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
