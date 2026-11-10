// The work order's records in the person's database (RC3-BLOCKER-01 step 2): which work order a
// file is (Q13), the card a plan is (Q14), the yes that starts it, and the contract it was turned
// into. The plan file under .review-bridge/ is the running copy; the database is the record.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { insertRun, runRecorder } from "../../service/index.mjs";
import { canonical, digest } from "../../utils/digest.mjs";
import { nfc } from "../../utils/workOrderName.mjs";
import { workOrderChange } from "./delivery.mjs";
import { parseWorkOrder, UNTITLED, workOrderIdOf } from "./workOrderFormat.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

const changedLines = (change) => (change ? Math.max(change.removed.length, change.added.length) : 0);

// The work order's file as the records name it: its path in the project, spelled the way the file
// system spells it (where names ignore case, farm.md and FARM.md are one file, so one name), in NFC (a
// macOS disk hands the same name back decomposed). Never used to open the file: plan.task_file does that.
export function canonicalTaskFile(repoRoot, file) {
  return nfc(path.relative(realAsFarAsItGoes(repoRoot), realAsFarAsItGoes(path.resolve(repoRoot, file))).split(path.sep).join("/"));
}

// A path spelled as the file system spells it, also when its last parts are not there yet: the nearest part
// that exists is made real and the rest joined back, as CPython's non-strict realpath does on Windows
// (Lib/ntpath.py _getfinalpathname_nonstrict: "find as much of the target directory as we can and join the
// rest"). Both sides of path.relative then have one spelling, so a short name (C:\Users\RUNNER~1, a CI
// runner's TEMP) on one side and the long name on the other no longer part them. Like CPython it walks up
// only past a part that is not there; any other error leaves the path as it was given.
function realAsFarAsItGoes(target) {
  const rest = [];
  let at = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(at), ...rest);
    } catch (error) {
      const up = path.dirname(at);
      if (!["ENOENT", "ENOTDIR"].includes(error.code) || up === at) return path.resolve(target);
      rest.unshift(path.basename(at));
      at = up;
    }
  }
}

// Whether a file the records name is there, however the disk spells that name: a disk that keeps names
// as they were written has the decomposed one under its own bytes, and it is not gone.
async function recordedFileThere(repoRoot, relative) {
  if (await fsp.stat(path.join(repoRoot, ...relative.split("/"))).then(() => true, () => false)) return true;
  if (/^[\x00-\x7f]*$/.test(relative)) return false;
  let folder = repoRoot;
  for (const part of relative.split("/")) {
    const entry = (await fsp.readdir(folder).catch(() => [])).find((name) => nfc(name) === part);
    if (entry === undefined) return false;
    folder = path.join(folder, entry);
  }
  return true;
}

// The work order this file belongs to now in the project, or null.
export async function workOrderOfFile(db, { projectId, fileName }) {
  const { rows } = await db.query(
    "select work_order_id from work_orders where project_id = $1 and last_file_name = $2 order by last_activity_at desc limit 1", [projectId, fileName]);
  return rows[0]?.work_order_id || null;
}

// `logs <source_id>`: this project's work orders one of whose versions carries that source_id (a copied
// work order keeps it, so there may be several), through work_order_versions_by_source_id.
export async function workOrdersWithSourceId(db, { projectId, sourceId }) {
  const { rows } = await db.query(
    "select distinct v.work_order_id from work_order_versions v join work_orders w on w.work_order_id = v.work_order_id"
    + " where v.source_id = $2 and w.project_id = $1", [projectId, sourceId]);
  return rows.map((row) => row.work_order_id);
}

