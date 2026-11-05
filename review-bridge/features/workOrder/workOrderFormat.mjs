// The work order's format (Owner 2026-10-27): optional frontmatter that is data, and a body in
// blocks marked <!-- bridge:<key> -->, each key a contract field. Code splits it; no model decides
// which text goes where. The frontmatter is fenced the way Astro does it (first line `---`, up to the
// next line that is only `---`) and read with the `yaml` package Astro uses; the run keys inside a
// run_plan block are read by the same parser. Every refusal names the line it is about.
import { createRequire } from "node:module";

import { PRIORITIES } from "../../policy/policyRules.mjs";

// The YAML parser is loaded on the first work order read, like every other dependency of the
// runtime, so a command that reads none does not need it.
const require = createRequire(import.meta.url);
let yaml = null;
const yamlParser = () => (yaml ??= require("yaml"));
const isMap = (node) => yamlParser().isMap(node);
const isScalar = (node) => yamlParser().isScalar(node);
const isSeq = (node) => yamlParser().isSeq(node);

export const FRONTMATTER_KEYS = Object.freeze(["priority", "effort", "budget", "source_id"]);
// Each budget key is the policy limit of the same name; a work order may only go below it.
export const BUDGET_KEYS = Object.freeze(["tokens", "tokens_per_call", "call_timeout", "test_timeout", "run_timeout", "rounds"]);
export const EFFORTS = Object.freeze(["low", "medium", "high"]);
export const BLOCK_KEYS = Object.freeze([
  "context", "outcome", "requested_work", "run_plan",
  "scope_notes.include", "scope_notes.exclude", "scope_notes.must_keep", "scope_notes.expected_locations",
  "acceptance", "verification_hints",
  "reproduction.environment", "reproduction.steps", "reproduction.actual", "reproduction.expected", "reproduction.frequency",
  "references", "open_questions",
]);
const RUN_KEYS = Object.freeze(["effort", "budget", "depends_on", "acceptance"]);
// The shortest call timeout a work order or a flag may ask for, as before.
export const MIN_CALL_TIMEOUT = 60_000;

const FENCE = "---";
const MARKER = /^<!--\s*bridge:(\S*?)\s*-->$/;
const TITLE = /^# \S/;
const HEADING = /^#{2,3}\s/;
const RUN_HEADING = /^###\s+(.*)$/;
const RUN_KEY = /^- ([a-z_]+):(.*)$/;
const NO_QUESTIONS = /^(?:無|none)$/i;

export class WorkOrderFormatError extends Error {
  constructor(problems) {
    super("The work order does not follow the work order format:\n" + problems.map((problem) => "  " + problem).join("\n"));
    this.name = "WorkOrderFormatError";
    this.problems = problems;
  }
}

export function workOrderLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const isBlank = (line) => !line.trim();

// One YAML value, with the file line each of its keys starts on. `firstLine` is the file line of the
// YAML text's first line; `column` the characters before it on that line.
function readYaml(text, firstLine, problems) {
  const { LineCounter, parseDocument } = yamlParser();
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  for (const error of document.errors) {
    const line = firstLine + (lineCounter.linePos(error.pos[0]).line - 1);
    problems.push("line " + line + ": " + error.message.split("\n")[0]);
  }
  const lineOf = (node) => firstLine + (lineCounter.linePos(node?.range?.[0] ?? 0).line - 1);
  return { document, lineOf, ok: document.errors.length === 0 };
}

const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

// A budget mapping as the frontmatter and a run write it: known keys, positive integers.
function readBudget(node, lineOf, where, problems) {
  if (!isMap(node)) {
    problems.push("line " + lineOf(node) + ": " + where + " must be a mapping of " + BUDGET_KEYS.join(", "));
    return null;
  }
  const budget = {};
  const lines = {};
  for (const pair of node.items) {
    const key = String(pair.key?.value ?? "");
    const line = lineOf(pair.key);
    if (!BUDGET_KEYS.includes(key)) { problems.push("line " + line + ": " + where + "." + key + " is not a budget key; the keys are " + BUDGET_KEYS.join(", ")); continue; }
    const value = isScalar(pair.value) ? pair.value.value : null;
    if (!isPositiveInteger(value)) { problems.push("line " + line + ": " + where + "." + key + " must be a positive whole number"); continue; }
    if (key === "call_timeout" && value < MIN_CALL_TIMEOUT) { problems.push("line " + line + ": " + where + ".call_timeout must be at least " + MIN_CALL_TIMEOUT + " ms"); continue; }
    budget[key] = value;
    lines[key] = line;
  }
  return { budget, lines };
}

function readEffort(node, lineOf, where, problems) {
  const value = isScalar(node) ? node.value : null;
  if (!EFFORTS.includes(value)) {
    problems.push("line " + lineOf(node) + ": " + where + " must be one of " + EFFORTS.join(", "));
    return null;
  }
  return value;
}

