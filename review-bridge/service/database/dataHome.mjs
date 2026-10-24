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
