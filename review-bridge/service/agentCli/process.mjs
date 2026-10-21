import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

export async function runProcess({
  invocation,
  cwd,
  input = "",
  stdoutPath,
  stderrPath,
  timeoutMs = 0,
  onSpawn = null,
}) {
  await fsp.mkdir(path.dirname(stdoutPath), { recursive: true });
  await fsp.mkdir(path.dirname(stderrPath), { recursive: true });
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: invocation.env || process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // T0-06 G3.2: a sealed Gate A command string runs through the platform shell as one line.
    shell: invocation.shell === true,
    // A shell run gets its own process group on POSIX so a timeout can reach its descendants.
    detached: invocation.shell === true && process.platform !== "win32",
  });
  let timer;
  let forceTimer;
  let timedOut = false;
  let treeKill = null;
  // Listen before anything is awaited: a child that ends while onSpawn writes its record would
  // otherwise close unheard, and with every timer unref'd the process would exit mid-await.
  const closed = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      stdout.end();
      stderr.end();
      reject(error);
    });
    child.once("close", (code, signal) => resolve({
      exitCode: code === null ? 2 : code,
      signal,
      timedOut,
      pid: child.pid,
    }));
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdin.end(input);
  // T0-04 D5.1: the caller records the pid so `stop` can reach the process tree. If that fails,
  // nothing outside can reach the process, so it is killed and waited for before the error goes up.
  if (onSpawn && Number.isInteger(child.pid)) {
    try {
      await onSpawn(child.pid);
    } catch (error) {
      await killProcessTree(child.pid, { group: invocation.shell === true }).catch(() => null);
      try { child.kill("SIGKILL"); } catch {}
      await closed.catch(() => null);
      await Promise.allSettled([finished(stdout), finished(stderr)]);
      throw error;
    }
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      // Codex finding 2026-10-13: the tree is terminated while the shell is still alive, and the
      // result is awaited below so runProcess returns only once the kill has finished.
      treeKill = killProcessTree(child.pid, { group: invocation.shell === true })
        .catch((error) => ({ killed: false, reason: "kill_error:" + String(error?.message || error) }))
        .finally(() => { try { child.kill("SIGKILL"); } catch {} });
      forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 6_000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
  }

  let result;
  try {
    result = await closed;
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    await Promise.allSettled([finished(stdout), finished(stderr)]);
  }
  if (treeKill) result.tree_kill = await treeKill;
  return result;
}

// The scheduler state of a POSIX process: Linux reads /proc/<pid>/stat (the field after the command
// name's closing parenthesis), macOS asks ps. Null when it cannot be read.
function processState(pid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const listed = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return listed.error || listed.status !== 0 ? null : listed.stdout.trim() || null;
  }
  return null;
}

// Running means present and not a zombie. A process that ended but was not yet reaped by its parent
// still answers signal 0 on POSIX; it does no work, so it is not running. A state that cannot be read
// counts as running: waiting longer is safe, taking a live process for gone is not.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  return !String(processState(pid) || "").startsWith("Z");
}

// On POSIX a process group is alive while any member is; signal 0 to -pgid answers that.
function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Every descendant of `pid` in a `ps -A -o pid= -o ppid=` listing, children before grandchildren.
export function descendantsOf(pid, rows) {
  const children = new Map();
  for (const [child, parent] of rows) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  const queue = [...(children.get(pid) || [])];
  while (queue.length) {
    const next = queue.shift();
    if (found.includes(next) || next === pid) continue;
    found.push(next);
    queue.push(...(children.get(next) || []));
  }
  return found;
}

// Signals never go to the system's first process, this process, or an ancestor of it, and a tree
// that contains any of them is refused whole. When the ancestry or the process list cannot be read,
// the kill is refused: not knowing is not permission. This protects Bridge and what started it; it
// cannot protect every other process of the same account from a wrong or forged pid record.
const REFUSED = (reason) => Object.freeze({ killed: false, reason, scope: "none" });

// The parent of a POSIX process: Linux reads /proc/<pid>/stat (the second field after the command
// name's closing parenthesis), other systems ask ps. Null when it cannot be read.
export function readParentPid(pid, { platform = process.platform, ps = "ps" } = {}) {
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return Number.isInteger(parent) && parent >= 0 ? parent : null;
    } catch {
      return null;
    }
  }
  const listed = spawnSync(ps, ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) return null;
  const parent = Number(listed.stdout.trim());
  return listed.stdout.trim() !== "" && Number.isInteger(parent) && parent >= 0 ? parent : null;
}

// The ancestors of `pid` up to the system's first process. Null when any link cannot be read or the
// chain is deeper than `limit`: the caller must refuse, never assume.
export function posixAncestors(pid, { readParent = readParentPid, limit = 64 } = {}) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < limit; depth += 1) {
    const parent = readParent(current);
    if (parent === null) return null;
    if (parent <= 1) {
      if (parent === 1) chain.push(1);
      return chain;
    }
    chain.push(parent);
    current = parent;
  }
  return null;
}

