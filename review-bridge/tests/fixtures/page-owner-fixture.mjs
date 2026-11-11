// A stand-in for the page service's entry file (internal/pageService.mjs), given to launchPage as its entrypoint and started the way it starts the real one
// (as supabase/cli's tests start tests/host-process-fixture.ts). It writes its pid beside the project's
// settings first. --fixture-mode exit-early: exits before reporting ready. --fixture-mode other-release:
// holds the lease and serves the control endpoint as a page service of another release would.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const mode = argValue("--fixture-mode");
const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
fs.writeFileSync(path.join(process.cwd(), ".review-bridge", "fixture-owner.pid"), String(process.pid));

if (mode === "exit-early") process.exit(3);

// Writes a diagnostic to its log, then reports the failure on the readiness pipe, as supabase/cli's
// tests/failing-owner-fixture.ts does.
if (mode === "report-error") {
  process.stdout.write("fixture-owner-diagnostic: details only the log should hold\n");
  fs.writeSync(3, JSON.stringify({ type: "error", message: "owner startup failed" }) + "\n");
  fs.closeSync(3);
  process.exit(1);
}

if (mode === "other-release") {
  const { getBridgePaths } = await import(new URL("../../utils/paths.mjs", import.meta.url).href);
  const { acquireLease } = await import(new URL("../../features/setupCheck/pageLease.mjs", import.meta.url).href);
  const { openDatabase } = await import(new URL("../../service/database/index.mjs", import.meta.url).href);
  const paths = getBridgePaths(process.cwd(), bridgeRoot, { privateRootName: ".review-bridge" });
  const config = JSON.parse(fs.readFileSync(paths.bridgeConfigPath, "utf8"));
  const database = await openDatabase();
  const lease = await acquireLease(paths, config.project_id);
  const secret = "fixture-" + process.pid;
  let identity = null;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer " + secret) return res.writeHead(401).end();
    if (req.method === "GET" && req.url === "/identity") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
    if (req.method === "POST" && req.url === "/shutdown") {
      lease.retractRecord().then(() => res.writeHead(204).end(async () => {
        server.closeAllConnections();
        server.close();
        await lease.release();
        await database.close();
        process.exit(0);
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  identity = { project_id: config.project_id, pid: process.pid, port: server.address().port, release: "0.0.0-other+fixture", url: "http://localhost:1/", page_port: 1 };
  await lease.publishRecord({ ...identity, secret, lifetime: "detached", started_at: new Date().toISOString() });
  fs.writeSync(3, JSON.stringify({ type: "ready", endpoint: identity, secret }) + "\n");
  fs.closeSync(3);
}
