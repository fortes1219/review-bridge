#!/usr/bin/env node

import "./utils/nodeVersion.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  bridgeRootFrom,
  loadAdapterForInspection,
  resolveAdapterModule,
  selectAdapter,
  targetKey,
  UNSUPPORTED_ADAPTER,
} from "./router/platform.mjs";
import { COMMANDS, dispatchCommand } from "./router/index.mjs";
import { renderCommandHelp, renderMainHelp } from "./router/help.mjs";
import { inspectDoctor } from "./features/doctor/index.mjs";
import { createFakeAdapter, readJson } from "./service/index.mjs";
import { getBridgePaths, PRIVATE_ROOT_NAME } from "./utils/paths.mjs";
import { assertReviewerProof, nativeGateDecision } from "./router/guards/nativeGate.mjs";

// Bridge is installed in its own folder; the project it works on is named with --project <folder>,
// or is the folder the command runs in. Nothing is looked up from where Bridge itself sits.
const bridgeRoot = bridgeRootFrom(import.meta.url);
const privateRootName = PRIVATE_ROOT_NAME;

function takeProject(argv) {
  const index = argv.indexOf("--project");
  if (index < 0) return { repoRoot: process.cwd(), args: argv };
  const value = argv[index + 1];
  // `clean --project` with no folder is clean's own option: clear this project's records.
  if ((!value || value.startsWith("--")) && argv[0] === "clean") return { repoRoot: process.cwd(), args: argv };
  if (!value || value.startsWith("--")) throw new Error("Missing value for --project");
  return { repoRoot: path.resolve(value), args: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

function assertPlatformContract(implementation) {
  if (typeof implementation.resolveExecutable !== "function"
      || typeof implementation.buildInvocation !== "function"
      || typeof implementation.notify !== "function") {
    throw new Error("Selected adapter does not implement the platform contract.");
  }
}

async function platformAdapter(manifest) {
  const adapterDefinition = selectAdapter(manifest, process.platform, process.arch);
  const moduleUrl = resolveAdapterModule(bridgeRoot, adapterDefinition.module);
  const implementation = await import(moduleUrl);
  assertPlatformContract(implementation);
  return { adapterDefinition, adapterSource: fileURLToPath(moduleUrl), implementation };
}

async function main() {
  const { repoRoot, args: argv } = takeProject(process.argv.slice(2));
  const [command, ...args] = argv;
  const all = args.includes("--all");
  if (!command || command === "--help" || command === "-h") {
    (command ? process.stdout : process.stderr).write(renderMainHelp({ all }));
    return command ? 0 : 2;
  }
  if (COMMANDS[command] && (args.includes("--help") || args.includes("-h"))) {
    process.stdout.write(renderCommandHelp(command, { all }));
    return 0;
  }
  const manifestPath = path.join(bridgeRoot, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (command !== "doctor" && !manifest.commands.includes(command)) {
    throw new Error("Unknown command: " + command + ". Run: review-bridge --help");
  }
  const fakeRequested = args.includes("--fake-cli");
  // Native model calls are allowed only for the commands that start work on a person's yes (start,
  // resume, work-start); every other model entry point (review, bounded-resume) stays closed.
  const gate = nativeGateDecision({ command, args });
  if (!gate.allowed) throw new Error(gate.message);
  // N7: and only after the reviewer read-only check passed in the running page service. start and
  // resume run that check themselves first, and their gate asserts the proof before the yes.
  if (gate.mode === "native" && !["start", "resume"].includes(command)) await assertReviewerProof(getBridgePaths(repoRoot, bridgeRoot, { privateRootName }));
  const scenarioIndex = args.indexOf("--fake-scenario");
  const fakeScenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : "PASS";
  const modelFreeCommands = new Set(["work-plan", "work-status", "work-cancel", "status", "wait", "up", "down", "ps", "prune", "rm", "clean", "stop"]);
  // Native start and resume take this machine's adapter only after the reviewer check and the yes,
  // so without the proof they are refused the same way on every platform, adapter or not.
  const checksFirst = !fakeRequested && ["start", "resume"].includes(command);
  let adapterDefinition = null;
  let implementation = {};
  let adapterSource = null;
  if (fakeRequested) {
    if (!["start", "resume", "work-start", "doctor", "watch", "up"].includes(command)) {
      throw new Error("--fake-cli is supported only by start, resume, work-start, doctor, watch, and up. Leave --fake-cli out.");
    }
    implementation = createFakeAdapter(bridgeRoot, fakeScenario);
    // The fake adapter is never eligible: a page started with it cannot run the reviewer check, so it
    // can never hold a proof that a native work-start would accept.
    adapterDefinition = {
      target: "portable-fake",
      id: implementation.id,
      status: "fake",
      eligible: false,
    };
  } else if (command === "watch") {
    // RC3-LINUX-00: the page and its zero-model checks run on any defined platform; only an eligible
    // adapter (active or candidate in the manifest) lets the page start the reviewer check.
    adapterDefinition = loadAdapterForInspection(manifest, process.platform, process.arch, { bridgeRoot });
    if (adapterDefinition) {
      const moduleUrl = resolveAdapterModule(bridgeRoot, adapterDefinition.module);
      adapterSource = fileURLToPath(moduleUrl);
      implementation = await import(moduleUrl);
    } else {
      adapterDefinition = { target: targetKey(process.platform, process.arch), status: "unsupported", eligible: false };
      implementation = UNSUPPORTED_ADAPTER;
    }
  } else if (!modelFreeCommands.has(command) && !checksFirst) {
    ({ adapterDefinition, adapterSource, implementation } = await platformAdapter(manifest));
  }
  if (command === "doctor") {
    const paths = getBridgePaths(repoRoot, bridgeRoot, { privateRootName });
    process.stdout.write(JSON.stringify(
      await inspectDoctor({ paths, adapter: adapterDefinition, manifest }),
      null,
      2,
    ) + "\n");
    return 0;
  }
  if (!modelFreeCommands.has(command) && !checksFirst) assertPlatformContract(implementation);
  return await dispatchCommand({
    command,
    args,
    bridgeRoot,
    repoRoot,
    adapter: checksFirst ? null : implementation,
    loadAdapter: async () => (await platformAdapter(manifest)).implementation,
    adapterId: adapterDefinition?.id || null,
    adapterDefinition,
    adapterSource,
    privateRootName,
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write("Review bridge failed closed: " + error.message + "\n");
  process.exitCode = 2;
}
