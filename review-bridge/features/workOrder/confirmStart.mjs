import path from "node:path";
import readline from "node:readline/promises";

import { readJson } from "../../service/index.mjs";
import { assertUnderOne } from "../../utils/pathGuard.mjs";
import { createTranslator, resolveLocale } from "./i18n.mjs";
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

// The card speaks the project's language (bridge.json's locale, Owner 2026-11-06: a person stopped sees
// their own words); every line below comes from the language pack.
export async function cardTranslator(paths) {
  return await createTranslator(await resolveLocale(paths));
}

// Which work order the yes starts (spec 2026-10-24's three lines, in the card's language): y starts
// it as the card says, n does not start; --update <work_order_id> or --as-new prints another card.
export function decisionLine(t, workOrder) {
  if (workOrder.decision === "new") return t("card.decision.new", { title: workOrder.title });
  if (workOrder.decision === "same") return t("card.decision.same", { title: workOrder.title, version: workOrder.from_version });
  return t("card.decision.changed", { title: workOrder.title, from: workOrder.from_version ?? 0, to: workOrder.to_version, lines: workOrder.changed_lines });
}

// Where each value the card shows came from, in the person's words.
const source = (t, layer) => t("card.source." + layer);

// One role as the card shows it: who, which model and how hard, and where each came from. Either
// a person says yes to it or it does not run, so a role changed since the last card is on this one.
export function roleLine(t, role) {
  return t("card.role", {
    provider: role.provider, provider_source: source(t, role.provider_source),
    model: role.model ?? t("card.model.default"), model_source: source(t, role.model_source),
    effort: role.effort, effort_source: source(t, role.effort_source),
  });
}

// What the reviewer holds besides reading files. A server on the policy's list is let through as it
// is: nothing has shown that it cannot write, so the card says so.
export function reviewerMcpLine(t, plan) {
  return plan.reviewer.mcp.length ? t("card.mcp.allowed", { list: plan.reviewer.mcp.join(", ") }) : t("card.mcp.none");
}

// The contract the plan sealed: Bridge cut it from the work order, so no model call comes before the work.
export function contractLine(t, plan) {
  return t("card.contract", { sha: plan.contract_sha256, count: plan.contract_conditions });
}

// The six budget values in their fixed order (a card read back from the database has its keys
// reordered), each with where it came from: the work order, a flag, or the config.
export function budgetLine(t, plan) {
  return BUDGET_KEYS.map((key) => t("card.budget.item", { key, value: plan.budget[key], source: source(t, plan.budget_source[key]) })).join(t("card.budget.separator"));
}

const replacedLine = (t, { runId, unchanged }) => t(unchanged ? "card.replaced.unchanged" : "card.replaced.stops", { run: runId });

// The line an agent passes on: the card stops here, and the person's yes is relayed with --yes.
export const needsAuthorizationLine = (t, again) => t("card.needs_authorization", { command: again });

// start's one card (Owner 2026-11-08): what the yes authorizes, in the words a person checks it by. Every
// line comes from the sealed plan, the contract Bridge cut from the work order among them.
export async function startCard(paths, plan, t = null) {
  t ??= await cardTranslator(paths);
  const replaced = await runningVersions(paths, plan);
  const label = (key) => t("card.label." + key);
  const gate = plan.test?.kind === "command" ? t("card.tests.command", { command: plan.test.command }) : t("card.tests.none");
  const scope = plan.scope.source === "explicit"
    ? plan.scope.allowed_paths.join(", ")
    : t("card.scope.default", { count: plan.scope.forbidden_paths.length });
  return [
    label("work_order") + plan.task_file,
    ...(plan.work_order ? [t("card.indent") + decisionLine(t, plan.work_order)] : []),
    label("stops") + plan.breakpoint,
    label("scope") + scope,
    label("tests") + gate,
    label("priority") + t("card.priority", { priority: plan.priority, source: source(t, plan.priority_source) }),
    label("writer") + roleLine(t, plan.writer),
    label("reviewer") + roleLine(t, plan.reviewer),
    label("reviewer_mcp") + reviewerMcpLine(t, plan),
    label("budget") + budgetLine(t, plan),
    ...(plan.contract_sha256 ? [label("contract") + contractLine(t, plan)] : []),
    label("valid_until") + plan.authorization_expires_at,
    ...replaced.map((entry) => replacedLine(t, entry)),
    "",
    t("card.sealed_text"),
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
  const t = await cardTranslator(paths);
  const label = (key) => t("workstart.label." + key);
  const replaced = await runningVersions(paths, plan);
  process.stdout.write([
    label("work_package") + plan.work_package_id,
    ...(plan.work_order ? [label("work_order") + decisionLine(t, plan.work_order)] : []),
    label("owner") + plan.owner,
    label("breakpoint") + plan.breakpoint,
    label("allowed_paths") + plan.scope.allowed_paths.join(", "),
    label("priority") + t("card.priority", { priority: plan.priority, source: source(t, plan.priority_source) }),
    label("writer") + roleLine(t, plan.writer),
    label("reviewer") + roleLine(t, plan.reviewer),
    label("reviewer_mcp") + reviewerMcpLine(t, plan),
    label("budget") + budgetLine(t, plan),
    ...(plan.contract_sha256 ? [label("contract") + contractLine(t, plan)] : []),
    label("expires") + plan.authorization_expires_at,
    ...replaced.map((entry) => replacedLine(t, entry)),
    label("task"),
    plan.task,
    "",
  ].join("\n"));
  if (!ask) {
    process.stdout.write(needsAuthorizationLine(t, again) + "\n");
    return null;
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(t("workstart.ask"));
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Work package authorization cancelled by user.");
  } finally {
    terminal.close();
  }
  return plan.plan_sha256;
}