// Who a run's result is about, for the head of the result (RC3-FIX-01 round 2), in one statement by
// primary key: the sealed version the run worked on and the file it was started from (the plan's,
// which is this run's; work_orders.last_file_name moves with later starts), the contract and the
// version of the work the last acceptance decision rested on. Null when the run is not in the database.
export async function resultIdentity(db, runId) {
  const { rows } = await db.query(
    "select r.run_id, r.conclusion, r.closed_at, r.contract_sha256, v.version_no, v.title, v.source_text, p.source_file,"
    + " r.writer_provider, r.writer_model, r.writer_effort, r.reviewer_provider, r.reviewer_model, r.reviewer_effort, r.reviewer_mcp,"
    + " (select d.review_version from acceptance_decisions d where d.run_id = r.run_id order by d.sequence desc limit 1) as review_version"
    + " from runs r join work_order_versions v on v.work_order_id = r.work_order_id and v.content_sha256 = r.content_sha256"
    + " join plans p on p.plan_sha256 = r.plan_sha256 where r.run_id = $1",
    [runId],
  );
  if (!rows[0]) return null;
  const { source_text: sourceText, ...row } = rows[0];
  return { ...row, source_id: parseWorkOrder(sourceText).frontmatter.source_id };
}

// The work order's title: its first Markdown heading, else untitled.
export function titleOf(text) {
  const heading = String(text).split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : UNTITLED;
}

async function latestVersion(db, workOrderId) {
  const { rows } = await db.query(
    "select version_no, content_sha256, source_text, title from work_order_versions where work_order_id = $1 order by version_no desc limit 1",
    [workOrderId],
  );
  return rows[0] || null;
}

// A new work order's id is made with its card, so the yes can write it into the file before any work.
function decided(kind, workOrderId, title, latest, text) {
  if (kind === "new") return { decision: "new", work_order_id: workOrderId ?? randomUUID(), title, from_version: null, to_version: 1, changed_lines: null };
  if (latest && latest.content_sha256 === digest(text)) {
    return { decision: "same", work_order_id: workOrderId, title, from_version: latest.version_no, to_version: latest.version_no, changed_lines: 0 };
  }
  const change = latest ? workOrderChange(latest.source_text, text) : null;
  return {
    decision: "update", work_order_id: workOrderId, title,
    from_version: latest ? latest.version_no : null, to_version: (latest ? latest.version_no : 0) + 1, changed_lines: changedLines(change),
  };
}

// Q13, no model: the work order this file is, as the card will show it (Owner 2026-11-08 10:4x). It is
// the id in the file's front matter, which Bridge wrote on the first yes, as Docusaurus and Astro take a
// document's id from its front matter: a new name, folder or step number is the same work order, and new
// text is its next version. A file without an id is a new work order. Two files with one id: the one the
// records last saw is the work order, the other a copy, which is a new one. No content is compared (git's
// similarity only shows a rename; it is no identity). `fileName` is the file's path in the project as
// canonicalTaskFile names it, `text` its sealed text (sealedText) and `id` the id its front matter holds;
// `update` (a work order id) and `asNew` are how the person or an agent overrides it. `file_id` is the id
// the front matter held when the card was made: the yes takes the card only while the file still holds it
// (cardStillMatches), so the card and the yes know a work order by the same rule.
export async function identifyWorkOrder(db, options) {
  const decision = await decide(db, options);
  return { ...decision, file: options.fileName, file_id: options.id ?? null, ...(options.asNew ? { as_new: true } : {}) };
}

// At the yes, the same rule as the card's (Fortes 2026-11-09): the file's front matter id is what it was
// when the card was made. A file that gained one since (another card's yes wrote it) is that work order
// now, not the new one this card shows; --as-new is meant new and is taken as shown.
export function cardStillMatches(workOrder, raw) {
  if (!workOrder || workOrder.as_new) return true;
  return (workOrderIdOf(raw) ?? null) === (workOrder.file_id ?? null);
}

// Whether the file the records last saw for a work order still holds that work order's id.
async function stillHolds(repoRoot, relative, id) {
  if (!(await recordedFileThere(repoRoot, relative))) return false;
  const raw = await fsp.readFile(path.join(repoRoot, ...relative.split("/")), "utf8").catch(() => null);
  return raw !== null && workOrderIdOf(raw) === id;
}

// Whether two of the project's paths name one file: the same device and inode (Windows: the file index
// Node gives as `ino`), as find -samefile and coreutils `test -ef` decide. A file system that gives no
// file id cannot tell a hard link from a copy, and is refused rather than guessed (workOrderLocation's rule).
export async function sameFile(repoRoot, left, right, { stat = (file) => fsp.stat(file, { bigint: true }) } = {}) {
  const [a, b] = await Promise.all([left, right].map((relative) => stat(path.join(repoRoot, ...relative.split("/")))));
  if (!a.ino || !b.ino) throw new Error("This file system gives no file id, so Bridge cannot tell whether " + left + " and " + right + " are one file or a copy; nothing was planned.");
  return a.dev === b.dev && a.ino === b.ino;
}

