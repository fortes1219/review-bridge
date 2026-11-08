import assert from "node:assert/strict";
import test from "node:test";

import { budgetProblems, BLOCK_KEYS, parseWorkOrder, WorkOrderFormatError } from "../features/workOrder/workOrderFormat.mjs";

const BODY = "# Farm\n\n<!-- bridge:requested_work -->\nBuild a farm.\n\n<!-- bridge:acceptance -->\n- The farm shows.\n";
const refused = (text) => {
  try {
    parseWorkOrder(text);
  } catch (error) {
    assert.ok(error instanceof WorkOrderFormatError, error.message);
    return error.problems;
  }
  assert.fail("the work order was accepted");
};

test("frontmatter is data: its keys are read, any other key and any value out of range is refused with its line", () => {
  const read = parseWorkOrder([
    "---",
    "priority: high",
    "effort: low",
    "budget:",
    "  tokens: 2000000",
    "  run_timeout: 7200000",
    "source_id: SHOP-412",
    "---",
    BODY,
  ].join("\n"));
  assert.deepEqual(
    [read.frontmatter.priority, read.frontmatter.effort, read.frontmatter.budget, read.frontmatter.source_id, read.frontmatter.end, read.title.line],
    ["high", "low", { tokens: 2_000_000, run_timeout: 7_200_000 }, "SHOP-412", 8, 9],
  );
  assert.deepEqual(read.frontmatter.budget_lines, { tokens: 5, run_timeout: 6 });
  assert.deepEqual(refused("---\npriority: high\nowner: me\n---\n" + BODY), ["line 3: unknown key owner; the frontmatter takes priority, effort, writer, reviewer, budget, source_id"]);
  assert.deepEqual(refused("---\npriority: soon\n---\n" + BODY), ["line 2: priority must be one of low, medium, high, urgent"]);
  assert.deepEqual(refused("---\neffort: max\n---\n" + BODY), ["line 2: effort must be one of low, medium, high"]);
  assert.deepEqual(refused("---\nbudget:\n  rounds: 0\n  turns: 5\n  call_timeout: 1000\n---\n" + BODY), [
    "line 3: budget.rounds must be a positive whole number",
    "line 4: budget.turns is not a budget key; the keys are tokens, tokens_per_call, call_timeout, test_timeout, run_timeout, rounds",
    "line 5: budget.call_timeout must be at least 60000 ms",
  ]);
  assert.deepEqual(refused("---\npriority: high\n" + BODY), ["line 1: the frontmatter opened here is not closed by a line that is only ---"]);
  assert.match(refused("---\npriority: high\npriority: low\n---\n" + BODY)[0], /^line 3: /);
  // No frontmatter is fine; so is one holding only comments.
  assert.equal(parseWorkOrder(BODY).frontmatter.priority, null);
  assert.equal(parseWorkOrder("---\n# priority: high\n---\n" + BODY).frontmatter.priority, null);
});

test("a writer: or reviewer: block says the model and effort of that role, and the top-level effort is the writer's", () => {
  const read = parseWorkOrder("---\nwriter:\n  model: gpt-5.6-sol\n  effort: high\nreviewer: { model: null, effort: low }\n---\n" + BODY).frontmatter;
  assert.deepEqual([read.writer.model, read.writer.effort, read.writer.lines], ["gpt-5.6-sol", "high", { model: 3, effort: 4 }]);
  assert.deepEqual([read.reviewer.model, read.reviewer.effort], [null, "low"], "null is written: the CLI's default, over the table");
  assert.equal(read.effort, "high", "the sealed contract's ticket keeps the writer's effort");
  const unwritten = parseWorkOrder("---\nwriter: { effort: low }\n---\n" + BODY).frontmatter;
  assert.equal("model" in unwritten.writer, false, "an unwritten model leaves the table's");
  assert.equal("model" in unwritten.reviewer, false);
  const top = parseWorkOrder("---\neffort: low\n---\n" + BODY).frontmatter;
  assert.deepEqual([top.writer.effort, top.writer.lines.effort], ["low", 2]);
  assert.deepEqual(refused("---\neffort: low\nwriter: { effort: high }\n---\n" + BODY), ["line 3: writer.effort and effort (line 2) say the same thing; keep writer.effort"]);
  assert.deepEqual(refused("---\nwriter: opus\n---\n" + BODY), ["line 2: writer must be a mapping of model, effort"]);
  assert.deepEqual(refused("---\nreviewer:\n  provider: codex\n---\n" + BODY), ["line 3: reviewer.provider is not a key here; the keys are model, effort"]);
  assert.deepEqual(refused("---\nwriter:\n  effort: max\n---\n" + BODY), ["line 3: writer.effort must be one of low, medium, high"]);
  assert.deepEqual(refused("---\nwriter:\n  model: 'a b'\n---\n" + BODY), ["line 3: writer.model must be one model name, or null for the CLI's default"]);
});

test("a budget over the policy's limit is refused with its line and the limit", () => {
  const read = parseWorkOrder("---\nbudget:\n  rounds: 5\n  tokens: 100\n---\n" + BODY);
  const limits = { rounds: 2, tokens: 4_000_000 };
  assert.deepEqual(budgetProblems(read.frontmatter.budget, limits, (key) => read.frontmatter.budget_lines[key]), ["line 3: budget.rounds is 5, over the policy limit 2"]);
});

