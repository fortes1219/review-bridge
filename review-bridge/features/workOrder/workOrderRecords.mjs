// The work order's records in the person's database (RC3-BLOCKER-01 step 2): which work order a
// file is (Q13), the card a plan is (Q14), the yes that starts it, and the contract it was turned
// into. The plan file under .review-bridge/ is the running copy; the database is the record.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { insertRun, runRecorder } from "../../service/index.mjs";
import { canonical, digest } from "../../utils/digest.mjs";
import { workOrderChange } from "./delivery.mjs";

// "Content close enough" for a renamed file (spec 2026-10-24, numbers set by Opus and kept by Fable
// 2026-10-25): the unchanged lines are more than half of the longer version, among at most 50 work
// orders of the project whose last file is gone.
const RENAME_CANDIDATES = 50;
const sameLinesShare = (change, left, right) => {
  const lines = (text) => String(text).split(/\r?\n/).filter((line) => line.trim()).length;
  const longer = Math.max(lines(left), lines(right));
  if (!change) return 1;
  return longer ? (longer - Math.max(change.removed.length, change.added.length)) / longer : 0;
};
const changedLines = (change) => (change ? Math.max(change.removed.length, change.added.length) : 0);

// The work order's file as the records name it: its path in the project, spelled the way the file
// system spells it (where names ignore case, farm.md and FARM.md are one file, so one name).
export function canonicalTaskFile(repoRoot, file) {
  const real = (target) => { try { return realpathSync.native(target); } catch { return path.resolve(target); } };
  return path.relative(real(repoRoot), real(path.resolve(repoRoot, file))).split(path.sep).join("/");
}

// The work order this file belongs to now in the project, or null.
export async function workOrderOfFile(db, { projectId, fileName }) {
  const { rows } = await db.query(
    "select work_order_id from work_orders where project_id = $1 and last_file_name = $2 order by last_activity_at desc limit 1", [projectId, fileName]);
  return rows[0]?.work_order_id || null;
}

// The work order's title: its first Markdown heading, else the file name.
export function titleOf(text, fileName) {
  const heading = String(text).split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : path.basename(fileName, path.extname(fileName));
}

async function latestVersion(db, workOrderId) {
  const { rows } = await db.query(
    "select version_no, content_sha256, source_text, title from work_order_versions where work_order_id = $1 order by version_no desc limit 1",
    [workOrderId],
  );
  return rows[0] || null;
}

function decided(kind, workOrderId, title, latest, text) {
  if (kind === "new") return { decision: "new", work_order_id: null, title, from_version: null, to_version: 1, changed_lines: null };
  if (latest && latest.content_sha256 === digest(text)) {
    return { decision: "same", work_order_id: workOrderId, title, from_version: latest.version_no, to_version: latest.version_no, changed_lines: 0 };
  }
  const change = latest ? workOrderChange(latest.source_text, text) : null;
  return {
    decision: "update", work_order_id: workOrderId, title,
    from_version: latest ? latest.version_no : null, to_version: (latest ? latest.version_no : 0) + 1, changed_lines: changedLines(change),
  };
}

// Q13, no model: the work order this file is, as the card will show it. `fileName` is the file's
// path in the project as canonicalTaskFile names it; `update` (a work order id) and `asNew` are how
// the person or an agent overrides it. The decision names the file, and says when it was forced new.
export async function identifyWorkOrder(db, options) {
  const decision = await decide(db, options);
  return { ...decision, file: options.fileName, ...(options.asNew ? { as_new: true } : {}) };
}

async function decide(db, { projectId, fileName, text, repoRoot, update = null, asNew = false }) {
  const title = titleOf(text, fileName);
  if (asNew) return decided("new", null, title, null, text);
  if (update) {
    const { rows } = await db.query("select work_order_id from work_orders where work_order_id = $1 and project_id = $2", [update, projectId]);
    if (!rows.length) throw new Error("There is no work order " + update + " in this project. Run: review-bridge status");
    return decided("update", update, title, await latestVersion(db, update), text);
  }
  const named = await workOrderOfFile(db, { projectId, fileName });
  if (named) return decided("update", named, title, await latestVersion(db, named), text);
  // A renamed file: the work orders whose last file is gone, newest first; a copy keeps its original,
  // so the original is never a candidate and the copy is a new work order.
  const { rows } = await db.query(
    "select w.work_order_id, w.last_file_name, v.version_no, v.content_sha256, v.source_text"
    + " from work_orders w cross join lateral (select version_no, content_sha256, source_text from work_order_versions"
    + " where work_order_id = w.work_order_id order by version_no desc limit 1) v"
    + " where w.project_id = $1 order by w.last_activity_at desc, w.work_order_id desc limit $2",
    [projectId, RENAME_CANDIDATES],
  );
  let best = null;
  for (const row of rows) {
    const there = await fsp.stat(path.join(repoRoot, ...row.last_file_name.split("/"))).then(() => true, () => false);
    if (there) continue;
    const share = sameLinesShare(workOrderChange(row.source_text, text), row.source_text, text);
    if (share > 0.5 && (!best || share > best.share)) best = { share, row };
  }
  if (!best) return decided("new", null, title, null, text);
  return decided("update", best.row.work_order_id, title, best.row, text);
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
    throw new Error("This project's records were cleared (clean --all); its id is not used again. Run: review-bridge uninstall, then review-bridge init");
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
  await db.query(
    "insert into plans (plan_sha256, project_id, work_order_id, content_sha256, source_file, proposed_run_id, effective_policy_sha256,"
    + " repo_root, authorization_expires_at, body, created_at, shown_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [plan.plan_sha256, projectId, plan.work_order?.work_order_id || null, plan.task_sha256, plan.work_order?.file ?? plan.task_file, plan.proposed_run_id,
      plan.effective_policy_sha256, plan.repo_root, plan.authorization_expires_at, body, plan.created_at, shown ? new Date().toISOString() : null],
  );
}

