import path from "node:path";
import readline from "node:readline/promises";

import { readJson } from "../../service/index.mjs";
import { assertUnderOne } from "../../utils/pathGuard.mjs";
import { BUDGET_KEYS } from "./workOrderFormat.mjs";
import { assertCurrentPlan, runningVersions } from "./workPackage.mjs";

export async function askYes(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

const write = (line) => process.stdout.write(line + "\n");

// The one model-free moment before the first model call of this command, after the yes: the reviewer's
// read-only check and the gate, once a process, and this machine's adapter only after them. Null when the
// check refused.
export function readiness({ options, adapter, loadAdapter, guard, reviewerCheck, plan, again, checkFailureLines }) {
  let ready = null;
  return async () => {
    if (ready) return ready;
    if (options.fakeCli) {
      write("Reviewer read-only check: not needed with the fake CLI (no model is called)");
    } else {
      const check = await reviewerCheck({
        reviewer: plan.reviewer.provider,
        mcp: { off: plan.reviewer.mcp_off, allow: plan.reviewer.mcp },
        onStart: (reviewer) => write("Checking that the reviewer (" + reviewer + ") cannot write files: one model call..."),
      });
      if (!check.ok) {
        for (const line of checkFailureLines(check, again)) write(line);
        return null;
      }
      write("Reviewer read-only check: passed" + (check.already ? " (earlier in this page session)" : ""));
    }
    await guard(plan.reviewer.provider, { off: plan.reviewer.mcp_off, allow: plan.reviewer.mcp });
    ready = { adapter: adapter || await loadAdapter() };
    return ready;
  };
}

// Which work order the yes starts (spec 2026-10-24's three lines, in the card's language): y starts
// it as the card says, n does not start; --update <work_order_id> or --as-new prints another card.
export function decisionLine(workOrder) {
  const title = "\"" + workOrder.title + "\"";
  if (workOrder.decision === "new") return "New work order " + title;
  if (workOrder.decision === "same") return "Updates " + title + ": still version " + workOrder.from_version + ", with new run settings";
  return "Updates " + title + ": version " + (workOrder.from_version ?? 0) + " → " + workOrder.to_version + ", " + workOrder.changed_lines + " line(s) changed";
}

// Where each value the card shows came from, in the person's words.
const SOURCE = Object.freeze({ cli: "flag", work_order: "work order", priority: "priority table", config: "config" });

// One role as the card shows it: who, which model and how hard, and where each came from. Either
// a person says yes to it or it does not run, so a role changed since the last card is on this one.
export function roleLine(role) {
  const model = role.model ?? "the CLI's default";
  return role.provider + " (" + SOURCE[role.provider_source] + "), model " + model + " (" + SOURCE[role.model_source] + "), effort " + role.effort + " (" + SOURCE[role.effort_source] + ")";
}

// What the reviewer holds besides reading files. A server on the policy's list is let through as it
// is: nothing has shown that it cannot write, so the card says so.
export function reviewerMcpLine(plan) {
  return plan.reviewer.mcp.length ? plan.reviewer.mcp.join(", ") + " (allowed by the policy, not checked to be read-only)" : "none";
}

// The contract the plan sealed: Bridge cut it from the work order, so no model call comes before the work.
export function contractLine(plan) {
  return "sha256 " + plan.contract_sha256 + ", " + plan.contract_conditions + " condition(s) cut from the acceptance list";
}

// The six budget values in their fixed order (a card read back from the database has its keys
// reordered), each with where it came from: the work order, a flag, or the config.
export function budgetLine(plan) {
  return BUDGET_KEYS.map((key) => key + " " + plan.budget[key] + " (" + SOURCE[plan.budget_source[key]] + ")").join(", ");
}

// start's one card (Owner 2026-11-08): what the yes authorizes, in the words a person checks it by. Every
// line comes from the sealed plan, the contract Bridge cut from the work order among them.
export async function startCard(paths, plan) {
  const replaced = await runningVersions(paths, plan);
  const gate = plan.test?.kind === "command" ? "runs " + plan.test.command + " after each writer call" : "not configured (no test rule matched; the work starts without tests)";
  const scope = plan.scope.source === "explicit"
    ? plan.scope.allowed_paths.join(", ")
    : "the whole project except protected files (" + plan.scope.forbidden_paths.length + " patterns)";
  return [
    "Work order:   " + plan.task_file,
    ...(plan.work_order ? ["              " + decisionLine(plan.work_order)] : []),
    "Stops:        " + plan.breakpoint,
    "Scope:        " + scope,
    "Tests:        " + gate,
    "Priority:     " + plan.priority + " (" + SOURCE[plan.priority_source] + ")",
    "Writer:       " + roleLine(plan.writer),
    "Reviewer:     " + roleLine(plan.reviewer),
    "Reviewer MCP: " + reviewerMcpLine(plan),
    "Budget:       " + budgetLine(plan),
    ...(plan.contract_sha256 ? ["Contract:     " + contractLine(plan)] : []),
    "Valid until:  " + plan.authorization_expires_at,
    ...replaced.map(({ runId, unchanged }) => (unchanged
      ? "This work order is already running unchanged as run " + runId + "; this start will be refused."
      : "Starting stops the version still running from this work order: run " + runId)),
    "",
    "The work order, as sealed:",
    ...plan.task.trimEnd().split(/\r?\n/).map((line) => "  │ " + line),
    "",
  ].join("\n");
}

// The person reads the sealed plan and says y; the answer approves that plan's SHA. At a terminal
// it is asked here; without one the card is printed with the command an agent runs once the person
// said yes, and null is returned: nothing starts.
export async function confirmWorkStart(paths, planPath, { assumeYes = false, ask = true, again = null } = {}) {
  const resolvedPlan = assertUnderOne(path.resolve(planPath), [paths.logRoot, paths.privateRoot], "Work plan");
  const plan = await readJson(resolvedPlan);
  assertCurrentPlan(plan);
  if (assumeYes) return plan.plan_sha256;
  const replaced = await runningVersions(paths, plan);
  process.stdout.write([
    "Work package: " + plan.work_package_id,
    ...(plan.work_order ? ["Work order: " + decisionLine(plan.work_order)] : []),
    "Owner: " + plan.owner,
    "Breakpoint: " + plan.breakpoint,
    "Allowed paths: " + plan.scope.allowed_paths.join(", "),
    "Priority: " + plan.priority + " (" + SOURCE[plan.priority_source] + ")",
    "Writer: " + roleLine(plan.writer),
    "Reviewer: " + roleLine(plan.reviewer),
    "Reviewer MCP: " + reviewerMcpLine(plan),
    "Budget: " + budgetLine(plan),
    ...(plan.contract_sha256 ? ["Contract: " + contractLine(plan)] : []),
    "Authorization expires at: " + plan.authorization_expires_at,
    ...replaced.map(({ runId, unchanged }) => (unchanged
      ? "This work order is already running unchanged as run " + runId + "; this start will be refused."
      : "Starting stops the version still running from this work order: run " + runId)),
    "Task:",
    plan.task,
    "",
  ].join("\n"));
  if (!ask) {
    process.stdout.write("Needs authorization. If the person says yes, run again: " + again + " --yes\n");
    return null;
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Authorize this work package? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Work package authorization cancelled by user.");
  } finally {
    terminal.close();
  }
  return plan.plan_sha256;
}
