// The records' command entries. `deliver(runId)` is the work order's delivery, passed in by the
// router: a run is given its result before it is folded or removed.
import { fileExists, readJson, RetentionConfigError } from "../../service/index.mjs";
import { formatPruneSummary, prune, removeRun } from "./retention.mjs";

// T0-02 R3: one entry point for every prune trigger (CLI, watch start, daily timer).
export async function runPrune(paths, { json = false, out = process.stdout, deliver }) {
  const config = (await fileExists(paths.bridgeConfigPath)) ? await readJson(paths.bridgeConfigPath).catch(() => ({})) : {};
  let ttlSeconds = 86_400;
  for (const file of [paths.defaultPolicyPath, paths.policyOverridePath]) {
    const policy = (await fileExists(file)) ? await readJson(file).catch(() => null) : null;
    if (Number.isInteger(policy?.limits?.authorization_ttl_seconds)) ttlSeconds = policy.limits.authorization_ttl_seconds;
  }
  try {
    // T0-07: every prune (command, watch start, daily timer) delivers pending results first; prune
    // itself refuses to fold a run that has none.
    const summary = await prune(paths, { config, ttlSeconds, deliver });
    out.write(json ? JSON.stringify(summary, null, 2) + "\n" : formatPruneSummary(summary) + "\n");
    return summary.merge_errors.length ? 1 : 0;
  } catch (error) {
    if (error instanceof RetentionConfigError) {
      out.write("沒有清：" + error.message + "\n");
      return 1;
    }
    throw error;
  }
}

// `forget(runId)` removes the run from the person's database once its files are gone (passed in by
// the router; a project without records passes nothing).
export async function removeRecord(paths, runId, { deliver, forget = null }) {
  if (!runId) throw new Error("rm requires a run id.");
  // rm folds the run into the archive; a run without a result gets one first. If that fails the
  // human's removal still happens, but the day file marks it and the output says why.
  let deliveryError = null;
  await deliver(runId)
    .then((delivery) => { if (delivery?.skipped) deliveryError = delivery.reason; })
    .catch((error) => { deliveryError = String(error?.message || error); });
  const result = await removeRun(paths, runId);
  if (result.exitCode === 0 && forget) await forget(runId);
  process.stdout.write(result.line + "\n");
  if (result.undelivered) {
    process.stdout.write("結果沒交付成功：" + (deliveryError || "原因不明") + "，已標記未交付後移除\n");
  }
  return result.exitCode;
}
