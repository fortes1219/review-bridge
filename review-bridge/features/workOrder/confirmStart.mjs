import path from "node:path";
import readline from "node:readline/promises";

import { readJson } from "../../service/index.mjs";
import { assertUnder } from "../../utils/pathGuard.mjs";
import { runningVersions } from "./workPackage.mjs";

// The model calls before the work, as the plan seals them; the human approves them with the plan.
export function contractStepsLine(steps) {
  return "Before the work: up to " + steps.max_attempts + " work-order translation(s) by the writer (" + steps.translate.provider + ")"
    + " and " + steps.max_attempts + " check(s) by the reviewer (" + steps.check.provider + "), " + steps.minutes_per_call + " minute(s) per call";
}

// Which work order the yes starts (spec 2026-10-24's three lines, in the card's language): y starts
// it as the card says, n does not start; --update <work_order_id> or --as-new prints another card.
export function decisionLine(workOrder) {
  const title = "\"" + workOrder.title + "\"";
  if (workOrder.decision === "new") return "New work order " + title;
  if (workOrder.decision === "same") return "Updates " + title + ": still version " + workOrder.from_version + ", with new run settings";
  return "Updates " + title + ": version " + (workOrder.from_version ?? 0) + " → " + workOrder.to_version + ", " + workOrder.changed_lines + " line(s) changed";
}

// start's card: what the answer authorizes, in the words a person checks it by. Every line comes
// from the sealed plan. The numbered acceptance conditions are written only after the answer (the
// translation is part of the authorized work), so the card shows the work order as it is sealed.
export async function startCard(paths, plan) {
  const replaced = await runningVersions(paths, plan);
  const gate = plan.gate_a?.kind === "command" ? "runs " + plan.gate_a.command + " after each writer call" : "not needed for docs-only work";
  const scope = plan.scope.source === "explicit"
    ? plan.scope.allowed_paths.join(", ")
    : "the whole project except protected files (" + plan.scope.forbidden_paths.length + " patterns)";
  return [
    "Work order:   " + plan.task_file,
    ...(plan.work_order ? ["              " + decisionLine(plan.work_order)] : []),
    "Stops:        " + plan.breakpoint,
    "Changes:      " + plan.scope.change_types.join(", "),
    "Scope:        " + scope,
    "Gate A:       " + gate,
    "Budget:       " + plan.budget.max_claude_calls + " writer call(s), up to " + plan.budget.max_claude_minutes_per_call + " minute(s) each",
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
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 4 || plan.operation !== "start_work_package") {
    throw new Error("Unsupported work plan.");
  }
  if (assumeYes) return plan.plan_sha256;
  const replaced = await runningVersions(paths, plan);
  process.stdout.write([
    "Work package: " + plan.work_package_id,
    ...(plan.work_order ? ["Work order: " + decisionLine(plan.work_order)] : []),
    "Owner: " + plan.owner,
    "Breakpoint: " + plan.breakpoint,
    "Allowed change types: " + plan.scope.change_types.join(", "),
    "Allowed paths: " + plan.scope.allowed_paths.join(", "),
    "Claude budget: " + plan.budget.max_claude_calls + " call(s), "
      + plan.budget.max_claude_minutes_per_call + " minute(s) per call",
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
