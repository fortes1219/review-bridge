import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function resolvePath(value) {
  return path.resolve(value);
}

export function isUnder(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertUnder(candidate, root, label = "Path") {
  if (!isUnder(candidate, root)) {
    throw new Error(label + " escaped its allowed root.");
  }
  return path.resolve(candidate);
}

export function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

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
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(temp, file);
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
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
  assertUnder(temp, path.dirname(file), "Durable JSON temp path");
  try {
    await writeTextDurable(temp, JSON.stringify(value, null, 2) + "\n", { exclusive: true });
    await fsp.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function appendJsonLineDurable(file, value) {
  await ensureDir(path.dirname(file));
  const handle = await fsp.open(file, "a");
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
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

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");
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
