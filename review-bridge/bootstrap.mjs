#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  bridgeRootFrom,
  resolveAdapterModule,
  selectAdapter,
} from "./router/platform.mjs";
import { dispatchCommand } from "./router/index.mjs";
import { inspectDoctor } from "./features/doctor/index.mjs";
import { createFakeAdapter, readJson } from "./service/index.mjs";
import { getBridgePaths, PRIVATE_ROOT_NAME } from "./utils/paths.mjs";
import { assertReviewerProof, nativeGateDecision } from "./router/guards/nativeGate.mjs";

const bridgeRoot = bridgeRootFrom(import.meta.url);
const repoRoot = path.resolve(bridgeRoot, "../../..");
const privateRootName = path.basename(path.dirname(path.dirname(bridgeRoot)));
if (privateRootName !== PRIVATE_ROOT_NAME) {
  throw new Error("Bridge runtime must be installed under " + PRIVATE_ROOT_NAME + "/tools/; found " + privateRootName + ".");
}

function printUsage() {
  process.stderr.write(
    [
      "Usage: node bootstrap.mjs <command> [options]",
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
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return command ? 0 : 2;
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
    adapterDefinition = {
      target: "portable-fake",
      id: implementation.id,
    };
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
