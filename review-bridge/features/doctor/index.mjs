import path from "node:path";

import { activeRuns, fileExists, listJson, listRuns, loadOrCreatePolicySnapshot, readJson } from "../../service/index.mjs";
import { priorityChoice } from "../../policy/policyRules.mjs";
import { inspectStateFilesystem } from "../../utils/filesystem.mjs";
import { consoleEncodingHint, powershellCodePage } from "./consoleEncoding.mjs";
import { bridgeRunner } from "../../utils/bridgeCommand.mjs";

// `codePage` is the one PowerShell writes in (asked only on Windows); tests pass it in.
export async function inspectDoctor({
  paths, adapter, manifest, nodeVersion = process.version, platform = process.platform,
  codePage = platform === "win32" ? powershellCodePage() : null,
}) {
  if (!(await fileExists(paths.bridgeConfigPath))) {
    throw new Error("This folder is not set up for Review Bridge. Run: " + bridgeRunner() + " init");
  }
  const bridgeConfig = await readJson(paths.bridgeConfigPath);
  const neutralLayout = path.basename(paths.privateRoot) === ".review-bridge";
  const { snapshot } = await loadOrCreatePolicySnapshot(paths);
  const encodingHint = consoleEncodingHint({ platform, codePage });
  // RC3-BLOCKER-01 step 4: a project with an id reads its running runs from the person's database
  // (and stops with the reason when it cannot be opened); one set up before ids reads its files.
  const active = bridgeConfig.project_id
    ? await activeRuns(await (await import("../../service/database/index.mjs")).openDatabase(), bridgeConfig.project_id)
    : (await listRuns(paths, { activeOnly: true }));
  const queue = {};
  for (const [state, directory] of Object.entries({
    pending: paths.pendingDir, running: paths.runningDir, done: paths.doneDir, failed: paths.failedDir,
  })) queue[state] = (await listJson(directory)).length;
  return {
    // The policy was validated when its snapshot was made; an invalid one throws before this.
    valid: true,
    native_readiness: neutralLayout ? {
      ready: false,
      roles: bridgeConfig.roles || null,
      // doctor is a separate process: it cannot attest a proof held in watch memory
      // and never reads the editable audit file or a stored Boolean as proof.
      reviewer_readonly_proven: "not_run",
      reviewer_readonly_authority: "watch_session_only",
      reason: "Native work starts on the person's yes to the card (at a terminal, or through an agent with --yes) after the reviewer read-only check passed in the running Bridge page; doctor cannot see that proof.",
    } : null,
    // The state lives in the service's own folder, not the project (RC3-FIX-02): that is where its locks are.
    state_filesystem: inspectStateFilesystem(paths.stateRoot),
    platform: {
      target: adapter.target,
      adapter: adapter.id,
      commands: manifest.commands,
      node: nodeVersion,
      ...(platform === "win32" ? { powershell_code_page: codePage } : {}),
    },
    authorization: {
      schema_version: 4,
      status: active.length ? "active" : "inactive",
      active_run_count: active.length,
    },
    priority: {
      ...priorityChoice(snapshot.effective_policy),
      effective_policy_sha256: snapshot.effective_policy_sha256,
    },
    queue,
    warnings: [
      ...(encodingHint ? [encodingHint] : []),
      ...(active.length ? [] : ["no active run; create and authorize a work package to begin"]),
    ],
    bounded_resume_ready: active.length === 1 && queue.pending === 0 && queue.running === 0,
  };
}
