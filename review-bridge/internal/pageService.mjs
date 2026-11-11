#!/usr/bin/env node
// The page service's own process. launchPage (features/setupCheck/pageService.mjs) runs this file directly
// with node, in the project's folder, with a readiness pipe on its fourth descriptor; it is no command, so
// help, the manifest and the README never list it. supabase/cli starts its stack owner the same way when it
// runs from its source: the launcher runs the entry file internal/host-process.ts, and only a CLI compiled
// into one executable, which has no such file, is given a private argv marker instead (c75aea2,
// packages/stack/src/HostProcess.ts:819-823; src/internal/dispatch-markers.ts:4; src/internal/host-process.ts:157).
// Bridge is published as its source, so it takes the entry file.
import "../utils/nodeVersion.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadAdapterForInspection, resolveAdapterModule, targetKey, UNSUPPORTED_ADAPTER } from "../router/platform.mjs";
import { runPageServiceProcess } from "../router/index.mjs";
import { createFakeAdapter, readJson } from "../service/index.mjs";
import { failureLine } from "../service/database/serverErrors.mjs";
import { PRIVATE_ROOT_NAME } from "../utils/paths.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// RC3-LINUX-00: the page and its zero-model checks run on any defined platform; only an eligible adapter
// (active or candidate in the manifest) lets the page start the reviewer check. The fake adapter is never
// eligible, so a page started with it can never hold a proof that a native work-start would accept.
async function pageAdapter(args) {
  if (args.includes("--fake-cli")) {
    const implementation = createFakeAdapter(bridgeRoot, "PASS");
    return { implementation, adapterSource: null, adapterDefinition: { target: "portable-fake", id: implementation.id, status: "fake", eligible: false } };
  }
  const adapterDefinition = loadAdapterForInspection(await readJson(path.join(bridgeRoot, "manifest.json")), process.platform, process.arch, { bridgeRoot });
  if (!adapterDefinition) {
    return { implementation: UNSUPPORTED_ADAPTER, adapterSource: null, adapterDefinition: { target: targetKey(process.platform, process.arch), status: "unsupported", eligible: false } };
  }
  const moduleUrl = resolveAdapterModule(bridgeRoot, adapterDefinition.module);
  return { implementation: await import(moduleUrl), adapterSource: fileURLToPath(moduleUrl), adapterDefinition };
}

// Written before the process exits; waits at most 1 second (host-process.ts:130-133).
const flushed = (stream) => new Promise((resolve) => {
  const timer = setTimeout(resolve, 1_000);
  stream.write("", () => { clearTimeout(timer); resolve(); });
});

const args = process.argv.slice(2);
let code;
try {
  const { implementation, adapterSource, adapterDefinition } = await pageAdapter(args);
  code = await runPageServiceProcess({
    args, repoRoot: process.cwd(), bridgeRoot, adapter: implementation, adapterId: adapterDefinition.id || null,
    adapterDefinition, adapterSource, privateRootName: PRIVATE_ROOT_NAME,
  });
} catch (error) {
  process.stderr.write(failureLine(error, null) + "\n");
  code = 2;
}
// The process exits as soon as its shutdown is done and its output is written, so no handle left open
// delays the exit that down waits for (host-process.ts:135-153).
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