// Whether `fileName`, holding `id`, is a copy of the work order the records last saw in `recorded`: that
// file still holds the id and is another file. Two names holding one id are one work order when they are
// one file (a hard link, as find -samefile and rsync -H tell it). The card and a directory's line both ask this.
export async function isCopy(repoRoot, { recorded, fileName, id }) {
  return recorded !== fileName && await stillHolds(repoRoot, recorded, id) && !(await sameFile(repoRoot, recorded, fileName));
}

async function decide(db, { projectId, fileName, text, id = null, repoRoot, update = null, asNew = false }) {
  const title = titleOf(text);
  if (asNew) return decided("new", null, title, null, text);
  if (update) {
    const { rows } = await db.query("select work_order_id from work_orders where work_order_id = $1 and project_id = $2", [update, projectId]);
    if (!rows.length) throw new Error("There is no work order " + update + " in this project. Run: " + bridgeRunner() + " status");
    return decided("update", update, title, await latestVersion(db, update), text);
  }
  if (!id) return decided("new", null, title, null, text);
  const { rows } = await db.query("select last_file_name from work_orders where work_order_id = $1 and project_id = $2", [id, projectId]);
  // An id the records do not know (its records were cleared, or the file came from elsewhere) is kept.
  if (!rows.length) return decided("new", id, title, null, text);
  const recorded = rows[0].last_file_name;
  if (await isCopy(repoRoot, { recorded, fileName, id })) {
    return { ...decided("new", null, title, null, text), copy_of: recorded };
  }
  return { ...decided("update", id, title, await latestVersion(db, id), text), ...(recorded !== fileName ? { moved_from: recorded } : {}) };
}

// A project is recorded at its first use and found again by its id wherever its folder is now.
export async function ensureProject(db, { projectId, root }) {
  const now = new Date().toISOString();
  const { rows } = await db.query(
    "insert into projects (project_id, root_path, name, created_at, last_activity_at) values ($1, $2, $3, $4, $4)"
    + " on conflict (project_id) do update set root_path = excluded.root_path, last_activity_at = excluded.last_activity_at"
    + " returning cleared_at",
    [projectId, root, path.basename(root), now],
  );
  if (rows[0].cleared_at) {
    throw new Error("This project's records were cleared (clean --all); its id is not used again. Run: " + bridgeRunner() + " uninstall, then " + bridgeRunner() + " init");
  }
}

// The plan a card shows, recorded when it is made. `shown` is set when the card is printed.
export async function recordCard(db, { projectId, plan, snapshot, shown }) {
  await db.query(
    "insert into policy_snapshots (effective_policy_sha256, policy_schema_version, package_default_policy_sha256, project_override_sha256, policy, created_at)"
    + " values ($1, $2, $3, $4, $5, now()) on conflict (effective_policy_sha256) do nothing",
    [snapshot.effective_policy_sha256, snapshot.policy_schema_version, snapshot.package_default_policy_sha256, snapshot.project_override_sha256, snapshot.effective_policy],
  );
  const { plan_path: _ignored, ...body } = plan;
  // A card for a new work order names no work order yet: its id is made with the card and kept in the plan's
  // body, and the work order is recorded only by the yes (recordStart), as the column's null always meant.
  // A card prints with nothing in the records pointing at a work order that does not exist.
  const existing = plan.work_order?.decision === "new" ? null : plan.work_order?.work_order_id || null;
  await db.query(
    "insert into plans (plan_sha256, project_id, work_order_id, content_sha256, source_file, proposed_run_id, effective_policy_sha256,"
    + " repo_root, authorization_expires_at, body, created_at, shown_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [plan.plan_sha256, projectId, existing, plan.task_sha256, plan.work_order?.file ?? plan.task_file, plan.proposed_run_id,
      plan.effective_policy_sha256, plan.repo_root, plan.authorization_expires_at, body, plan.created_at, shown ? new Date().toISOString() : null],
  );
}

