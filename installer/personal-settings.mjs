// The person's default writer and reviewer, chosen in the install Guide and kept in their settings
// file (review-bridge/service/database/personalSettings.mjs reads the file and the database's start
// port). A project's own roles stay in its bridge.json; setting up a project starts from these
// defaults and shows them as the preselected answers.
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { validateRoles } from "./role-readiness.mjs";
import {
  readSettings, settingsFile, SETTINGS_SCHEMA_VERSION, unreadableSettings,
} from "../review-bridge/service/database/personalSettings.mjs";

export { settingsFile };

// The saved roles, or null when there is no file.
export async function readDefaultRoles({ dataHome } = {}) {
  const file = settingsFile(dataHome);
  const settings = await readSettings(file);
  if (!settings) return null;
  try {
    const { writer, reviewer } = validateRoles(settings.default_roles || {});
    return { writer, reviewer };
  } catch (error) {
    throw unreadableSettings(file, error);
  }
}

// Written whole through a temporary file and a rename, so a reader never sees half a file. The rest
// of the file (the database port) is kept.
export async function saveDefaultRoles(roles, { dataHome } = {}) {
  const file = settingsFile(dataHome);
  const { writer, reviewer } = validateRoles(roles);
  const kept = (await readSettings(file)) || {};
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = file + "." + process.pid + "-" + randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(partial, JSON.stringify({ ...kept, schema_version: SETTINGS_SCHEMA_VERSION, default_roles: { writer, reviewer } }, null, 2) + "\n", "utf8");
  await fsp.rename(partial, file);
  return file;
}
