import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  ensureDir,
  fileExists,
  readJson,
  writeJsonExclusiveDurable,
  writeTextDurable,
} from "./io.mjs";
import { digest, loadOrCreatePolicySnapshot } from "./policy-v4.mjs";
import { listRuns } from "./state-v4.mjs";

function migrationDigest(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_sha256;
  return digest(copy);
}

function byteDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertLegacyInactive(paths, control) {
  if (![2, 3].includes(Number(control.schema_version))) throw new Error("Legacy CONTROL schema is unsupported.");
  if (!["inactive", "consumed"].includes(control.authorization_status)) {
    throw new Error("Legacy CONTROL must be inactive or consumed before migration.");
  }
  for (const file of [paths.workerLockPath, paths.boundedLockPath]) {
    if (await fileExists(file)) throw new Error("Legacy Bridge lock must be clear before migration.");
  }
  if ((await listRuns(paths, { activeOnly: true })).length) throw new Error("v4 runs must be inactive before migration.");
}

export async function planLegacyControlMigration(paths) {
  if (!(await fileExists(paths.controlPath))) throw new Error("Legacy CONTROL does not exist.");
  const raw = await fsp.readFile(paths.controlPath);
  const control = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  await assertLegacyInactive(paths, control);
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const plan = {
    schema_version: 4,
    operation: "migrate_legacy_control",
    created_at: new Date().toISOString(),
    legacy_control_sha256: byteDigest(raw),
    legacy_schema_version: control.schema_version,
    legacy_authorization_status: control.authorization_status,
    effective_policy_sha256: snapshot.effective_policy_sha256,
    imports: ["terminal status as historical metadata"],
    omissions: ["replayable authorization", "legacy active session identity"],
  };
  plan.plan_sha256 = migrationDigest(plan);
  return plan;
}

export async function applyLegacyControlMigration(paths, plan, approval) {
  if (plan?.schema_version !== 4 || plan?.operation !== "migrate_legacy_control") {
    throw new Error("Migration plan is invalid.");
  }
  const checksum = migrationDigest(plan);
  if (plan.plan_sha256 !== checksum || approval !== checksum) throw new Error("Migration approval checksum is invalid.");
  const raw = await fsp.readFile(paths.controlPath);
  if (byteDigest(raw) !== plan.legacy_control_sha256) throw new Error("Legacy CONTROL changed after planning.");
  const control = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  await assertLegacyInactive(paths, control);
  const archivePath = path.join(paths.legacyArchiveDir, plan.legacy_control_sha256 + ".json");
  await ensureDir(paths.legacyArchiveDir);
  if (!(await fileExists(archivePath))) await writeTextDurable(archivePath, raw);
  const report = {
    schema_version: 4,
    operation: "migrate_legacy_control",
    applied_at: new Date().toISOString(),
    legacy_archive_path: archivePath,
    legacy_control_sha256: plan.legacy_control_sha256,
    imported: {
      schema_version: control.schema_version,
      authorization_status: control.authorization_status,
      closed_reason: control.closed_reason || null,
    },
    omitted: plan.omissions,
    created_authorizations: 0,
    effective_policy_sha256: plan.effective_policy_sha256,
  };
  const reportPath = path.join(paths.legacyArchiveDir, plan.legacy_control_sha256 + ".migration-report.json");
  if (!(await fileExists(reportPath))) await writeJsonExclusiveDurable(reportPath, report);
  await fsp.rm(paths.controlPath);
  return report;
}

export async function rollbackLegacyControlMigration(paths, legacySha256) {
  if (await fileExists(paths.controlPath)) throw new Error("Legacy CONTROL already exists.");
  if ((await listRuns(paths, { activeOnly: true })).length) throw new Error("Cannot restore legacy CONTROL while v4 runs are active.");
  const archivePath = path.join(paths.legacyArchiveDir, legacySha256 + ".json");
  const raw = await fsp.readFile(archivePath);
  if (byteDigest(raw) !== legacySha256) throw new Error("Legacy archive checksum is invalid.");
  await writeTextDurable(paths.controlPath, raw, { exclusive: true });
  return { restored: true, legacy_control_sha256: legacySha256 };
}
