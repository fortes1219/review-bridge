// A directory of work orders is one line (RC3-PIPE-01, Owner 2026-11-06). The file names say the order
// and the records say what is left, as migration tools scan a folder and run what has not run (Flyway's
// V2__, Knex). Every work order of the line must say what it must say before the card (a form: Owner
// 2026-11-08), and each plan carries the contract code cut from it; one card names them all, and one yes
// runs them, one after another, asking nothing. One work order failing its work does not stop the next, and
// a table of every one closes it, as Playwright runs its files; a second Ctrl+C ends it at once, as
// Playwright's SigIntWatcher does. The line is the process in this terminal: nothing keeps running or
// waiting behind it, and nothing of it is stored except each plan's place on the card (`plan.line`), so a
// later start works out what is pending from the records again.
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { acquireLock, activeLineSteps, inspectProvider, isPidAlive, readJson, readRun, SIGN_IN_COMMANDS, writeJson } from "../../service/index.mjs";
import { localTimestamp } from "../../utils/dates.mjs";
import { digest } from "../../utils/digest.mjs";
import { workOrderDirectory } from "../../utils/paths.mjs";
import { nfc } from "../../utils/workOrderName.mjs";
import { askYes, needsAuthorizationLine, readiness } from "./confirmStart.mjs";
import { deliverOutcome } from "./delivery.mjs";
import { createTranslator, resolveLocale } from "./i18n.mjs";
import {
  anyCardUsed, canonicalTaskFile, latestCardsOfFiles, latestRunsOfFiles, markCardsShown, recordDirectoryYes, withdrawCards,
} from "./workOrderRecords.mjs";
import { refuseForm } from "./workOrderForm.mjs";
import { formProblems, parseWorkOrder, WorkOrderFormError } from "./workOrderFormat.mjs";
import { authorizeCard, optionAgainstCard, planFilePath, PLAN_SCHEMA_VERSION, workLockReleased, workOrderChecker } from "./workPackage.mjs";
import { uncommittedNow } from "./workspaceEvidence.mjs";
import { stopRun } from "./writerLoop.mjs";

const write = (line) => process.stdout.write(line + "\n");

// Provider words a stop came with that the next work order would die of too; a person's stop; or null.
export function stopOfRun(run) {
  const failure = run?.last_state?.failure;
  if (failure?.reason === "provider_signed_out") return { kind: "signed_out", provider: failure.provider };
  if (failure?.reason === "provider_usage_limit") return { kind: "usage_limit", provider: failure.provider, resetHint: failure.reset_hint };
  return run?.closed_reason === "stopped" ? { kind: "stopped" } : null;
}

