// Where Bridge keeps long-term data for this OS user: outside every project, worktree, npm cache
// and installed runtime. REVIEW_BRIDGE_DATA_HOME overrides it (tests, or a person who wants it
// elsewhere). Kept apart from the server module, which imports pg: the install Guide shows and
// writes this place before the dependencies exist.
import os from "node:os";
import path from "node:path";

export function bridgeDataHome({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.REVIEW_BRIDGE_DATA_HOME) return path.resolve(env.REVIEW_BRIDGE_DATA_HOME);
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ReviewBridge");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ReviewBridge");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "review-bridge");
}

// Where Bridge writes each run's call logs: the platform's log folder, as env-paths names it
// (Windows %LOCALAPPDATA%\<name>\Log, macOS ~/Library/Logs/<name>, Linux $XDG_STATE_HOME/<name>),
// never the project. With REVIEW_BRIDGE_DATA_HOME everything Bridge keeps is under that one folder.
export function bridgeLogHome({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.REVIEW_BRIDGE_DATA_HOME) return path.join(path.resolve(env.REVIEW_BRIDGE_DATA_HOME), "logs");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ReviewBridge", "Log");
  if (platform === "darwin") return path.join(home, "Library", "Logs", "ReviewBridge");
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "review-bridge");
}

// The person's one PostgreSQL server, shared by all their projects.
export function databaseRoot(dataHome = bridgeDataHome()) {
  return path.join(dataHome, "postgres");
}
