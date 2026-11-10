// What the result says when the writer stops for the person (runs 8709b3f5 and f645ccf5, 2026-11-09):
// the conditions appear once, as the writer reported them, not first as "unknown" rows nobody judged; the
// person is told what is theirs to decide and that the work order is where they answer it. And the line an
// upgrade prints when it backs the database up is the project's language's. No CLI, no database.
import assert from "node:assert/strict";
import test from "node:test";

import { composeSections } from "../features/workOrder/delivery.mjs";
import { createTranslator } from "../features/workOrder/i18n.mjs";
import { databaseBackedUp, onDatabaseBackedUp } from "../service/database/notices.mjs";

const run = { run_id: "run-8709b3f5", status: "completed", conclusion: "action_required", closed_reason: "needs_human", closed_at: "2026-11-09T00:00:00.000Z", updated_at: "2026-11-09T00:00:00.000Z" };
const workPackage = { work_package_id: "01", task_file: ".review-bridge/work-packages/loose2/01.md", budget: { rounds: 2 }, scope: {} };
const contract = { acceptance: [{ id: "AC1", text: "The list shows overdue items first." }, { id: "AC2", text: "Each item shows its due date." }] };
const writerResult = {
  event: "writer.result", status: "blocked", needs_human: [], unverified: [],
  criteria: [{ id: "AC1", status: "not_done", note: "which field is the due date is not said" }, { id: "AC2", status: "not_done", note: "same" }],
};

test("a writer that stopped for the person: each condition once, what to decide, and the work order as where to answer", async () => {
  const t = await createTranslator("zh-TW");
  const sections = composeSections({ t, run, workPackage, plan: null, contract, events: [writerResult], delta: null });
  assert.deepEqual(sections.acceptance, [], "the reviewer never judged: no row of unknowns");
  const why = sections.why.join("\n");
  assert.equal((why.match(/AC1/g) || []).length, 1, "AC1 appears once\n" + why);
  assert.match(why, /^writer 沒做完就停下來，等你決定：工單哪裡要寫清楚、或哪條條件要改。答案寫在工單 \.review-bridge\/work-packages\/loose2\/01\.md 裡/m);
  assert.match(why, /^- AC1 not_done: which field is the due date is not said$/m);
  assert.deepEqual(sections.next, ["在 01.md 寫清楚上面 writer 問的或卡住的地方（或改掉它做不到的條件），存檔後再 start 一次。"], "the file by its name: the next step holds no path or command");
});

test("a run the reviewer did judge still lists every condition as Bridge decided it", async () => {
  const t = await createTranslator("en");
  const decided = { event: "acceptance", rows: [{ id: "AC1", result: "proven", statement: "The list shows overdue items first.", verdict: "pass", evidence: "list.ts:9" }] };
  const sections = composeSections({ t, run: { ...run, conclusion: "success", closed_reason: null }, workPackage, plan: null, contract, events: [writerResult, decided], delta: null });
  assert.match(sections.acceptance[0], /^- AC1 proven: The list shows overdue items first\./);
});

test("the backup an upgrade makes is said by the line the command entry gives, in the project's language", async () => {
  const said = [];
  onDatabaseBackedUp(async (folder) => { said.push(folder); });
  await databaseBackedUp("/data/backups/database/2026-11-09T00-00-00-000Z");
  assert.deepEqual(said, ["/data/backups/database/2026-11-09T00-00-00-000Z"]);
  assert.equal((await createTranslator("zh-TW"))("database.backed_up", { folder: "D:\\b" }), "已在升級資料庫前備份到 D:\\b。");
  assert.equal((await createTranslator("en"))("database.backed_up", { folder: "/b" }), "Backed up the database to /b before upgrading it.");
});