// Playwright's SigIntWatcher: the first signal is a request to stop; the handler goes after a second, so
// the next Ctrl+C ends the process at once, and a package runner's duplicate of the first does not.
export function interruptWatcher(onInterrupt) {
  let had = false;
  let timer = null;
  const handler = () => {
    if (had) return;
    had = true;
    timer = setTimeout(disarm, 1_000);
    onInterrupt();
  };
  function disarm() {
    clearTimeout(timer);
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return { hadSignal: () => had, disarm };
}

export function stoppedLine(stop, position, notRun) {
  const rest = notRun.length ? "; " + notRun.join(", ") + " did not run" : "";
  const again = "run start on this directory again: only what is pending runs.";
  if (stop.kind === "signed_out") return "Stopped at step " + position + ": " + stop.provider + " needs signing in again (" + SIGN_IN_COMMANDS[stop.provider] + ")" + rest + ". After signing in, " + again;
  if (stop.kind === "usage_limit") return "Stopped at step " + position + ": " + stop.provider + " is out of quota" + (stop.resetHint ? " until " + stop.resetHint : "") + rest + ". When it is back, " + again;
  return "Stopped at step " + position + rest + ". To carry on, " + again;
}

// The leading whole number of a file name is its step: 01-x, 01_x and 1-x are one step. v1-x and T001-x
// have none. Kept as digits: a date or a long number is still one exact step.
const STEP = /^(\d+)[-_]/;

export function stepOf(name) {
  const match = STEP.exec(name);
  return match ? String(BigInt(match[1])) : null;
}

const byCodeUnit = (left, right) => {
  const [one, other] = [nfc(left), nfc(right)];
  return one < other ? -1 : one > other ? 1 : 0;
};

// Numbered first, by step; within a step by the name after the number, so 2-x comes before 02-y as x
// comes before y; the numberless after them, by name. Code units of the NFC name, so neither a locale nor
// the way a disk spells a name changes the order.
export function orderWorkOrders(names) {
  const compare = (left, right) => {
    if (left.step === null || right.step === null) {
      if (left.step !== right.step) return left.step === null ? 1 : -1;
      return byCodeUnit(left.name, right.name);
    }
    const apart = BigInt(left.step) - BigInt(right.step);
    if (apart !== 0n) return apart < 0n ? -1 : 1;
    return byCodeUnit(left.name.replace(STEP, ""), right.name.replace(STEP, "")) || byCodeUnit(left.name, right.name);
  };
  return names.map((name) => ({ name, step: stepOf(name) })).sort(compare);
}

const real = (target) => { try { return realpathSync.native(target); } catch { return path.resolve(target); } };

// The line a path names, or null when it is no directory. Only work-packages/<directory>/ is a line.
export async function directoryOfTarget(paths, target) {
  const absolute = path.resolve(target);
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const root = path.join(paths.privateRoot, "work-packages");
  const parts = path.relative(real(root), real(absolute)).split(path.sep);
  const example = "review-bridge start .review-bridge/work-packages/<directory>/";
  if (parts.length === 1 && parts[0] === "") throw new Error("work-packages/ itself is not a line: give a subdirectory or a file. Run: " + example);
  if (parts[0] === ".." || path.isAbsolute(parts.join(path.sep))) throw new Error(target + " is not under .review-bridge/work-packages/: give a subdirectory of it or a file. Run: " + example);
  if (parts.length > 1) throw new Error(target + " is more than one level under work-packages/; a line is one directory directly under it, and its work orders are directly in that. Run: review-bridge start .review-bridge/work-packages/" + parts[0] + "/");
  return { name: nfc(parts[0]), absolute, shown: canonicalTaskFile(paths.repoRoot, absolute) + "/" };
}

// One line at a time per directory, held by the process running it. A process that died leaves the file
// with its pid, and acquireLock takes that over.
const lineLockFile = (paths, name) => path.join(paths.runLocksDir, "line-" + createHash("sha256").update(name).digest("hex").slice(0, 16) + ".lock");

async function lineHeld(paths, name) {
  try {
    return isPidAlive(Number((await readJson(lineLockFile(paths, name))).pid));
  } catch (error) {
    // Being written or removed this moment: held, as far as anyone can tell.
    return error.code !== "ENOENT";
  }
}

// The refusal for a directory whose line is running, or null: its run and step when one is running
// this moment (between two steps there is none).
export async function lineRunningLine(paths, { db, projectId }, name) {
  if (!(await lineHeld(paths, name))) return null;
  const step = (await activeLineSteps(db, projectId)).find((row) => row.line.directory === name);
  const where = step ? " (run " + step.run_id + ", step " + step.line.position + " of " + step.line.total + ")" : "";
  return name + "/ is running" + where + ". Run: review-bridge status to see its progress";
}

// A start of one file of a directory whose line is running would stop that line's step or race it.
export async function fileLineRunning(paths, openRecords, taskFile) {
  const name = workOrderDirectory(canonicalTaskFile(paths.repoRoot, taskFile));
  return name && await lineHeld(paths, name) ? await lineRunningLine(paths, await openRecords(paths), name) : null;
}

// The directory as it is now: every Markdown file directly in it, in order, each with whether it can run.
// A run still "in progress" whose process is gone is closed the way stop closes one, so its work order is
// pending again; one whose process is alive is named in `busy`.
async function surveyDirectory({ paths, records, directory, check }) {
  const entries = await fsp.readdir(directory.absolute, { withFileTypes: true });
  const rows = [];
  for (const { name, step } of orderWorkOrders(entries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name))) {
    const absolute = path.join(directory.absolute, name);
    const text = await fsp.readFile(absolute, "utf8").catch(() => null);
    const taskFile = canonicalTaskFile(paths.repoRoot, absolute);
    // Where a disk keeps both spellings of one name they are two files and one work order by name.
    const twin = rows.find((row) => row.taskFile === taskFile);
    rows.push({ name, step, absolute, taskFile, text, problem: twin ? "its name is the same as " + twin.name + " in another Unicode form" : text === null ? "it cannot be read" : check(name, text) });
  }
  const latest = await latestRunsOfFiles(records.db, { projectId: records.projectId, files: rows.map((row) => row.taskFile) });
  const busy = [];
  for (const row of rows) {
    const found = latest.get(row.taskFile);
    row.latestRun = found?.run_id ?? null;
    if (found?.status === "in_progress") {
      if (!(await workLockReleased(paths, found.run_id, { timeoutMs: 0 }))) {
        busy.push({ name: row.name, runId: found.run_id });
        continue;
      }
      const stopped = await stopRun(paths, found.run_id);
      if (stopped.exitCode === 2) throw new Error("Run " + found.run_id + " of " + row.name + " outlived the process that ran it and could not be stopped: " + stopped.line + ". Run: review-bridge stop " + found.run_id);
      await deliverOutcome({ paths, runId: found.run_id, notify: false }).catch(() => {});
      row.interrupted = true;
      continue;
    }
    row.interrupted = found?.conclusion === "cancelled";
    if (found?.conclusion === "success") row.deliveredAt = found.closed_at;
  }
  return { rows, busy };
}

