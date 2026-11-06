// Every entry imports this first, so an older Node stops here with one plain line before any other
// module runs.
// 22.8: from there util.styleText honours isTTY, NO_COLOR, NODE_DISABLE_COLORS and FORCE_COLOR.
export const MINIMUM_NODE = "22.8";

export function nodeTooOld(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  const [wantMajor, wantMinor] = MINIMUM_NODE.split(".").map(Number);
  return major < wantMajor || (major === wantMajor && minor < wantMinor);
}

if (nodeTooOld()) {
  process.stderr.write("Review Bridge needs Node.js " + MINIMUM_NODE + " or newer (found " + process.versions.node + ").\n");
  process.exit(2);
}
