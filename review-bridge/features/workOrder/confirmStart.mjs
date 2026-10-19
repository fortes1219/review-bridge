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

// The human reads the sealed plan at the terminal and answers y; the answer approves that plan's SHA.
export async function confirmWorkStart(paths, planPath, assumeYes) {
  const resolvedPlan = assertUnder(path.resolve(planPath), paths.privateRoot, "Work plan");
  const plan = await readJson(resolvedPlan);
  if (plan.schema_version !== 4 || plan.operation !== "start_work_package") {
    throw new Error("Unsupported work plan.");
  }
  if (assumeYes) return plan.plan_sha256;
  const replaced = await runningVersions(paths, plan);
  process.stdout.write([
    "Work package: " + plan.work_package_id,
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
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Authorize this work package? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Work package authorization cancelled by user.");
  } finally {
    terminal.close();
  }
  return plan.plan_sha256;
}
