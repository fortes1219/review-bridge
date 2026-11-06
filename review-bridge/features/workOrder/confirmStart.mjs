import path from "node:path";
import readline from "node:readline/promises";

import { readJson } from "../../service/index.mjs";
import { assertUnderOne } from "../../utils/pathGuard.mjs";
import { BUDGET_KEYS } from "./workOrderFormat.mjs";
import { assertCurrentPlan, runningVersions } from "./workPackage.mjs";

// The model calls before the work, as the plan seals them; the human approves them with the plan.
export function contractStepsLine(steps) {
  return "Before the work: up to " + steps.max_attempts + " work-order translation(s) by the writer (" + steps.translate.provider + ")"
    + " and " + steps.max_attempts + " check(s) by the reviewer (" + steps.check.provider + "), " + steps.call_timeout / 60_000 + " minute(s) per call";
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

// The six budget values in their fixed order (a card read back from the database has its keys
// reordered), each with where it came from: the work order, a flag, or the config.
export function budgetLine(plan) {
  return BUDGET_KEYS.map((key) => key + " " + plan.budget[key] + " (" + SOURCE[plan.budget_source[key]] + ")").join(", ");
}

// start's card: what the answer authorizes, in the words a person checks it by. Every line comes
// from the sealed plan. The numbered acceptance conditions are written only after the answer (the
// translation is part of the authorized work), so the card shows the work order as it is sealed.
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
    ...(plan.contract_steps ? ["Contract:     " + contractStepsLine(plan.contract_steps).replace(/^Before the work: /, "")] : []),
    "Valid until:  " + plan.authorization_expires_at,
    ...replaced.map(({ runId, unchanged }) => (unchanged
      ? "This work order is already running unchanged as run " + runId + "; this start will be refused."
      : "Starting stops the version still running from this work order: run " + runId)),
    "",
    "The work order, as it will be sealed:",
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
    ...(plan.contract_steps ? [contractStepsLine(plan.contract_steps)] : []),
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
