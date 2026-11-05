// A provider or controller failure, written beside the run's evidence: in the run's log folder, or
// the service's state for a review job.
import path from "node:path";

import { isUnder } from "../../utils/pathGuard.mjs";
import { writeJson } from "./fileStore.mjs";

function assertBridgeFile(paths, file, label) {
  if (!isUnder(file, paths.logRoot) && !isUnder(file, paths.stateRoot)) throw new Error(label + " escaped its allowed root.");
  return path.resolve(file);
}

export async function writeFailureRecord(paths, directory, stem, record, evidence = {}) {
  const recordPath = assertBridgeFile(paths, path.join(directory, stem + "-failure.json"), "Failure record");
  const full = { ...record, evidence: { ...evidence } };
  for (const [key, value] of Object.entries(full.evidence)) {
    if (value) assertBridgeFile(paths, value, "Failure evidence " + key);
  }
  await writeJson(recordPath, full);
  return { record: full, record_path: recordPath };
}