function readFrontmatter(lines, problems) {
  const empty = { priority: null, effort: null, budget: null, source_id: null, lines: {}, budget_lines: {}, end: 0 };
  if (lines[0] !== FENCE) return empty;
  const close = lines.indexOf(FENCE, 1);
  if (close === -1) {
    problems.push("line 1: the frontmatter opened here is not closed by a line that is only ---");
    return empty;
  }
  const read = { ...empty, end: close + 1 };
  const { document, lineOf, ok } = readYaml(lines.slice(1, close).join("\n"), 2, problems);
  if (!ok) return read;
  const root = document.contents;
  if (root === null || (isScalar(root) && root.value === null)) return read;
  if (!isMap(root)) {
    problems.push("line 2: the frontmatter must be keys and values (" + FRONTMATTER_KEYS.join(", ") + ")");
    return read;
  }
  for (const pair of root.items) {
    const key = String(pair.key?.value ?? "");
    const line = lineOf(pair.key);
    if (!FRONTMATTER_KEYS.includes(key)) { problems.push("line " + line + ": unknown key " + key + "; the frontmatter takes " + FRONTMATTER_KEYS.join(", ")); continue; }
    read.lines[key] = line;
    if (key === "priority") {
      const value = isScalar(pair.value) ? pair.value.value : null;
      if (PRIORITIES.includes(value)) read.priority = value;
      else problems.push("line " + line + ": priority must be one of " + PRIORITIES.join(", "));
    } else if (key === "effort") {
      read.effort = readEffort(pair.value, () => line, "effort", problems);
    } else if (key === "budget") {
      const budget = readBudget(pair.value, (node) => (node ? lineOf(node) : line), "budget", problems);
      if (budget) { read.budget = budget.budget; read.budget_lines = budget.lines; }
    } else {
      const value = isScalar(pair.value) ? pair.value.value : null;
      if ((typeof value === "string" && value.trim()) || Number.isFinite(value)) read.source_id = String(value);
      else problems.push("line " + line + ": source_id must be one value, such as SHOP-412");
    }
  }
  return read;
}

// Line numbers of a block's content as source_refs: one range per stretch of content that no
// heading or marker interrupts; blank lines inside a stretch stay in it, so the text keeps its breaks.
export function rangesOf(numbers, lines) {
  const ranges = [];
  for (const number of numbers) {
    const last = ranges[ranges.length - 1];
    const between = last ? lines.slice(last.end, number - 1) : [];
    if (last && between.every(isBlank)) last.end = number;
    else ranges.push({ start: number, end: number });
  }
  return ranges;
}

// A run_plan block: each ### line opens a run named by its text. Inside a run the lines
// `- effort:`, `- budget:`, `- depends_on:` carry YAML values, and `- acceptance:` takes the
// indented lines after it as the run's own conditions; every other content line is the run's work.
function readRuns(lines, numbers, marker, problems) {
  const runs = [];
  let run = null;
  let inAcceptance = false;
  for (const number of numbers) {
    const line = lines[number - 1];
    const heading = RUN_HEADING.exec(line);
    if (heading) {
      const name = heading[1].trim();
      if (!name) problems.push("line " + number + ": a run needs a name after ###");
      else if (runs.some((other) => other.name === name)) problems.push("line " + number + ": run " + name + " is already named at line " + runs.find((other) => other.name === name).line);
      run = { name, line: number, effort: null, budget: null, depends_on: [], depends_on_line: null, work: [], acceptance: [] };
      runs.push(run);
      inAcceptance = false;
      continue;
    }
    if (isBlank(line) || HEADING.test(line)) continue;
    if (!run) { problems.push("line " + number + ": run_plan text before the first ### run; put it in a run or another block"); continue; }
    if (inAcceptance && /^\s+\S/.test(line)) { run.acceptance.push(number); continue; }
    inAcceptance = false;
    const key = RUN_KEY.exec(line);
    if (!key || !RUN_KEYS.includes(key[1])) { run.work.push(number); continue; }
    const where = "run " + run.name + " " + key[1];
    if (key[1] === "acceptance") {
      if (key[2].trim()) problems.push("line " + number + ": put the run's conditions on indented lines under - acceptance:");
      inAcceptance = true;
      continue;
    }
    const { document, ok } = readYaml(key[2], number, problems);
    if (!ok) continue;
    const value = document.contents;
    if (key[1] === "effort") run.effort = readEffort(value, () => number, where, problems);
    else if (key[1] === "budget") run.budget = readBudget(value, () => number, where, problems)?.budget ?? null;
    else {
      const names = isSeq(value) ? value.items.map((item) => (isScalar(item) ? item.value : null)) : [isScalar(value) ? value.value : null];
      if (names.some((name) => typeof name !== "string" || !name.trim())) problems.push("line " + number + ": depends_on is one run name or a list such as [RUN A, RUN B]");
      else { run.depends_on = names.map((name) => name.trim()); run.depends_on_line = number; }
    }
  }
  if (runs.length < 2) problems.push("line " + marker + ": a run_plan needs at least two runs, each opened by a ### line; it has " + runs.length);
  const names = new Set(runs.map((each) => each.name));
  for (const each of runs) {
    if (!each.work.length) problems.push("line " + each.line + ": run " + each.name + " has no work text");
    for (const dependency of each.depends_on) if (!names.has(dependency)) problems.push("line " + each.depends_on_line + ": run " + each.name + " depends on " + dependency + ", which is no run here");
  }
  problems.push(...cycleProblems(runs));
  return runs;
}

