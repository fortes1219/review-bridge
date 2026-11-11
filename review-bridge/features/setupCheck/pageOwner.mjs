// The page service itself, as Supabase CLI's stack owner runs (supabase/cli c75aea2,
// packages/stack/ARCHITECTURE.md:487-512; src/StackHost.ts:135-147,357-372;
// src/internal/host-process.ts:18-41). It takes the project's lease, serves the page on the person's
// port and a control endpoint on a port the system gives, publishes its record, and only then reports
// ready on the readiness pipe (descriptor 3) its launcher reads. It runs until it is asked to shut down:
// POST /shutdown, SIGINT or SIGTERM, or, for a page service started for a terminal (`watch`), the end of
// its stdin. Shutting down closes admission to new reviewer checks, cancels the one running and waits
// until the processes it started are gone, then withdraws its record and lets the lease go.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { graphMcpServer, listCodexMcpServers, loadOrCreatePolicySnapshot, probeAuditDir, readJson, retentionDays, settleMcp } from "../../service/index.mjs";
import { acquireLease } from "./pageLease.mjs";
import { currentRelease, serviceFiles } from "./pageService.mjs";
import { createReviewerProbeService } from "./reviewerProbe.mjs";
import { DEFAULT_WATCH_PORT, findPortOwner, LOOPBACK_HOST, portBumpNotice, startWatchServer } from "./watchServer.mjs";

// One line on the readiness pipe, then the pipe is closed (internal/host-process.ts:18-41).
function report(value) {
  try {
    fs.writeSync(3, Buffer.from(JSON.stringify(value) + "\n", "utf8"));
  } finally {
    try { fs.closeSync(3); } catch {}
  }
}