export async function markCardShown(db, planSha256) {
  await db.query("update plans set shown_at = coalesce(shown_at, now()) where plan_sha256 = $1", [planSha256]);
}

// E10: a card answered no, or that the reviewer check refused after its yes at a terminal, takes no later --yes.
export async function withdrawCard(db, planSha256) {
  await db.query("update plans set withdrawn_at = now() where plan_sha256 = $1 and withdrawn_at is null", [planSha256]);
}

// Q14: the card --yes is for: this project's latest printed, not withdrawn plan for this file.
export async function cardFor(db, { projectId, fileName }) {
  const { rows } = await db.query(
    "select plan_sha256, content_sha256, authorization_expires_at, body from plans"
    + " where project_id = $1 and source_file = $2 and shown_at is not null and withdrawn_at is null"
    + " order by shown_at desc limit 1",
    [projectId, fileName],
  );
  return rows[0] || null;
}

export async function cardUsed(db, planSha256) {
  const { rows } = await db.query("select 1 from authorization_claims where claim_key = $1", ["plan-" + planSha256]);
  return rows.length > 0;
}

// What a directory's card shows beside each file, for that directory's files only: the work order that
// file is by the card's rule (Fortes 2026-11-09) and that work order's latest run. `orders` are
// { file, id }, id being the one the file's front matter holds: a file without one is a new work order
// and has no run, and a copy of another file's work order is new too (isCopy). One probe of
// work_orders_pkey and one of runs_by_work_order per file with an id, whatever the history holds.
export async function latestRunsOfWorkOrders(db, { projectId, repoRoot, orders }) {
  const known = orders.filter((order) => order.id);
  if (!known.length) return new Map();
  const { rows } = await db.query(
    "select o.file, w.work_order_id, w.last_file_name, r.run_id, r.status, r.conclusion, r.closed_reason, r.closed_at"
    + " from unnest($2::text[], $3::uuid[]) as o(file, id)"
    + " join work_orders w on w.work_order_id = o.id and w.project_id = $1"
    + " left join lateral (select run_id, status, conclusion, closed_reason, closed_at from runs where work_order_id = w.work_order_id order by created_at desc, run_id desc limit 1) r on true",
    [projectId, known.map((order) => order.file), known.map((order) => order.id)],
  );
  const found = new Map();
  for (const row of rows) {
    if (await isCopy(repoRoot, { recorded: row.last_file_name, fileName: row.file, id: row.work_order_id })) continue;
    found.set(row.file, row);
  }
  return found;
}

// The latest printed, not withdrawn plan of each of these files (Q14 for many): one probe of
// plans_shown_by_file per file.
export async function latestCardsOfFiles(db, { projectId, files }) {
  const { rows } = await db.query(
    "select f.file, p.plan_sha256, p.content_sha256, p.authorization_expires_at, p.shown_at, p.body"
    + " from unnest($2::text[]) as f(file) cross join lateral (select plan_sha256, content_sha256, authorization_expires_at, shown_at, body from plans"
    + " where project_id = $1 and source_file = f.file and shown_at is not null and withdrawn_at is null order by shown_at desc limit 1) p",
    [projectId, files],
  );
  return rows;
}

export async function markCardsShown(db, planShas) {
  await db.query("update plans set shown_at = coalesce(shown_at, now()) where plan_sha256 = any($1::text[])", [planShas]);
}

export async function withdrawCards(db, planShas) {
  await db.query("update plans set withdrawn_at = now() where plan_sha256 = any($1::text[]) and withdrawn_at is null", [planShas]);
}

export async function anyCardUsed(db, planShas) {
  const { rows } = await db.query("select 1 from authorization_claims where claim_key = any($1::text[]) limit 1", [planShas.map((sha) => "plan-" + sha)]);
  return rows.length > 0;
}

