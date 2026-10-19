import path from "node:path";
import { assertUnder } from "./pathGuard.mjs";

// Bridge state lives only in this provider-neutral folder. There is no default: a caller
// that does not name it is refused, never sent into a provider's own folder.
export const PRIVATE_ROOT_NAME = ".review-bridge";

export function getBridgePaths(repoRoot, bridgeRoot, { privateRootName } = {}) {
  const root = path.resolve(repoRoot);
  const runtimeRoot = path.resolve(bridgeRoot);
  if (!privateRootName) throw new Error("Bridge private root is not given.");
  if (privateRootName !== PRIVATE_ROOT_NAME) throw new Error("Unsupported Bridge private root: " + privateRootName);
  const privateRoot = assertUnder(path.join(root, privateRootName), root, "Private root");
  const queueRoot = assertUnder(path.join(privateRoot, "review-queue"), privateRoot, "Queue root");
  const reviewsRoot = assertUnder(path.join(privateRoot, "reviews"), privateRoot, "Reviews root");
  const configRoot = assertUnder(path.join(privateRoot, "review-bridge"), privateRoot, "Bridge config root");
  return {
    repoRoot: root,
    bridgeRoot: runtimeRoot,
    privateRoot,
    queueRoot,
    reviewsRoot,
    configRoot,
    bridgeConfigPath: path.join(configRoot, "bridge.json"),
    policyOverridePath: path.join(configRoot, "policy.override.json"),
    policySnapshotsDir: path.join(configRoot, "policy-snapshots"),
    defaultPolicyPath: path.join(path.resolve(bridgeRoot), "config", "default-policy.json"),
    pendingDir: path.join(queueRoot, "pending"),
    runningDir: path.join(queueRoot, "running"),
    doneDir: path.join(queueRoot, "done"),
    failedDir: path.join(queueRoot, "failed"),
    evidenceRoot: path.join(queueRoot, "workspace-evidence"),
    workPackagesDir: path.join(queueRoot, "work-packages"),
    contractsDir: path.join(queueRoot, "contracts"),
    authorizationsDir: path.join(queueRoot, "authorizations"),
    authorizationClaimsDir: path.join(queueRoot, "authorization-claims"),
    authorizationInvalidationsDir: path.join(queueRoot, "authorization-invalidations"),
    runsDir: path.join(queueRoot, "runs"),
    eventsDir: path.join(queueRoot, "events"),
    runLocksDir: path.join(queueRoot, "run-locks"),
    reconcileGuardsDir: path.join(queueRoot, "reconcile-guards"),
    upgradeMarkerPath: path.join(queueRoot, "upgrade-in-progress.json"),
    upgradeReportsDir: path.join(queueRoot, "upgrade-reports"),
    archiveDir: path.join(privateRoot, "archive"),
    latestPath: path.join(reviewsRoot, "LATEST.txt"),
    reviewPromptOverridePath: path.join(privateRoot, "review-bridge", "review-prompt.md"),
    reviewPromptPath: path.join(path.resolve(bridgeRoot), "review-prompt.md"),
    workerLockPath: path.join(queueRoot, "worker.node.lock"),
  };
}
