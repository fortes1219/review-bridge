import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outputName = "SHA256SUMS.txt";
const excludedDirectories = new Set(["node_modules", ".git", ".tmp"]);

async function collect(directory, relative = "") {
  const files = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Checksum input cannot contain symlinks: " + entry.name);
    const nextRelative = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...await collect(absolute, nextRelative));
    } else if (entry.isFile()
        && entry.name !== outputName
        && !entry.name.endsWith(".zip")
        && !entry.name.endsWith(".sha256")) {
      files.push(nextRelative);
    }
  }
  return files;
}

export async function generateChecksumManifest(packageRoot) {
  const files = (await collect(packageRoot)).sort((left, right) => left.localeCompare(right));
  const lines = [];
  for (const relative of files) {
    const content = await fsp.readFile(path.join(packageRoot, ...relative.split("/")));
    lines.push(createHash("sha256").update(content).digest("hex") + "  " + relative);
  }
  await fsp.writeFile(path.join(packageRoot, outputName), lines.join("\n") + "\n", "utf8");
  return { ok: true, files: files.length, output: outputName };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(JSON.stringify(await generateChecksumManifest(packageRoot)) + "\n");
}