// Step 1: the pid itself, before anything is listed or read. Windows has no ancestry walk here (its
// tree kill is taskkill /T): the system's own processes (pid 4 and below), this process and its parent.
export function protectedPidVerdict(pid, { platform = process.platform, self = process.pid, parent = process.ppid } = {}) {
  const firstUserPid = platform === "win32" ? 5 : 2;
  return pid < firstUserPid || pid === self || pid === parent ? "refused_pid" : null;
}

// Step 2: this process and its ancestry; null means the ancestry could not be read, which refuses.
export function protectedSetOrNull({ self = process.pid, ancestors = posixAncestors } = {}) {
  const chain = ancestors(self);
  return chain === null ? null : new Set([1, self, ...chain]);
}

// Step 3: a subtree that contains a protected process is refused whole, never filtered.
export function treeVerdict(descendants, protectedSet) {
  return descendants.some((child) => protectedSet.has(child)) ? "refused_tree" : null;
}

function posixProcessRows(ps = "ps") {
  const listed = spawnSync(ps, ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) return null;
  return listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([child, parent]) => Number.isInteger(child) && Number.isInteger(parent));
}

// T0-04 D5.2: terminate a recorded process and everything it spawned. On win32 taskkill /T
// walks the tree (verified 2026-10-13, and 2026-10-17 with Claude and Codex sub-agents running
// commands). On POSIX a shell run leads its own process group (`group: true`) and the group is
// signalled; a CLI started directly keeps the caller's group, so its descendants are listed with
// `ps` and signalled before it. RC3-LINUX-00: before any signal, in this order, the pid itself is
// checked against the protected ones, then this process's ancestry is read, and only then is the
// subtree listed and checked; any refusal sends no signal at all. `signal`, `ancestors` and
// `processRows` are seams for tests.
export async function killProcessTree(pid, {
  platform = process.platform, waitMs = 5_000, group = false, taskkill = "taskkill.exe", ps = "ps",
  self = process.pid, parent = process.ppid, ancestors = posixAncestors, processRows = posixProcessRows,
  signal = (target, name) => process.kill(target, name),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, reason: "invalid_pid" };
  const pidVerdict = protectedPidVerdict(pid, { platform, self, parent });
  if (pidVerdict) return REFUSED(pidVerdict);
  const posixGroup = platform !== "win32" && group;
  const posixTree = platform !== "win32" && !group;
  let rows = null;
  let descendants = [];
  if (platform !== "win32") {
    const protectedSet = protectedSetOrNull({ self, ancestors });
    if (!protectedSet) return REFUSED("ancestry_unknown");
    if (protectedSet.has(pid)) return REFUSED("refused_pid");
    if (posixTree) {
      // A list that cannot be read says nothing about the subtree: orphaned children may still run,
      // so neither "stopped" nor any signal is given.
      rows = processRows(ps);
      if (rows === null) return REFUSED("ps_unavailable");
      descendants = descendantsOf(pid, rows);
      const treeRefusal = treeVerdict(descendants, protectedSet);
      if (treeRefusal) return REFUSED(treeRefusal);
    }
  }
  const alive = () => (posixGroup
    ? isGroupAlive(pid) || isPidAlive(pid)
    : isPidAlive(pid) || descendants.some((child) => isPidAlive(child)));
  if (!alive()) return { killed: false, reason: "not_running" };
  if (platform === "win32") {
    // Codex finding 2026-10-13: a failed taskkill must not be reported as a cleared tree.
    const walked = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    if (walked.error || walked.status !== 0) {
      try { signal(pid, "SIGKILL"); } catch {}
      const hardDeadline = Date.now() + 2_000;
      while (isPidAlive(pid) && Date.now() < hardDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        killed: false,
        reason: "taskkill_failed:" + (walked.error ? walked.error.code || "error" : String(walked.status)),
        scope: "pid",
        parent_alive: isPidAlive(pid),
        detail: String(walked.stderr || walked.error?.message || "").trim().slice(0, 200),
      };
    }
  } else if (posixGroup) {
    try { signal(-pid, "SIGTERM"); } catch { try { signal(pid, "SIGTERM"); } catch {} }
  } else {
    for (const child of [...descendants].reverse()) { try { signal(child, "SIGTERM"); } catch {} }
    try { signal(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + waitMs;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive()) {
    if (platform !== "win32") {
      if (posixGroup) { try { signal(-pid, "SIGKILL"); } catch {} }
      for (const child of [...descendants].reverse()) { try { signal(child, "SIGKILL"); } catch {} }
      try { signal(pid, "SIGKILL"); } catch {}
    }
    const hardDeadline = Date.now() + 2_000;
    while (alive() && Date.now() < hardDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const scope = platform === "win32" ? "tree" : posixGroup ? "group" : rows ? "tree" : "pid";
  return { killed: !alive(), reason: alive() ? "still_running" : "killed", scope };
}
