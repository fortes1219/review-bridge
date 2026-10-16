// A provider or controller failure, written beside the run's evidence under the private root.
import path from "node:path";

import { assertUnder } from "../../utils/pathGuard.mjs";
import { writeJson } from "./fileStore.mjs";

export async function writeFailureRecord(paths, directory, stem, record, evidence = {}) {
  const recordPath = assertUnder(
    path.join(directory, stem + "-failure.json"),
    paths.privateRoot,
    "Failure record",
  );
  const full = { ...record, evidence: { ...evidence } };
  for (const [key, value] of Object.entries(full.evidence)) {
    if (value) assertUnder(value, paths.privateRoot, "Failure evidence " + key);
  }
  await writeJson(recordPath, full);
  return { record: full, record_path: recordPath };
}
