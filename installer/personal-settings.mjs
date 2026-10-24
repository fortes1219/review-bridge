// The person's own Bridge settings, in the data home beside their database: the default writer and
// reviewer chosen in the install Guide, and the version last installed at each Bridge folder (how
// the Guide tells an upgrade from a first install). A project's own roles stay in its bridge.json;
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

// The whole file, or null when there is none. A file that is there but unreadable is refused,
// never taken as "nothing saved".
async function readSettings(dataHome) {
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
    validateRoles(settings.default_roles || {});
    const versions = settings.installed_versions ?? {};
    if (typeof versions !== "object" || Array.isArray(versions) || Object.values(versions).some((value) => typeof value !== "string")) {
      throw new Error("installed_versions is not a map of folder to version");
    }
    return { default_roles: settings.default_roles, installed_versions: versions };
  } catch (error) {
    throw new Error("Your Review Bridge settings are not readable (" + file + "): " + error.message + ". Run the install Guide again or fix the file.");
  }
}

export async function readDefaultRoles({ dataHome } = {}) {
  const settings = await readSettings(dataHome);
  return settings ? { writer: settings.default_roles.writer, reviewer: settings.default_roles.reviewer } : null;
}

// The version last installed at this Bridge folder, or null on a first install there.
export async function installedVersion(location, { dataHome } = {}) {
  return (await readSettings(dataHome))?.installed_versions[location] ?? null;
}

// Written whole through a temporary file and a rename, so a reader never sees half a file.
export async function saveInstall({ roles, location, version }, { dataHome } = {}) {
  const file = settingsFile(dataHome);
  const { writer, reviewer } = validateRoles(roles);
  const current = await readSettings(dataHome);
  const settings = {
    schema_version: SCHEMA_VERSION,
    default_roles: { writer, reviewer },
    installed_versions: { ...(current?.installed_versions || {}), [location]: version },
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = file + "." + process.pid + "-" + randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(partial, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await fsp.rename(partial, file);
  return file;
}