const rowKind = (row) => (row.problem ? "not_work_order" : row.deliveredAt ? "delivered" : row.plan ? "to_run" : "appeared");

// The card (卡的樣子 in RC3-PIPE-01): a list, and no work order's text.
function cardLines({ t, directory, rows, place, uncommitted }) {
  const count = (kind) => rows.filter((row) => rowKind(row) === kind).length;
  const width = Math.max(0, ...rows.map((row) => row.name.length)) + 2;
  const toRun = rows.filter((row) => rowKind(row) === "to_run");
  const skip = t("line.card.skip");
  const beside = (row) => {
    if (rowKind(row) === "not_work_order") return t("line.card.not_work_order", { problem: row.problem }) + skip;
    if (rowKind(row) === "delivered") return t("line.card.delivered", { at: localTimestamp(row.deliveredAt).slice(0, 16) }) + skip;
    if (rowKind(row) === "appeared") return t("line.card.appeared") + skip;
    const before = toRun[toRun.indexOf(row) - 1];
    const notes = [
      ...(row.step !== null && before?.step === row.step ? [t("line.card.same_step", { name: before.name })] : []),
      ...(row.interrupted ? [t("line.card.interrupted")] : []),
      ...(row.plan.work_order?.renamed_from ? [t("line.card.renamed", { from: row.plan.work_order.renamed_from })] : []),
    ];
    return t("line.card.contract", { sha: row.plan.contract_sha256.slice(0, 4), count: row.plan.contract_conditions }) + notes.map((note) => t("line.card.note", { note })).join("");
  };
  const appeared = count("appeared");
  return [
    t("line.card.header", {
      directory: directory.shown, files: rows.length, delivered: count("delivered"), not_work_order: count("not_work_order"),
      appeared: appeared ? t("line.card.header.appeared", { count: appeared }) : "", to_run: toRun.length,
    }),
    "",
    ...rows.map((row) => "  " + row.name.padEnd(width) + beside(row)),
    "",
    ...(toRun.length ? [
      ...place.cardLines.map((key) => t(key)),
      ...(uncommitted?.length ? [t("line.card.uncommitted", { count: uncommitted.length })] : []),
    ] : [t("line.card.nothing")]),
  ];
}