const insertStartAuthorization = (tx, planSha256, authorization) => tx.query(
  "insert into authorizations (authorization_id, kind, plan_sha256, authorized_by, authorized_via, authorized_at, expires_at, authorization_sha256, body)"
  + " values ($1, 'start', $2, $3, $4, $5, $6, $7, $8) on conflict (authorization_id) do nothing",
  [authorization.authorization_id, planSha256, authorization.authorized_by, authorization.authorized_via,
    authorization.authorized_at, authorization.expires_at, authorization.authorization_sha256, authorization],
);

// One yes to a directory's card: one authorization for each plan on it, in one transaction, so a yes
// is recorded whole or not at all. Each plan's own start claims its authorization later (recordStart).
export async function recordDirectoryYes(db, authorizations) {
  await db.transaction(async (tx) => {
    for (const { planSha256, authorization } of authorizations) await insertStartAuthorization(tx, planSha256, authorization);
  });
}

// The start, in one transaction with the file authorization `authorize` makes: the card is locked,
// a used one is refused, then the work order (new, or the card's) and its version, the
// authorization and its claim are written. Two --yes to one card queue on the lock; the second
// finds the claim and is refused, and `authorize` never runs for it. The new run's own events made
// while authorizing (its start) are held and written here, after the run's row (step 3), each only
// under the number it was given. Anything that fails rolls the whole start back; `authorize`'s own
// run is closed by the caller. An earlier version it stopped stays stopped, as GitHub Actions cancels
// a run in progress for a newer one of its concurrency group (DECISIONS 2026-11-03): that stop was
// recorded when it happened, and only its link to this run, which did not exist then, is written here.
// One start of a file, and of a work order, at a time (PostgreSQL's advisory lock, released when the
// transaction ends). A second start meanwhile is refused at once, as the start lock always refused it
// (design step 3: not queued); once the first ends, a new card sees what it made.
async function lockWorkOrder(tx, { projectId, plan, file }) {
  const keys = [projectId + ":file:" + file, ...(plan.work_order?.work_order_id ? [projectId + ":order:" + plan.work_order.work_order_id] : [])].sort();
  for (const key of keys) {
    const { rows: [{ locked }] } = await tx.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked", [key]);
    if (!locked) throw new Error("Another start of " + file + " is in progress; nothing was created. Try again in a moment.");
  }
}

// The work order a card names (new, or the card's) and this version of it, as the yes makes them.
async function writeWorkOrderVersion(tx, { projectId, plan, file, now }) {
  const workOrder = plan.work_order || { decision: "new", title: titleOf(plan.task) };
  let workOrderId = workOrder.work_order_id;
  if (workOrder.decision === "new") {
    // The card made the id, and the yes wrote it into the file (a plan without one is from work-plan's
    // inline task, which has no file to write it into).
    workOrderId ??= randomUUID();
    await tx.query(
      "insert into work_orders (work_order_id, project_id, last_file_name, created_at, last_activity_at) values ($1, $2, $3, $4, $4)",
      [workOrderId, projectId, file, now],
    );
  } else {
    const updated = await tx.query(
      "update work_orders set last_file_name = $3, last_activity_at = $4 where work_order_id = $1 and project_id = $2",
      [workOrderId, projectId, file, now],
    );
    if (!updated.rowCount) throw new Error("The work order " + workOrderId + " this card updates is no longer in Bridge's records. Run: " + bridgeRunner() + " start <file> again");
  }
  const version = await tx.query(
    "insert into work_order_versions (work_order_id, content_sha256, version_no, title, source_text, source_file, sealed_at, source_id)"
    + " select $1, $2, coalesce(max(version_no), 0) + 1, $3, $4, $5, $6, $7 from work_order_versions where work_order_id = $1"
    + " on conflict (work_order_id, content_sha256) do update set content_sha256 = excluded.content_sha256"
    + " returning version_no",
    [workOrderId, plan.task_sha256, workOrder.title, plan.task, file, now, parseWorkOrder(plan.task).frontmatter.source_id],
  );
  return { workOrderId, versionNo: version.rows[0].version_no };
}