test("blocks run from their marker to the next; an unknown or repeated key is refused with its line", () => {
  // clarifications went with the questions (2026-11-08): a work order is a form, filled in by the person.
  assert.equal(BLOCK_KEYS.length, 17);
  assert.equal(BLOCK_KEYS.includes("clarifications"), false);
  const read = parseWorkOrder(BODY);
  assert.deepEqual([...read.blocks.keys()], ["requested_work", "acceptance"]);
  assert.deepEqual(read.blocks.get("requested_work").content, [4]);
  assert.deepEqual(read.acceptance, [{ run: null, lines: [7] }]);
  assert.deepEqual(refused(BODY + "<!-- bridge:extensions -->\nmore\n"), ["line 8: unknown block key extensions; the keys are " + BLOCK_KEYS.join(", ")]);
  assert.deepEqual(refused(BODY + "<!-- bridge:acceptance -->\n- again\n"), ["line 8: block acceptance is already marked at line 6"]);
  assert.deepEqual(refused(BODY + "<!-- bridge:context --> and text\n"), ["line 8: a block marker is written <!-- bridge:<key> --> on a line of its own"]);
  // One sentence is a work order, with no title; only saying nothing is refused.
  assert.deepEqual(parseWorkOrder("I want a shiny button.").title, { line: null, text: "untitled" });
  assert.deepEqual(parseWorkOrder("<!-- bridge:requested_work -->\nBuild a farm.\n").title, { line: null, text: "untitled" });
  assert.deepEqual(refused("---\npriority: high\n---\n\n"), ["line 4: the work order says nothing; write what you want done"]);
});

test("headings, markers, blank lines and the title are structure; other lines outside every block are unused", () => {
  const read = parseWorkOrder("intro\n# Farm\nnote\n\n<!-- bridge:context -->\n## Background\nIt rains.\n### More\nOften.\n\n<!-- bridge:acceptance -->\n- Dry.\n");
  assert.deepEqual(read.unused, [1, 3]);
  assert.deepEqual(read.blocks.get("context").content, [7, 9]);
  assert.deepEqual(read.title, { line: 2, text: "Farm" });
  // The # and the spaces around the words are not part of the title.
  assert.deepEqual(parseWorkOrder("# 商品分類 管理  \t\n").title, { line: 1, text: "商品分類 管理" });
});

test("a run plan: each ### line opens a run; effort, budget and depends_on are YAML; acceptance takes the indented lines under it", () => {
  const read = parseWorkOrder([
    "# Farm",                                       // 1
    "<!-- bridge:run_plan -->",                     // 2
    "### RUN A",                                    // 3
    "Plant trees.",                                 // 4
    "- effort: high",                               // 5
    "- budget: { rounds: 1, call_timeout: 600000 }", // 6
    "- acceptance:",                                // 7
    "  - Trees show.",                              // 8
    "",                                             // 9
    "  - Trees are green.",                         // 10
    "Water them.",                                  // 11
    "### RUN B",                                    // 12
    "Add a cart.",                                  // 13
    "- depends_on: [RUN A]",                        // 14
    "<!-- bridge:acceptance -->",                   // 15
    "- All of it works.",                           // 16
  ].join("\n"));
  assert.deepEqual(read.runs.map((run) => [run.name, run.work, run.effort, run.budget, run.depends_on, run.depends_on_line, run.acceptance]), [
    ["RUN A", [4, 11], "high", { rounds: 1, call_timeout: 600_000 }, [], null, [8, 10]],
    ["RUN B", [13], null, null, ["RUN A"], 14, []],
  ]);
  assert.deepEqual(read.acceptance, [{ run: null, lines: [16] }, { run: "RUN A", lines: [8, 10] }]);
  // A single name is a YAML string too.
  assert.deepEqual(parseWorkOrder("# F\n<!-- bridge:run_plan -->\n### A\nx\n### B\ny\n- depends_on: A\n").runs[1].depends_on, ["A"]);
  // An empty block, as the template ships it, is no run plan.
  assert.equal(parseWorkOrder("# F\n<!-- bridge:run_plan -->\n## Run plan\n\n" + BODY.slice(BODY.indexOf("<!--"))).runs, null);
});

test("a run plan is refused with its lines: one run, a missing dependency, a loop, a bad key value, text before the first run", () => {
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n"), ["line 2: a run_plan needs at least two runs, each opened by a ### line; it has 1"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n### B\ny\n- depends_on: C\n"), ["line 7: run B depends on C, which is no run here"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n- depends_on: B\n### B\ny\n- depends_on: A\n"), ["line 5: dependency cycle A -> B -> A"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n- effort: max\n### B\ny\n"), ["line 5: run A effort must be one of low, medium, high"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n- budget: { turns: 2 }\n### B\ny\n"), ["line 5: run A budget.turns is not a budget key; the keys are tokens, tokens_per_call, call_timeout, test_timeout, run_timeout, rounds"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\nfirst\n### A\nx\n### B\ny\n"), ["line 3: run_plan text before the first ### run; put it in a run or another block"]);
  assert.deepEqual(refused("# F\n<!-- bridge:run_plan -->\n### A\nx\n### A\ny\n"), ["line 5: run A is already named at line 3"]);
});

// The cycle walk used to call itself inside the contract check; the cycles it finds, and their
// order, are the same now that it walks with a stack in the format.
test("dependency cycles are found in the same order as before the walk used a stack", () => {
  const problems = refused([
    "# F",
    "<!-- bridge:run_plan -->",
    "### RUN A", "a", "- depends_on: RUN B",
    "### RUN B", "b", "- depends_on: RUN C",
    "### RUN C", "c", "- depends_on: [RUN A, RUN D]",
    "### RUN D", "d", "- depends_on: RUN D",
    "### RUN E", "e", "- depends_on: RUN A",
  ].join("\n"));
  assert.deepEqual(problems, ["line 5: dependency cycle RUN A -> RUN B -> RUN C -> RUN A", "line 14: dependency cycle RUN D -> RUN D"]);
});