// Where the line will run; the one place that says it, as language-pack keys. RC3-WT-01 answers with a
// worktree here when the working tree is taken, after the same-directory refusal and before the card.
export function whereLineRuns() {
  return { mode: "in_place", cardLines: ["line.card.in_place"] };
}

// E8, E10 for a card of many: --yes takes the card as printed, found in the records, whole or not at
// all. Its plans are the ones sharing the id of the latest card printed for this directory's files.
async function cardForYes({ t, paths, records, directory, rows, options, again }) {
  const refuse = (line) => { write(line); return null; };
  const cards = await latestCardsOfFiles(records.db, { projectId: records.projectId, files: rows.map((row) => row.taskFile) });
  const latest = cards.reduce((newest, card) => (!newest || card.shown_at > newest.shown_at ? card : newest), null);
  if (!latest?.body.line || latest.body.line.directory !== directory.name) return refuse(t("line.yes.no_card", { again }));
  if (latest.body.schema_version !== PLAN_SCHEMA_VERSION) return refuse(t("yes.old_card", { again }));
  const onCard = cards.filter((card) => card.body.line?.id === latest.body.line.id);
  const changed = t("line.yes.changed", { again });
  if (onCard.length !== latest.body.line.total) return refuse(changed);
  for (const card of onCard) {
    const row = rows.find((candidate) => candidate.taskFile === card.file);
    if (row.text === null || digest(row.text.trim()) !== card.content_sha256) return refuse(changed);
    const option = optionAgainstCard(card.body, options);
    if (option) return refuse(t("yes.option", { option, again }));
    if (!(card.authorization_expires_at > new Date())) return refuse(t("yes.expired", { until: card.authorization_expires_at.toISOString(), again }));
  }
  const shas = onCard.map((card) => card.plan_sha256);
  if (await anyCardUsed(records.db, shas)) return refuse(t("line.yes.used", { again }));
  const plans = [];
  for (const card of [...onCard].sort((left, right) => left.body.line.position - right.body.line.position)) {
    const planPath = planFilePath(paths, card.body);
    await writeJson(planPath, card.body);
    const plan = { ...card.body, plan_path: planPath };
    rows.find((row) => row.taskFile === card.file).plan = plan;
    plans.push(plan);
  }
  return plans;
}

// Before each step, without a model call: a provider of its roles the CLI says is signed out. "unknown"
// is not "out": the step runs, and its own call says.
export async function signedOutProvider(plan, inspect) {
  for (const provider of new Set([plan.writer.provider, plan.reviewer.provider])) {
    if ((await inspect(provider)).next_action === "sign_in") return provider;
  }
  return null;
}

