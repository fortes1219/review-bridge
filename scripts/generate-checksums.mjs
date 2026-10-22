import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkReleasePath, LIST_NAME, parseReleaseList, readReleaseFile, sha256 } from "./release-list.mjs";

// Refreshes the release list (SHA256SUMS.txt): every listed file is hashed again. A file enters only
// when named with --add and leaves only with --remove; nothing is picked up by walking the folder,
// so a file is never released just because it is on disk or tracked by Git. A private path is
// refused (release-list.mjs).
export async function generateChecksumManifest(packageRoot, { add = [], remove = [] } = {}) {
  const listFile = path.join(packageRoot, LIST_NAME);
  const listed = parseReleaseList(await fsp.readFile(listFile, "utf8")).map((entry) => entry.path);
  const removing = new Set(remove.map(checkReleasePath));
  for (const relative of removing) {
    if (!listed.includes(relative)) throw new Error("Not in the release list, so it cannot be removed: " + relative);
  }
  const paths = [...listed.filter((relative) => !removing.has(relative)), ...add.map(checkReleasePath)];
  const seen = new Set();
  for (const relative of paths) {
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error("Already in the release list: " + relative);
    seen.add(key);
  }
  paths.sort((left, right) => left.localeCompare(right));
  const lines = [];
  for (const relative of paths) lines.push(sha256(await readReleaseFile(packageRoot, relative)) + "  " + relative);
  const temporary = listFile + ".tmp-" + process.pid;
  await fsp.writeFile(temporary, lines.join("\n") + "\n", "utf8");
  await fsp.rename(temporary, listFile);
  return { ok: true, files: paths.length, added: add, removed: [...removing], output: LIST_NAME };
}

function parseArguments(argv) {
  const options = { add: [], remove: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--add" || flag === "--remove") && value && !value.startsWith("--")) {
      options[flag.slice(2)].push(value.replaceAll("\\", "/"));
      index += 1;
    } else {
      throw new Error("Usage: generate-checksums [--add <path>]... [--remove <path>]...");
    }
  }
  return options;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    process.stdout.write(JSON.stringify(await generateChecksumManifest(packageRoot, parseArguments(process.argv.slice(2)))) + "\n");
  } catch (error) {
    process.stderr.write("Checksum list not changed: " + error.message + "\n");
    process.exitCode = 2;
  }
}
