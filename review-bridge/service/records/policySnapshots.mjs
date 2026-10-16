import fsp from "node:fs/promises";
import path from "node:path";

import {
  ensureDir,
  fileExists,
  readJson,
  writeJsonExclusiveDurable,
} from "./fileStore.mjs";
import { mergePolicy } from "../../policy/policyRules.mjs";
import { digest } from "../../utils/digest.mjs";

export async function loadOrCreatePolicySnapshot(paths) {
  const defaults = await readJson(paths.defaultPolicyPath);
  const override = await fileExists(paths.policyOverridePath)
    ? await readJson(paths.policyOverridePath)
    : { schema_version: 4 };
  const effective = mergePolicy(defaults, override);
  const snapshot = {
    schema_version: 4,
    policy_schema_version: defaults.policy_schema_version,
    package_default_policy_sha256: digest(defaults),
    project_override_sha256: digest(override),
    effective_policy: effective,
  };
  snapshot.effective_policy_sha256 = digest(snapshot);
  const file = path.join(paths.policySnapshotsDir, snapshot.effective_policy_sha256 + ".json");
  await ensureDir(paths.policySnapshotsDir);
  if (!(await fileExists(file))) await writeJsonExclusiveDurable(file, snapshot);
  else if (digest(await readJson(file)) !== digest(snapshot)) throw new Error("Policy snapshot checksum collision.");
  return { snapshot, path: file };
}
