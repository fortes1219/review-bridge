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
import { dispatchCommand } from "./router/index.mjs";
import { inspectDoctor } from "./features/doctor/index.mjs";
import { createFakeAdapter, fileExists, readJson } from "./service/index.mjs";
import { bridgeUpgradeMarkerPath, getBridgePaths, PRIVATE_ROOT_NAME } from "./utils/paths.mjs";
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

function printUsage() {
  process.stderr.write(
    [
      "Usage: review-bridge <command> [--project <folder>] [options]",
      "       (the project is the current folder when --project is not given)",
      "",
      "Commands:",
      "  review           Run the Codex review worker",
      "  bounded-resume   Resume the authorized Claude writer session",
      "  work-plan       Create a checksum-gated first/next work package plan",
      "  work-start      Authorize and run a planned work package end to end",
      "  work-status     Show human-readable work package state",
      "  work-cancel     Consume the active authorization",
      "  status           Show queue and latest-review status",
      "  wait             Wait for the next queued report",
      "  doctor           Validate platform selection without running work",
      "  watch            Open the local setup page (loopback only)",
      "  up               Start the resident page service in the background",
      "  down             Stop the resident page service",
      "  ps               Show whether the resident page service is running",
      "  prune            Fold finished runs into day files and drop records past retention",
      "  rm <run_id>      Remove one finished run (folds it first)",
      "  stop <run_id>    Stop a running work package: kill its model process and close the run",
      "",
    ].join("\n"),
  );
}

async function main() {
  const { repoRoot, args: argv } = takeProject(process.argv.slice(2));
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return command ? 0 : 2;
  }
  if (await fileExists(bridgeUpgradeMarkerPath(path.dirname(bridgeRoot)))) {
    throw new Error("Bridge 正在升級，或上一次升級沒有完成：回 Bridge 資料夾再跑一次 npm start。");
  }
  const manifestPath = path.join(bridgeRoot, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (command !== "doctor" && !manifest.commands.includes(command)) {
    throw new Error("Unsupported review bridge command: " + command);
  }
  const fakeRequested = args.includes("--fake-cli");
  // T0-08: native model calls are allowed only for work-start confirmed at an interactive terminal
  // (no --approve, no --yes, stdin and stdout both a TTY). This is an operating restriction, not
  // proof of a human: an agent under the same OS account can still drive a terminal. Every other
  // model entry point (review, bounded-resume) stays closed in native mode.
  const gate = nativeGateDecision({ command, args, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) });
  if (!gate.allowed) throw new Error(gate.message);
  // N7: and only after the reviewer read-only check passed in the running page service.
  if (gate.mode === "native_terminal") await assertReviewerProof(getBridgePaths(repoRoot, bridgeRoot, { privateRootName }));
  const scenarioIndex = args.indexOf("--fake-scenario");
  const fakeScenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : "PASS";
  const modelFreeCommands = new Set(["work-plan", "work-status", "work-cancel", "status", "wait", "up", "down", "ps", "prune", "rm", "stop"]);
  let adapterDefinition = null;
  let implementation = {};
  let adapterSource = null;
  if (fakeRequested) {
    if (!["work-start", "doctor", "watch", "up"].includes(command)) {
      throw new Error("--fake-cli is supported only by work-start, doctor, watch, and up.");
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
