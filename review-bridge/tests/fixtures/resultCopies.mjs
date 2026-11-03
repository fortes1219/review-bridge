import fsp from "node:fs/promises";
import path from "node:path";

// "<source_id> <work order file> <local date> <hh-mm-ss> <conclusion>.md", the source_id only when
// the work order has one: CANARY-1 queue-summary 2026-11-03 23-48-12 success.md.
export function copyName(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^(?:(.+) )?" + escaped + " (\\d{4}-\\d{2}-\\d{2}) (\\d{2}-\\d{2}-\\d{2}) ([a-z_]+)\\.md$");
}

// The person's copies of one work order's results in <root>/.review-bridge/results/, oldest first.
export async function resultCopies(root, name) {
  const dir = path.join(root, ".review-bridge", "results");
  const pattern = copyName(name);
  const names = (await fsp.readdir(dir).catch(() => [])).filter((entry) => pattern.test(entry)).sort();
  return names.map((entry) => path.join(dir, entry));
}

// The newest copy's text, or "" when there is none.
export async function latestResultCopy(root, name) {
  const copies = await resultCopies(root, name);
  return copies.length ? await fsp.readFile(copies.at(-1), "utf8") : "";
}

// The text after the identity frontmatter: the result as it reads from its title on.
export function afterIdentity(text) {
  return String(text).replace(/^---\n[\s\S]*?\n---\n\n/, "");
}

// Waits into the next whole second, so the next run closes in a second of its own.
export async function nextSecond() {
  await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 5));
}