export async function recordStart(db, { planSha256, authorize }) {
  const recorder = runRecorder();
  if (!recorder) throw new Error("This process keeps no run records; a start is refused.");
  return await db.transaction(async (tx) => {
    const { rows } = await tx.query("select project_id, body, withdrawn_at from plans where plan_sha256 = $1 for update", [planSha256]);
    if (!rows.length) throw new Error("This plan is not in Bridge's records. Run: " + bridgeRunner() + " start <file> again");
    if (rows[0].withdrawn_at) throw new Error("This card was answered no or never shown. Run: " + bridgeRunner() + " start <file> again");
    const used = await tx.query("select 1 from authorization_claims where claim_key = $1", ["plan-" + planSha256]);
    if (used.rows.length) throw new Error("This card was already said yes to; one card starts one run. Run: " + bridgeRunner() + " start <file> again");
    const { project_id: projectId, body: plan } = rows[0];
    const file = plan.work_order?.file ?? plan.task_file;
    await lockWorkOrder(tx, { projectId, plan, file });
    recorder.hold(plan.proposed_run_id);
    const started = await authorize();
    const now = new Date().toISOString();
    const { workOrderId, versionNo } = await writeWorkOrderVersion(tx, { projectId, plan, file, now });
    const authorization = started.authorization;
    // A directory's yes wrote it already (recordDirectoryYes); its id is the plan's, so it is this one.
    await insertStartAuthorization(tx, planSha256, authorization);
    await tx.query(
      "insert into authorization_claims (claim_key, authorization_id, run_id, claim_kind, claimed_at) values ($1, $2, $3, 'start', $4)",
      ["plan-" + planSha256, authorization.authorization_id, started.run.run_id, started.run.created_at],
    );
    await tx.query("update projects set last_activity_at = $2 where project_id = $1", [projectId, now]);
    await insertRun(tx, { run: started.run, projectId, workOrderId, contentSha256: plan.task_sha256, planSha256, repoRoot: plan.repo_root, writer: plan.writer, reviewer: plan.reviewer });
    await recorder.flush(tx);
    if (started.superseded?.length) {
      await tx.query("update runs set superseded_by = $1 where run_id = any($2::uuid[])", [started.run.run_id, started.superseded]);
    }
    return { ...started, workOrderId, versionNo };
  }).catch((error) => {
    recorder.drop();
    throw error;
  });
}

// A sealed contract, recorded once under its SHA-256 with the text the hash is over.
export async function recordContract(db, { workOrderId, contentSha256, contractSha256, contract }) {
  const canonicalText = JSON.stringify(canonical(contract));
  if (digest(contract) !== contractSha256) throw new Error("The contract does not hash to " + contractSha256 + ".");
  await db.query(
    "insert into contracts (contract_sha256, work_order_id, content_sha256, canonical_text, sealed_at) values ($1, $2, $3, $4, now())"
    + " on conflict (contract_sha256, work_order_id, content_sha256) do nothing",
    [contractSha256, workOrderId, contentSha256, canonicalText],
  );
}

// clean --all: the project's records go in one transaction; its id is kept as cleared.
export async function clearProject(db, projectId) {
  return await db.transaction(async (tx) => {
    const plans = "select plan_sha256 from plans where project_id = $1";
    const orders = "select work_order_id from work_orders where project_id = $1";
    const counts = {};
    const remove = async (table, sql) => { counts[table] = (await tx.query(sql, [projectId])).rowCount; };
    // A run's events and facts go with it (on delete cascade).
    await remove("runs", "delete from runs where project_id = $1");
    await remove("authorization_claims", "delete from authorization_claims where authorization_id in (select authorization_id from authorizations where plan_sha256 in (" + plans + "))");
    await remove("authorizations", "delete from authorizations where plan_sha256 in (" + plans + ")");
    await remove("contracts", "delete from contracts where work_order_id in (" + orders + ")");
    await remove("plans", "delete from plans where project_id = $1");
    await remove("work_order_versions", "delete from work_order_versions where work_order_id in (" + orders + ")");
    await remove("work_orders", "delete from work_orders where project_id = $1");
    // The graph's definitions, references and imports go with their files (on delete cascade).
    await remove("graph_files", "delete from graph_files where project_id = $1");
    await remove("graph_states", "delete from graph_states where project_id = $1");
    await tx.query("update projects set cleared_at = now() where project_id = $1", [projectId]);
    return counts;
  });
}
