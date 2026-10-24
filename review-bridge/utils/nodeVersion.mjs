// Every entry imports this first, so an older Node stops here with one plain line before any other
// module runs. Switching Node versions (nvm and the like) also drops the review-bridge command;
// running npm start again in the Bridge folder registers it for the new Node.
export const MINIMUM_NODE_MAJOR = 22;

export function nodeTooOld(version = process.versions.node) {
  return Number(String(version).split(".")[0]) < MINIMUM_NODE_MAJOR;
}

if (nodeTooOld()) {
  process.stderr.write("Review Bridge 需要 Node.js " + MINIMUM_NODE_MAJOR + " 以上（現在是 " + process.versions.node + "）。換到 Node "
    + MINIMUM_NODE_MAJOR + " 之後，回 Bridge 資料夾再跑一次 npm start。\n");
  process.exit(2);
}
