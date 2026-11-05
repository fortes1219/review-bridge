// Every entry imports this first, so an older Node stops here with one plain line before any other
// module runs.
export const MINIMUM_NODE_MAJOR = 22;

export function nodeTooOld(version = process.versions.node) {
  return Number(String(version).split(".")[0]) < MINIMUM_NODE_MAJOR;
}

if (nodeTooOld()) {
  process.stderr.write("Review Bridge needs Node.js " + MINIMUM_NODE_MAJOR + " or newer (found " + process.versions.node + ").\n");
  process.exit(2);
}