// Depth first with a stack: trail holds the runs still open and next the dependency each goes to
// next. A run is done once all its dependencies are.
export function cycleProblems(runs) {
  const byName = new Map(runs.map((run) => [run.name, run]));
  const done = new Set();
  const cycles = [];
  for (const run of runs) {
    const trail = [];
    const next = [];
    const enter = (name) => {
      if (trail.includes(name)) cycles.push({ line: byName.get(trail[trail.indexOf(name)]).depends_on_line, text: trail.slice(trail.indexOf(name)).concat(name).join(" -> ") });
      else if (!done.has(name) && byName.has(name)) { trail.push(name); next.push(0); }
    };
    enter(run.name);
    while (trail.length) {
      const top = trail.length - 1;
      const dependsOn = byName.get(trail[top]).depends_on;
      if (next[top] < dependsOn.length) {
        next[top] += 1;
        enter(dependsOn[next[top] - 1]);
      } else {
        done.add(trail.pop());
        next.pop();
      }
    }
  }
  const seen = new Set();
  return cycles.filter((cycle) => !seen.has(cycle.text) && seen.add(cycle.text)).map((cycle) => "line " + cycle.line + ": dependency cycle " + cycle.text);
}

// The whole work order, split. Throws WorkOrderFormatError listing every problem found.
export function parseWorkOrder(text) {
  const lines = workOrderLines(text);
  const problems = [];
  const frontmatter = readFrontmatter(lines, problems);
  const blocks = new Map();
  const unused = [];
  let title = null;
  let current = null;
  for (let index = frontmatter.end; index < lines.length; index += 1) {
    const number = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { if (current) current.all.push(number); continue; }
    const marker = MARKER.exec(trimmed);
    if (marker || /^<!--\s*bridge:/.test(trimmed)) {
      const key = marker?.[1] ?? "";
      if (!marker) problems.push("line " + number + ": a block marker is written <!-- bridge:<key> --> on a line of its own");
      else if (!BLOCK_KEYS.includes(key)) problems.push("line " + number + ": unknown block key " + (key || "(empty)") + "; the keys are " + BLOCK_KEYS.join(", "));
      else if (blocks.has(key)) problems.push("line " + number + ": block " + key + " is already marked at line " + blocks.get(key).marker);
      current = marker && BLOCK_KEYS.includes(key) && !blocks.has(key) ? { key, marker: number, all: [], content: [] } : null;
      if (current) blocks.set(key, current);
      continue;
    }
    // The title is the heading's words: the leading # and the spaces around them are Markdown, not title.
    if (!title && TITLE.test(line)) { title = { line: number, text: line.slice(1).trim() }; continue; }
    if (current) current.all.push(number);
    if (HEADING.test(line)) continue;
    if (current) current.content.push(number);
    else unused.push(number);
  }
  if (!title) problems.push("line " + (frontmatter.end + 1) + ": the work order has no title; its first line starting with \"# \" is the title");
  // An empty run_plan block, as the template ships it, is no run plan.
  const runPlan = blocks.get("run_plan");
  const planned = runPlan && (runPlan.content.length || runPlan.all.some((number) => RUN_HEADING.test(lines[number - 1])));
  const runs = planned ? readRuns(lines, runPlan.all, runPlan.marker, problems) : null;
  if (problems.length) throw new WorkOrderFormatError(problems);
  const questions = blocks.get("open_questions")?.content || [];
  const noQuestions = questions.every((number) => NO_QUESTIONS.test(lines[number - 1].trim()));
  return {
    lines,
    frontmatter,
    title,
    blocks,
    runs,
    // Where conditions are written: the work order's acceptance block, then each run's own list.
    acceptance: [
      ...(blocks.get("acceptance")?.content.length ? [{ run: null, lines: blocks.get("acceptance").content }] : []),
      ...(runs || []).filter((run) => run.acceptance.length).map((run) => ({ run: run.name, lines: run.acceptance })),
    ],
    open_questions: noQuestions ? [] : questions.map((number) => ({ question: lines[number - 1].trim(), source_refs: [{ start: number, end: number }] })),
    unused,
  };
}

// Budget values written in the work order (the frontmatter, or one run) that the policy does not
// allow: each named with its line and the limit.
export function budgetProblems(budget, limits, lineOf, where = "budget") {
  const problems = [];
  for (const [key, value] of Object.entries(budget || {})) {
    if (!Number.isInteger(limits?.[key])) problems.push("line " + lineOf(key) + ": " + where + "." + key + " has no policy limit to stay under");
    else if (value > limits[key]) problems.push("line " + lineOf(key) + ": " + where + "." + key + " is " + value + ", over the policy limit " + limits[key]);
  }
  return problems;
}
