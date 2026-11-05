import fsp from "node:fs/promises";
import path from "node:path";

import { listCodexMcpServers, loadOrCreatePolicySnapshot, probeAuditDir, readJson, retentionDays, settleMcp } from "../../service/index.mjs";
import { removeServiceSession, serviceFiles, writeServiceSession } from "./pageService.mjs";
import { createReviewerProbeService } from "./reviewerProbe.mjs";
import { DEFAULT_WATCH_PORT, findPortOwner, portBumpNotice, startWatchServer } from "./watchServer.mjs";

// The setup page in the foreground until Ctrl+C. `daily` is the router's daily job (the records'
// prune); it runs at start and once a day while the page is up.
export async function startWatch({ paths, adapter, adapterId, adapterDefinition, adapterSource, port: portOption, daily }) {
  const config = await readJson(paths.bridgeConfigPath);
  const port = portOption ?? config.watch?.port ?? DEFAULT_WATCH_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("watch port must be 0 through 65535.");
  const rolesIn = (current) => ({ writer: current.roles?.writer?.provider_id, reviewer: current.roles?.reviewer?.provider_id });
  const roles = rolesIn(config);
  if (!roles.writer || !roles.reviewer) throw new Error("watch requires roles selected by init.");
  const service = createReviewerProbeService({
    // Read when asked: the page stays up while bridge.json changes, and the next start uses the new roles.
    loadRoles: async () => rolesIn(await readJson(paths.bridgeConfigPath)),
    // For the page's own button; a start brings the list its plan sealed.
    resolveMcp: async (provider) => {
      const { snapshot } = await loadOrCreatePolicySnapshot(paths);
      const settled = await settleMcp({ reviewer: provider, allow: snapshot.effective_policy.reviewer.mcp_allow, listCodex: () => listCodexMcpServers(adapter), cwd: paths.repoRoot });
      return { off: settled.reviewerOff, allow: settled.reviewerMcp };
    },
    projectRoot: paths.repoRoot,
    adapter,
    adapterId,
    adapterConfig: adapterDefinition || null,
    adapterSource,
    // Audit only: the watch process memory is the sole source of a current proof. T0-11 C3: one
    // day file per local day, kept as long as the run archive.
    auditDir: probeAuditDir(paths),
    // T0-11 F9: an invalid retention setting is passed on as null (clean nothing), never as 15.
    retentionDays: (() => { try { return retentionDays(config); } catch { return null; } })(),
  });
  const watch = await startWatchServer({
    service,
    uiRoot: path.join(paths.bridgeRoot, "ui"),
    port,
    strictPort: config.watch?.strict_port === true,
  });
  if (watch.bumped) {
    const notice = portBumpNotice(watch.requestedPort, watch.url, findPortOwner(watch.requestedPort));
    process.stdout.write(notice + "\n");
    Promise.resolve(adapter.notify?.("Review Bridge", notice)).catch(() => {});
  }
  // The stable URL file is what up, ps, and editors read; it survives restarts.
  // C1: the listening process records itself; up, ps, down and init verify against this.
  await writeServiceSession(paths, {
    pid: process.pid, port: watch.port, url: watch.url, service_id: watch.serviceId, started_at: new Date().toISOString(),
  });
  await fsp.writeFile(serviceFiles(paths).urlPath, watch.url + "\n", "utf8");
  // T0-02 R3.4: prune at start and once a day while the service runs.
  await daily().catch((error) => process.stderr.write("prune: " + error.message + "\n"));
  const dailyTimer = setInterval(() => {
    daily().catch((error) => process.stderr.write("prune: " + error.message + "\n"));
  }, 86_400_000);
  dailyTimer.unref();
  process.stdout.write("Review Bridge setup page: " + watch.url + "\n"
    + "Opening or refreshing the page uses no model. Press Ctrl+C to stop.\n");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(dailyTimer);
  await watch.close();
  await removeServiceSession(paths);
  return 0;
}