// Runs the plans of a card in order, to the end or to the first stop, and prints the table. One yes
// writes one authorization per plan; each plan still claims its own and passes its own checks when its
// turn comes, so what changed since the yes (the file, the policy, the time) skips that step, with why.
async function runLine({ paths, records, directory, rows, plans, authorizedVia, inspect, tools }) {
  await recordDirectoryYes(records.db, await authorizeCard(paths, plans, { authorizedVia }));
  const outcomes = plans.map((plan) => ({ plan, name: path.posix.basename(plan.task_file), conclusion: "not run", result: null, why: null }));
  let current = null;
  let stop = null;
  const stopCurrent = () => { if (current) stopRun(paths, current).catch(() => {}); };
  const watcher = interruptWatcher(stopCurrent);
  const tag = (outcome) => "[" + outcome.plan.line.position + "/" + outcome.plan.line.total + "] " + outcome.name;
  try {
    for (const outcome of outcomes) {
      const { plan } = outcome;
      if (watcher.hadSignal()) { stop = { kind: "stopped", position: plan.line.position }; break; }
      const now = await fsp.readFile(path.join(paths.repoRoot, ...plan.task_file.split("/")), "utf8").catch(() => null);
      if (now === null || digest(now.trim()) !== plan.task_sha256) {
        Object.assign(outcome, { conclusion: "skipped", why: now === null ? "no longer there" : "changed after the card" });
        write(tag(outcome) + " skipped: " + outcome.why);
        continue;
      }
      const signedOut = inspect ? await signedOutProvider(plan, inspect) : null;
      if (signedOut) { stop = { kind: "signed_out", provider: signedOut, position: plan.line.position }; break; }
      write(tag(outcome) + " started " + localTimestamp(new Date()) + " (run " + plan.proposed_run_id + ")");
      current = plan.proposed_run_id;
      let failure = null;
      // One plain line per step, not a single start's spinner: the prompt library's spinner puts the
      // terminal in raw mode and answers Ctrl+C with process.exit(0) (@clack/core's block), which would
      // leave the run open and its CLI working, with no signal for the watcher to see.
      await tools.runPlan({
        plan,
        authorizedVia,
        // A signal before the run existed had nothing to stop; its first step finds it.
        onStep: (label) => { if (watcher.hadSignal()) stopCurrent(); write("  " + label); },
      }).catch((error) => { failure = error; });
      current = null;
      const run = await readRun(paths, plan.proposed_run_id).catch(() => null);
      if (run) Object.assign(outcome, { conclusion: run.conclusion || "failure", result: run.latest_result_path || run.result_path || null, why: failure?.message ?? null });
      else Object.assign(outcome, { conclusion: "skipped", why: failure?.message ?? "its run was not made" });
      write(tag(outcome) + " " + outcome.conclusion + (outcome.why ? ": " + outcome.why : "") + " " + localTimestamp(new Date()));
      const stopped = run ? stopOfRun(run) : null;
      if (stopped || watcher.hadSignal()) { stop = { ...(stopped || { kind: "stopped" }), position: plan.line.position }; break; }
    }
  } finally {
    watcher.disarm();
  }
  const names = (await fsp.readdir(directory.absolute, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name);
  const known = new Set(rows.filter((row) => rowKind(row) !== "appeared").map((row) => row.name));
  const appeared = names.filter((name) => !known.has(name)).length;
  const width = Math.max(...outcomes.map((outcome) => outcome.name.length)) + 2;
  const widest = Math.max(...outcomes.map((outcome) => outcome.conclusion.length)) + 2;
  write("");
  write("Line " + directory.shown + ":");
  for (const outcome of outcomes) write("  " + outcome.name.padEnd(width) + outcome.conclusion.padEnd(widest) + (outcome.result ? tools.shownPath(outcome.result) : outcome.why || ""));
  if (stop) write(stoppedLine(stop, stop.position, outcomes.filter((outcome) => outcome.conclusion === "not run").map((outcome) => outcome.plan.line.position)));
  if (appeared) write(appeared + " file(s) appeared after the plan and did not run; run start on this directory again.");
  if (stop?.kind === "stopped") return 130;
  if (stop) return 75;
  return outcomes.every((outcome) => outcome.conclusion === "success") ? 0 : 1;
}

// `start <directory>`: every work order checked, one card, one yes, then the line. `tools` are the steps it
// shares with a single start, given by commands.mjs. --yes says yes to the card printed last.
export async function startDirectory({ paths, options, adapter, loadAdapter, guard, reviewerCheck, directory, tools }) {
  if (options.update !== undefined || options.asNew || options.workPackage !== undefined) {
    throw new Error("--update, --as-new and --work-package are about one work order: give its file, not a directory.");
  }
  // As the disk spells it and pasted into any shell, as a single start's: a name may hold a space.
  const fake = options.fakeCli ? " --fake-cli" : "";
  const again = "review-bridge start " + tools.shownPath(directory.absolute).replaceAll("\\", "/") + fake;
  const records = await tools.openRecords(paths);
  const refused = await lineRunningLine(paths, records, directory.name);
  if (refused) { write(refused); return 1; }
  const check = await workOrderChecker(paths, { writer: options.writer, reviewer: options.reviewer, rounds: options.rounds, callTimeout: options.callTimeout });
  const { rows, busy } = await surveyDirectory({ paths, records, directory, check });
  if (busy.length) {
    write(busy.map(({ name, runId }) => name + " is running (run " + runId + ")").join("; ") + ". Stop it or wait for it, then run: " + again);
    return 1;
  }
  const newBatch = () => ({ records, cache: {}, memo: { candidates: null, taken: new Set() } });
  const t = await createTranslator(await resolveLocale(paths));
  let plans;
  if (options.yes) {
    plans = await cardForYes({ t, paths, records, directory, rows, options, again });
    if (!plans) return 1;
  } else {
    const pending = rows.filter((row) => !row.problem && !row.deliveredAt);
    // Every work order of the line says what it must say before the card, or none of them starts: a form is
    // not sent with a field empty. Each one short of it is told at once, its deleted markers written back.
    const unfit = pending.map((row) => ({ row, form: formProblems(parseWorkOrder(row.text.trim())) })).filter(({ form }) => !form.ok);
    if (unfit.length) {
      for (const { row, form } of unfit) await refuseForm(t, new WorkOrderFormError(form), { absolute: row.absolute, file: row.taskFile, again, write });
      return 1;
    }
    const batch = newBatch();
    const id = randomUUID();
    plans = [];
    for (const [index, row] of pending.entries()) {
      const planned = await tools.planOne({ row, batch, line: { id, directory: directory.name, position: index + 1, total: pending.length, step: row.step } });
      if (!planned) return 1;
      row.plan = planned;
      plans.push(planned);
    }
  }
  const place = whereLineRuns();
  const first = plans[0];
  const uncommitted = first ? uncommittedNow(paths.repoRoot) : null;
  write("");
  for (const line of cardLines({ t, directory, rows, place, uncommitted })) write(line);
  if (!first) return 0;
  const withdraw = (list) => withdrawCards(records.db, list.map((plan) => plan.plan_sha256));
  const ready = readiness({ options, adapter, loadAdapter, guard, reviewerCheck, plan: first, again, checkFailureLines: tools.checkFailureLines });
  await markCardsShown(records.db, plans.map((plan) => plan.plan_sha256));
  if (!options.yes) {
    if (!tools.interactive()) { write(needsAuthorizationLine(t, again)); return 1; }
    if (!(await askYes(t("line.card.ask", { count: plans.length })))) {
      await withdraw(plans);
      write(t("card.declined"));
      return 1;
    }
  }
  let release;
  try {
    release = await acquireLock(lineLockFile(paths, directory.name));
  } catch {
    write((await lineRunningLine(paths, records, directory.name)) || directory.name + "/ is being started by another process. Run: review-bridge status to see its progress");
    return 1;
  }
  try {
    const prepared = await ready();
    if (!prepared) {
      if (!options.yes) await withdraw(plans);
      return 1;
    }
    write("");
    // A person may answer long after the card. Whatever ran since (another terminal's line, say) was not
    // on it, and a work order it delivered must not run a second time on this yes.
    const toRun = rows.filter((row) => row.plan);
    const now = await latestRunsOfFiles(records.db, { projectId: records.projectId, files: toRun.map((row) => row.taskFile) });
    if (toRun.some((row) => (now.get(row.taskFile)?.run_id ?? null) !== row.latestRun)) {
      write(t("line.yes.ran_meanwhile", { again }));
      return 1;
    }
    return await runLine({
      paths, records, directory, rows, plans,
      authorizedVia: options.yes ? "agent" : "terminal",
      // The fake CLI has nothing to sign in to, as at the plan.
      inspect: options.fakeCli ? null : (provider) => inspectProvider(provider, { adapter: prepared.adapter }),
      tools: { ...tools, runPlan: (step) => tools.runPlan({ ...step, adapter: prepared.adapter }) },
    });
  } finally {
    await release();
  }
}