// Every control request carries the record's secret as a bearer token, compared in constant time
// (HostProcess.ts:72-82); anything else is refused with 401 (StackHost.ts:357-359).
function authorizes(header, secret) {
  const expected = "Bearer " + secret;
  if (typeof header !== "string" || header.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ header.charCodeAt(index);
  return difference === 0;
}

function startControlServer({ secret, identity, shutdown, ended }) {
  const server = http.createServer((req, res) => {
    if (!authorizes(req.headers.authorization, secret)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/identity") {
      const body = JSON.stringify(identity());
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body);
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      // The process ends only once this answer has been sent.
      shutdown().then(
        () => res.writeHead(204).end(ended),
        (error) => {
          const body = JSON.stringify({ message: String(error?.message || error) });
          res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body, ended);
        },
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // A loopback port the system gives: no other process is told to use it, and a stale record naming it
    // never reaches this one, since every request carries the secret.
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export async function runPageService({ paths, adapter, adapterId, adapterDefinition, adapterSource, port: portOption, lifetime, daily }) {
  if (!["session", "detached"].includes(lifetime)) throw new Error("The page service's lifetime must be session or detached.");
  let lease;
  let config;
  let database = null;
  try {
    config = await readJson(paths.bridgeConfigPath);
    // The page service comes after the person's database, whose lock is its lease.
    database = await (await import("../../service/database/index.mjs")).openDatabase();
    lease = await acquireLease(paths, config.project_id);
  } catch (error) {
    // The loser of a race for the lease says so and exits; its launcher attaches to the winner.
    report({ type: "error", reason: error.code === "lease_held" ? "lease-held" : undefined, message: error.message });
    await database?.close().catch(() => {});
    return error.code === "lease_held" ? 0 : 1;
  }
  let page = null;
  let control = null;
  let service = null;
  let reported = false;
  try {
    const port = portOption ?? config.watch?.port ?? DEFAULT_WATCH_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("watch port must be 0 through 65535.");
    const rolesIn = (current) => ({ writer: current.roles?.writer?.provider_id, reviewer: current.roles?.reviewer?.provider_id });
    const roles = rolesIn(config);
    if (!roles.writer || !roles.reviewer) throw new Error("The page service requires roles selected by init.");
    service = createReviewerProbeService({
      // Read when asked: the page stays up while bridge.json changes, and the next start uses the new roles.
      loadRoles: async () => rolesIn(await readJson(paths.bridgeConfigPath)),
      // For the page's own button; a start brings the list its plan sealed.
      resolveMcp: async (provider) => {
        const { snapshot } = await loadOrCreatePolicySnapshot(paths);
        const settled = await settleMcp({ reviewer: provider, allow: snapshot.effective_policy.reviewer.mcp_allow, listCodex: () => listCodexMcpServers(adapter), cwd: paths.repoRoot });
        return { off: settled.reviewerOff, allow: settled.reviewerMcp };
      },
      projectRoot: paths.repoRoot,
      // Every review is given Bridge's graph server, so the check runs with it (T0-GRAPH-01).
      graph: graphMcpServer({ bridgeRoot: paths.bridgeRoot, repoRoot: paths.repoRoot }),
      adapter,
      adapterId,
      adapterConfig: adapterDefinition || null,
      adapterSource,
      // Audit only: the page service's memory is the sole source of a current proof. T0-11 C3: one day
      // file per local day, kept as long as the run archive.
      auditDir: probeAuditDir(paths),
      // T0-11 F9: an invalid retention setting is passed on as null (clean nothing), never as 15.
      retentionDays: (() => { try { return retentionDays(config); } catch { return null; } })(),
    });
    page = await startWatchServer({ service, uiRoot: path.join(paths.bridgeRoot, "ui"), port, strictPort: config.watch?.strict_port === true });
    const secret = randomBytes(32).toString("hex");
    let identity = null;
    let stopping = null;
    let end;
    const ended = new Promise((resolve) => { end = resolve; });
    const shutdown = () => {
      stopping ??= (async () => {
        // Draining: no new reviewer check is admitted, the running one is cancelled and its processes
        // are gone (ARCHITECTURE.md:505-512); then the page closes and the record is withdrawn while the
        // lock is still held, and left alone once it was lost (pageLease.mjs retractRecord).
        const drained = await service.drain();
        await closeServer(page.server);
        await lease.retractRecord();
        // A cancelled check whose processes are not confirmed gone fails the shutdown, said as such; the page
        // service still ends and serves nothing more (ARCHITECTURE.md:530).
        if (!drained.settled) {
          throw new Error("The reviewer check was cancelled, but its processes could not be confirmed stopped (" + drained.detail + ").");
        }
      })();
      return stopping;
    };
    control = await startControlServer({ secret, identity: () => identity, shutdown, ended: () => end() });
    identity = {
      project_id: config.project_id,
      pid: process.pid,
      port: control.address().port,
      release: await currentRelease(paths.bridgeRoot),
      url: page.url,
      page_port: page.port,
    };
    await lease.publishRecord({ ...identity, secret, lifetime, started_at: new Date().toISOString() });
    // The address editors read; it survives restarts.
    await fsp.writeFile(serviceFiles(paths).urlPath, page.url + "\n", "utf8");
    const notice = page.bumped ? portBumpNotice(page.requestedPort, page.url, findPortOwner(page.requestedPort)) : null;
    if (notice) Promise.resolve(adapter?.notify?.("Review Bridge", notice)).catch(() => {});
    // SIGINT and SIGTERM are the same shutdown as POST /shutdown (ARCHITECTURE.md:503); a page service
    // started for a terminal also ends with its stdin, whether the terminal closed it or died
    // (ARCHITECTURE.md:491; StackHost.ts:135-147).
    const done = () => shutdown().then(() => end(), () => end());
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    // Lost ownership (ARCHITECTURE.md:495): the database session that is the lease ended (the database
    // stopped, or the session was terminated). The page service stops what it started, closes its
    // listeners and exits; it is never left running without its lease.
    lease.onLost((error) => {
      process.stderr.write("The page service lost its lease: " + (error?.message || "its database session ended") + "\n");
      done();
    });
    if (lifetime === "session") {
      process.stdin.once("end", done);
      process.stdin.once("close", done);
      process.stdin.once("error", done);
      process.stdin.resume();
    }
    report({ type: "ready", endpoint: identity, secret, notice });
    reported = true;
    process.stdout.write("Review Bridge page service: " + page.url + " (pid " + process.pid + ", " + lifetime + ")\n");

    // T0-02 R3.4: prune at start and once a day while the service runs.
    await daily().catch((error) => process.stderr.write("prune: " + error.message + "\n"));
    const dailyTimer = setInterval(() => {
      daily().catch((error) => process.stderr.write("prune: " + error.message + "\n"));
    }, 86_400_000);
    dailyTimer.unref();

    await ended;
    clearInterval(dailyTimer);
    process.stdin.pause();
    await closeServer(control);
    return 0;
  } catch (error) {
    if (!reported) report({ type: "error", message: error.message });
    throw error;
  } finally {
    if (page?.server.listening) await closeServer(page.server).catch(() => {});
    if (control?.listening) await closeServer(control).catch(() => {});
    await lease.release();
    // Nothing of this process keeps it alive once it has shut down.
    await database.close().catch(() => {});
  }
}