export async function markCardShown(db, planSha256) {
  await db.query("update plans set shown_at = coalesce(shown_at, now()) where plan_sha256 = $1", [planSha256]);
}

// E10: a card never shown (the reviewer check refused) or answered no takes no later --yes.
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

// The start, in one transaction with the file authorization `authorize` makes: the card is locked,
// a used one is refused, then the work order (new, or the card's) and its version, the
// authorization and its claim are written. Two --yes to one card queue on the lock; the second
// finds the claim and is refused, and `authorize` never runs for it. The run's events made while
// authorizing (its start, an earlier version closed as superseded) are held and written here, after
// the run's row (step 3). Anything that fails rolls the whole start back; `authorize`'s own run is
// closed by the caller.
export async function recordStart(db, { planSha256, authorize }) {
  const recorder = runRecorder();
  if (!recorder) throw new Error("This process keeps no run records; a start is refused.");
  return await db.transaction(async (tx) => {
    const { rows } = await tx.query("select project_id, body, withdrawn_at from plans where plan_sha256 = $1 for update", [planSha256]);
    if (!rows.length) throw new Error("This plan is not in Bridge's records. Run: review-bridge start <file> again");
    if (rows[0].withdrawn_at) throw new Error("This card was answered no or never shown. Run: review-bridge start <file> again");
    const used = await tx.query("select 1 from authorization_claims where claim_key = $1", ["plan-" + planSha256]);
    if (used.rows.length) throw new Error("This card was already said yes to; one card starts one run. Run: review-bridge start <file> again");
    const { project_id: projectId, body: plan } = rows[0];
    const file = plan.work_order?.file ?? plan.task_file;
    // One start of a file, and of a work order, at a time (PostgreSQL's advisory lock, released when
    // this transaction ends). A second start meanwhile is refused at once, as the start lock always
    // refused it (design step 3: not queued); once the first ends, a new card sees what it made.
    const keys = [projectId + ":file:" + file, ...(plan.work_order?.work_order_id ? [projectId + ":order:" + plan.work_order.work_order_id] : [])].sort();
    for (const key of keys) {
      const { rows: [{ locked }] } = await tx.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked", [key]);
      if (!locked) throw new Error("Another start of " + file + " is in progress; nothing was created. Try again in a moment.");
    }
    // A card that said "new work order" is out of date once its file became a work order after it
    // was shown (another card for the same file was said yes to first); --as-new is meant new.
    if (plan.work_order?.decision === "new" && !plan.work_order.as_new) {
      const owner = await workOrderOfFile(tx, { projectId, fileName: file });
      if (owner) throw new Error("This card was made before " + file + " became work order " + owner + "; nothing was created. Run: review-bridge start " + file + " again to see the card as it is now");
    }
    recorder.hold();
    let started;
    try {
      started = await authorize();
    } catch (error) {
      recorder.drop();
      throw error;
    }
    const now = new Date().toISOString();
    const workOrder = plan.work_order || { decision: "new", title: titleOf(plan.task, plan.task_file) };
    let workOrderId = workOrder.work_order_id;
    if (workOrder.decision === "new") {
      workOrderId = randomUUID();
      await tx.query(
        "insert into work_orders (work_order_id, project_id, last_file_name, created_at, last_activity_at) values ($1, $2, $3, $4, $4)",
        [workOrderId, projectId, file, now],
      );
    } else {
      const updated = await tx.query(
        "update work_orders set last_file_name = $3, last_activity_at = $4 where work_order_id = $1 and project_id = $2",
        [workOrderId, projectId, file, now],
      );
      if (!updated.rowCount) throw new Error("The work order " + workOrderId + " this card updates is no longer in Bridge's records. Run: review-bridge start <file> again");
    }
    const version = await tx.query(
      "insert into work_order_versions (work_order_id, content_sha256, version_no, title, source_text, source_file, sealed_at)"
      + " select $1, $2, coalesce(max(version_no), 0) + 1, $3, $4, $5, $6 from work_order_versions where work_order_id = $1"
      + " on conflict (work_order_id, content_sha256) do update set content_sha256 = excluded.content_sha256"
      + " returning version_no",
      [workOrderId, plan.task_sha256, workOrder.title, plan.task, file, now],
    );
    const authorization = started.authorization;
    await tx.query(
      "insert into authorizations (authorization_id, kind, plan_sha256, authorized_by, authorized_via, authorized_at, expires_at, authorization_sha256, body)"
      + " values ($1, 'start', $2, $3, $4, $5, $6, $7, $8)",
      [authorization.authorization_id, planSha256, authorization.authorized_by, authorization.authorized_via,
        authorization.authorized_at, authorization.expires_at, authorization.authorization_sha256, authorization],
    );
    await tx.query(
      "insert into authorization_claims (claim_key, authorization_id, run_id, claim_kind, claimed_at) values ($1, $2, $3, 'start', $4)",
      ["plan-" + planSha256, authorization.authorization_id, started.run.run_id, started.run.created_at],
    );
    await tx.query("update projects set last_activity_at = $2 where project_id = $1", [projectId, now]);
    try {
      await insertRun(tx, { run: started.run, projectId, workOrderId, contentSha256: plan.task_sha256, planSha256, repoRoot: plan.repo_root });
      await recorder.flush(tx);
    } finally {
      recorder.drop();
    }
    return { ...started, workOrderId, versionNo: version.rows[0].version_no };
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
    await tx.query("update projects set cleared_at = now() where project_id = $1", [projectId]);
    return counts;
  });
}
