// The person's own Bridge settings file, in the data home beside their database. The runtime reads
// the database's start port from it; the install Guide (installer/personal-settings.mjs) reads and
// writes the default roles in the same file.
import fsp from "node:fs/promises";
import path from "node:path";

import { bridgeDataHome } from "./dataHome.mjs";

export const SETTINGS_SCHEMA_VERSION = 1;

export function settingsFile(dataHome = bridgeDataHome()) {
  return path.join(dataHome, "settings.json");
}

export const unreadableSettings = (file, error) => new Error("Your Review Bridge settings are not readable (" + file + "): " + error.message + ". Fix or delete the file.");

// The whole file, or null when there is none. A file that is there but unreadable is refused, never
// taken as "nothing saved".
export async function readSettings(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const settings = JSON.parse(text);
    if (settings?.schema_version !== SETTINGS_SCHEMA_VERSION) throw new Error("schema_version is not " + SETTINGS_SCHEMA_VERSION);
    return settings;
  } catch (error) {
    throw unreadableSettings(file, error);
  }
}

// The port the person's database starts looking from (`database.port`), or null when the file or the
// field is not there. A value that is not a port is refused, never replaced by the default.
export async function readDatabasePort({ dataHome } = {}) {
  const file = settingsFile(dataHome);
  const port = (await readSettings(file))?.database?.port;
  if (port === undefined) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw unreadableSettings(file, new Error("database.port is not a port number"));
  return port;
}
