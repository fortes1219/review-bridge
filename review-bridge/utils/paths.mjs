import fs from "node:fs";
import path from "node:path";
import { bridgeDataHome, bridgeLogHome } from "../service/database/dataHome.mjs";
import { assertUnder } from "./pathGuard.mjs";

// Bridge's place in a project is only this provider-neutral folder. There is no default: a caller
// that does not name it is refused, never sent into a provider's own folder.
export const PRIVATE_ROOT_NAME = ".review-bridge";

// The project holds what the person writes and reads: its settings, its work orders and the result
// copies. Everything the service keeps while it works lives outside the project, as a backend service
// keeps its state and logs off the customer's folder (Owner 2026-11-04): the state under the data
// home's projects/<project_id>/ (env-paths `data`), each run's call logs under the platform's log
// folder at <project_id>/<run_id>/ (env-paths `log`). Those two are found through the project's id
// in bridge.json, read on first use.
const STATE = Object.freeze({
  stateRoot: "",
  reviewsRoot: "reviews",
  policySnapshotsDir: "policy-snapshots",
  probeAuditDir: "reviewer-probe-audit",
  pendingDir: "pending",
  runningDir: "running",
  doneDir: "done",
  failedDir: "failed",
  evidenceRoot: "workspace-evidence",
  workPackagesDir: "work-packages",
  contractsDir: "contracts",
  authorizationsDir: "authorizations",
  authorizationClaimsDir: "authorization-claims",
  authorizationInvalidationsDir: "authorization-invalidations",
  runsDir: "runs",
  eventsDir: "events",
  unrecordedDir: "unrecorded",
  runLocksDir: "run-locks",
  reconcileGuardsDir: "reconcile-guards",
  upgradeReportsDir: "upgrade-reports",
  archiveDir: "archive",
  latestPath: "reviews/LATEST.txt",
  workerLockPath: "worker.node.lock",
  installManifestPath: "review-bridge-install.json",
  watchSessionPath: "watch-session.json",
  watchUrlPath: "watch-url.txt",
});

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9-]{8,80}$/;

// The project's id in the person's database, which also names its state and log folders.
export function readProjectId(bridgeConfigPath) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(bridgeConfigPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("This folder is not set up for Review Bridge. Run: review-bridge init");
    throw new Error("bridge.json cannot be read (" + error.message + ").");
  }
  if (!config?.project_id) throw new Error("This project was set up before Bridge kept its records in a database. Run: review-bridge upgrade");
  if (!PROJECT_ID.test(String(config.project_id))) throw new Error("bridge.json has a project_id that is not an id: " + config.project_id);
  return String(config.project_id).toLowerCase();
}

// The directory of work-packages/<directory>/<file>.md that holds a work order, or null for one
// elsewhere: a directory is a line of work orders, and its results mirror it.
export function workOrderDirectory(taskFile) {
  const parts = String(taskFile).split("/");
  return parts.length === 4 && parts[0] === PRIVATE_ROOT_NAME && parts[1] === "work-packages" ? parts[2] : null;
}

export function projectStateRoot(projectId, { env = process.env } = {}) {
  return path.join(bridgeDataHome({ env }), "projects", projectId);
}

export function projectLogRoot(projectId, { env = process.env } = {}) {
  return path.join(bridgeLogHome({ env }), projectId);
}

export function getBridgePaths(repoRoot, bridgeRoot, { privateRootName, env = process.env } = {}) {
  const root = path.resolve(repoRoot);
  const runtimeRoot = path.resolve(bridgeRoot);
  if (!privateRootName) throw new Error("Bridge private root is not given.");
  if (privateRootName !== PRIVATE_ROOT_NAME) throw new Error("Unsupported Bridge private root: " + privateRootName);
  const privateRoot = assertUnder(path.join(root, privateRootName), root, "Private root");
  const bridgeConfigPath = path.join(privateRoot, "bridge.json");
  const paths = {
    repoRoot: root,
    bridgeRoot: runtimeRoot,
    privateRoot,
    bridgeConfigPath,
    policyOverridePath: path.join(privateRoot, "policy.override.json"),
    rulesPath: path.join(privateRoot, "rules.md"),
    reviewPromptOverridePath: path.join(privateRoot, "review-prompt.md"),
    defaultPolicyPath: path.join(runtimeRoot, "config", "default-policy.json"),
    reviewPromptPath: path.join(runtimeRoot, "review-prompt.md"),
    // The person's copies of run results, one folder per work order (DECISIONS 2026-11-03, 2026-11-04).
    resultsDir: path.join(privateRoot, "results"),
    // Present only while an upgrade or uninstall changes the files beside it, like the install lock.
    upgradeMarkerPath: path.join(privateRoot, "upgrade-in-progress.json"),
    runLogDir(runId) {
      if (!RUN_ID.test(String(runId || ""))) throw new Error("Run id is invalid: " + runId);
      return path.join(this.logRoot, runId);
    },
  };
  let projectId = null;
  const id = () => (projectId ??= readProjectId(bridgeConfigPath));
  Object.defineProperty(paths, "projectId", { enumerable: true, get: id });
  Object.defineProperty(paths, "logRoot", { enumerable: true, get: () => projectLogRoot(id(), { env }) });
  for (const [key, relative] of Object.entries(STATE)) {
    Object.defineProperty(paths, key, { enumerable: true, get: () => path.join(projectStateRoot(id(), { env }), relative) });
  }
  return paths;
}
