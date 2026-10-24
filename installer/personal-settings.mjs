// The person's own Bridge settings, in the data home beside their database: today only the default
// writer and reviewer chosen in the install Guide. A project's own roles stay in its bridge.json;
// setting up a project starts from these defaults and says how to change them.
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { validateRoles } from "./role-readiness.mjs";
import { bridgeDataHome } from "../review-bridge/service/database/dataHome.mjs";

const SCHEMA_VERSION = 1;

export function settingsFile(dataHome = bridgeDataHome()) {
  return path.join(dataHome, "settings.json");
}

// The saved default roles, or null when none were saved. A file that is there but unreadable is
// refused, never taken as "no defaults".
export async function readDefaultRoles({ dataHome } = {}) {
  const file = settingsFile(dataHome);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const settings = JSON.parse(text);
    if (settings.schema_version !== SCHEMA_VERSION) throw new Error("schema_version is not " + SCHEMA_VERSION);
    return validateRoles(settings.default_roles || {});
  } catch (error) {
    throw new Error("Your Review Bridge settings are not readable (" + file + "): " + error.message + ". Run the install Guide again or fix the file.");
  }
}

// Written whole through a temporary file and a rename, so a reader never sees half a file.
export async function saveDefaultRoles(roles, { dataHome } = {}) {
  const file = settingsFile(dataHome);
  const { writer, reviewer } = validateRoles(roles);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = file + "." + process.pid + "-" + randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(partial, JSON.stringify({ schema_version: SCHEMA_VERSION, default_roles: { writer, reviewer } }, null, 2) + "\n", "utf8");
  await fsp.rename(partial, file);
  return file;
}
