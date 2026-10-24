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
  if (!value || value.startsWith("--")) throw new Error("Missing value for --project");
  return { repoRoot: path.resolve(value), args: [...argv.slice(0, index), ...argv.slice(index + 2)] };
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
  // T0-08: native model calls are allowed only for start and work-start confirmed at an interactive
  // terminal (no --approve, no --yes, stdin and stdout both a TTY). This is an operating restriction, not
  // proof of a human: an agent under the same OS account can still drive a terminal. Every other
  // model entry point (review, bounded-resume) stays closed in native mode.
  const gate = nativeGateDecision({ command, args, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) });
  if (!gate.allowed) throw new Error(gate.message);
  // N7: and only after the reviewer read-only check passed in the running page service. start runs
  // that check itself first and its gate asserts the proof before it asks.
  if (gate.mode === "native_terminal" && command !== "start") await assertReviewerProof(getBridgePaths(repoRoot, bridgeRoot, { privateRootName }));
  const scenarioIndex = args.indexOf("--fake-scenario");
  const fakeScenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : "PASS";
  const modelFreeCommands = new Set(["work-plan", "work-status", "work-cancel", "status", "wait", "up", "down", "ps", "prune", "rm", "stop"]);
  let adapterDefinition = null;
  let implementation = {};
  let adapterSource = null;
  if (fakeRequested) {
    if (!["start", "work-start", "doctor", "watch", "up"].includes(command)) {
      throw new Error("--fake-cli is supported only by start, work-start, doctor, watch, and up. Leave --fake-cli out.");
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
  } else if (!modelFreeCommands.has(command)) {
    adapterDefinition = selectAdapter(manifest, process.platform, process.arch);
    const moduleUrl = resolveAdapterModule(bridgeRoot, adapterDefinition.module);
    adapterSource = fileURLToPath(moduleUrl);
    implementation = await import(moduleUrl);
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
  if (!modelFreeCommands.has(command)
      && (typeof implementation.resolveExecutable !== "function"
        || typeof implementation.buildInvocation !== "function"
        || typeof implementation.notify !== "function")) {
    throw new Error("Selected adapter does not implement the platform contract.");
  }
  return await dispatchCommand({
    command,
    args,
    bridgeRoot,
    repoRoot,
    adapter: implementation,
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
