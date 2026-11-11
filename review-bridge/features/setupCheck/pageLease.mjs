// The page service's lease and its holder record, as supabase/cli's stack owner holds its lease and
// publishes owner.json (c75aea2, packages/stack/ARCHITECTURE.md:487,495; src/namespace/Lease.ts,
// Publication.ts; src/internal/sharing-violation.ts). Supabase keeps its lease on a file because that layer
// has no database; Bridge's page service starts after the person's database (setupCheck/commands.mjs
// upService), so its lease is a session-level PostgreSQL advisory lock on a connection of its own, as
// supabase/cli locks inside its database (db-setup.ts:636-664). The server releases it when that session
// ends, however the page service ended; whether the page service runs is never read from a pid.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RECORD_FILE = "page-owner.json";
const RECORD_SCHEMA = 1;
// The lock's first key names Bridge's page service; the second is the project, so projects never block each other.
const LOCK_SPACE = "review-bridge.page-service";

const databaseModule = () => import("../../service/database/index.mjs");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Where the record is: beside the project's other page-service state.
export function leaseFiles(paths) {
  const directory = path.dirname(paths.watchSessionPath);
  return { directory, record: path.join(directory, RECORD_FILE) };
}

// Windows reports a file another process holds or replaces as a transient sharing violation: retried
// with backoff from 10 ms, doubling, at most 100 ms, at most 12 times (sharing-violation.ts:15-34).
async function retrySharingViolation(operation) {
  let delay = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 12) throw error;
      await pause(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
}

export class LeaseHeldError extends Error {
  constructor() {
    super("Another Bridge page service holds this project's lease.");
    this.code = "lease_held";
  }
}

// Takes the project's lease for this process's life, or refuses at once when another session holds it.
// The connection is the lease: if it ends while the page service runs (the database stopped, the session
// terminated), the lease is lost and `onLost` is called once (ARCHITECTURE.md:495, lost ownership).
export async function acquireLease(paths, projectId) {
  const { takeAdvisoryLock } = await databaseModule();
  const connection = await takeAdvisoryLock(LOCK_SPACE, projectId);
  if (!connection) throw new LeaseHeldError();
  const files = leaseFiles(paths);
  let releasing = false;
  let lost = null;
  const lostHandlers = [];
  const onEnded = (error) => {
    if (releasing || lost) return;
    lost = error || new Error("The page service's database session ended.");
    for (const handler of lostHandlers) handler(lost);
  };
  connection.on("error", onEnded);
  connection.on("end", () => onEnded(null));
  // Whether this session still holds the lock, from pg_locks; a session that cannot answer holds nothing.
  const holdsLock = async () => {
    try {
      const { rows } = await connection.query(
        "select exists (select 1 from pg_locks where locktype = 'advisory' and granted and objsubid = 2 and pid = pg_backend_pid()"
        + " and classid = hashtext($1)::oid and objid = hashtext($2)::oid) as held", [LOCK_SPACE, projectId]);
      return rows[0].held === true;
    } catch {
      return false;
    }
  };
  return {
    files,
    onLost(handler) {
      lostHandlers.push(handler);
      if (lost) handler(lost);
    },
    // The lease already guarantees one writer, so a rename over any record left before is enough
    // (Lease.ts:215-227).
    async publishRecord(record) {
      await publish(files.record, JSON.stringify({ schema_version: RECORD_SCHEMA, ...record }, null, 2) + "\n");
    },
    // Withdrawn only while this session still holds the lock, when no successor can have published
    // (Lease.ts:228-237). Once the lease is lost the record is not touched at all: a successor may already
    // have renamed its own over it, and a record left behind means nothing without its lease and is
    // replaced by the next page service's publish (ARCHITECTURE.md:495; Lease.ts:55,219-221).
    async retractRecord() {
      if (lost || !(await holdsLock())) return;
      await retrySharingViolation(() => fs.promises.rm(files.record, { force: true }));
    },
    async release() {
      releasing = true;
      await connection.end().catch(() => {});
    },
  };
}

// A reader of whether a project's lease is held, from pg_locks, never by taking it. Null when the
// database is not running: the page service starts after it, so then there is none.
export async function openLeaseReader() {
  const { openAdvisoryLockReader } = await databaseModule();
  const reader = await openAdvisoryLockReader();
  if (!reader) return null;
  return { held: (projectId) => reader.held(LOCK_SPACE, projectId), close: reader.close };
}

// A reader only ever sees the prior document or the complete new one: staged in the target's own
// folder, fsynced, renamed over it, then the folder fsynced; a failed write leaves no staging file
// (Publication.ts:16-47). Private to the person (0600).
async function publish(target, content) {
  const directory = path.dirname(target);
  await fs.promises.mkdir(directory, { recursive: true });
  const staging = path.join(directory, "." + path.basename(target) + "." + process.pid + "-" + randomUUID() + ".tmp");
  try {
    const handle = await fs.promises.open(staging, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retrySharingViolation(() => fs.promises.rename(staging, target));
    // Windows cannot open or fsync a folder (FileSystem.ts:267-274).
    if (process.platform !== "win32") {
      const folder = await fs.promises.open(directory, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    }
  } finally {
    await retrySharingViolation(() => fs.promises.rm(staging, { force: true })).catch(() => {});
  }
}

// The holder's record; only meaningful while the lease is held. A missing record is not an error:
// its holder may retract it at any moment (Lease.ts:55,257-276).
export async function readRecord(paths) {
  const { record } = leaseFiles(paths);
  let text;
  try {
    text = await retrySharingViolation(() => fs.promises.readFile(record, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text);
  if (!validRecord(value)) throw new Error("Unable to read the page service's record " + record + ".");
  return value;
}

const port = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
function validRecord(value) {
  return Boolean(value) && value.schema_version === RECORD_SCHEMA
    && Number.isInteger(value.pid) && value.pid > 0 && port(value.port) && port(value.page_port)
    && typeof value.url === "string" && typeof value.release === "string" && typeof value.secret === "string"
    && typeof value.project_id === "string" && ["session", "detached"].includes(value.lifetime) && typeof value.started_at === "string";
}
