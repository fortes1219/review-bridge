import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { assertUnder } from "../../utils/pathGuard.mjs";

export async function ensureDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

export async function readJson(file) {
  return parseJson(await fsp.readFile(file, "utf8"));
}

export function parseJson(source) {
  return JSON.parse(String(source).replace(/^\uFEFF/, ""));
}

export async function writeText(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, value, "utf8");
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
  assertUnder(temp, path.dirname(file), "Atomic JSON temp path");
  // A write or rename that fails leaves the old file and takes its temp file away, as write-file-atomic's finally does.
  try {
    await fsp.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EISDIR", "EPERM"].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeTextDurable(file, value, { exclusive = false } = {}) {
  await ensureDir(path.dirname(file));
  const handle = await fsp.open(file, exclusive ? "wx" : "w");
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

export async function writeJsonExclusiveDurable(file, value) {
  await writeTextDurable(file, JSON.stringify(value, null, 2) + "\n", { exclusive: true });
}

export async function writeJsonAtomicDurable(file, value) {
  await writeTextAtomicDurable(file, JSON.stringify(value, null, 2) + "\n");
}

// The whole file at once: a reader sees the old text or the new, never part of it.
export async function writeTextAtomicDurable(file, text) {
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
  assertUnder(temp, path.dirname(file), "Durable JSON temp path");
  try {
    await writeTextDurable(temp, text, { exclusive: true });
    await fsp.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function appendJsonLineDurable(file, value) {
  await appendTextDurable(file, JSON.stringify(value) + "\n");
}

export async function appendTextDurable(file, text) {
  await ensureDir(path.dirname(file));
  const handle = await fsp.open(file, "a");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

// The last line of a file that only grows at its end, read back from the end: as much of the file
// as that line takes, never the whole history before it. null when the file is missing or empty;
// `torn` when the file does not end with a newline (the line is a part of one).
export async function readLastLine(file) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (!size) return null;
    const chunks = [];
    for (let end = size; ;) {
      const start = Math.max(0, end - 65536);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      chunks.unshift(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const torn = !text.endsWith("\n");
      const body = torn ? text : text.slice(0, -1);
      const cut = body.lastIndexOf("\n");
      if (cut >= 0 || start === 0) return { line: body.slice(cut + 1), torn };
      end = start;
    }
  } finally {
    await handle.close();
  }
}

export async function listJson(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function fileExists(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function acquireLock(lockPath) {
  await ensureDir(path.dirname(lockPath));
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fsp.open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lock = await readJson(lockPath);
        const pid = Number(lock.pid);
        if (!Number.isInteger(pid) || pid < 1) {
          throw new Error("Lock metadata has no valid PID.");
        }
        try {
          process.kill(pid, 0);
        } catch (probeError) {
          if (probeError.code === "ESRCH") stale = true;
          else throw probeError;
        }
      } catch (metadataError) {
        throw new Error(
          "Review bridge lock exists and cannot be verified: "
          + path.basename(lockPath) + " (" + metadataError.message + ")",
        );
      }
      if (!stale || attempt > 0) {
        throw new Error("Review bridge lock is already held: " + path.basename(lockPath));
      }
      await fsp.rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error("Review bridge could not acquire its lock.");
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return async () => {
    await handle.close();
    await fsp.rm(lockPath, { force: true });
  };
}

export function createWriteStream(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.createWriteStream(file, { encoding: "utf8" });
}

// The plain files directly in a directory; a missing directory has none.
export async function listFiles(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
