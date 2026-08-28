#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  bridgeRootFrom,
  resolveAdapterModule,
  selectAdapter,
} from "./core/platform.mjs";
import { dispatchCommand } from "./core/commands.mjs";
import { inspectDoctor } from "./core/doctor.mjs";
import { createFakeAdapter } from "./core/fake-adapter.mjs";
import { readJson } from "./core/io.mjs";
import { getBridgePaths } from "./core/paths.mjs";

const bridgeRoot = bridgeRootFrom(import.meta.url);
const repoRoot = path.resolve(bridgeRoot, "../../..");

function printUsage() {
  process.stderr.write(
    [
      "Usage: node bootstrap.mjs <command> [options]",
      "",
      "Commands:",
      "  enqueue          Enqueue a Claude report from hook stdin",
      "  review           Run the Codex review worker",
      "  bounded-resume   Resume the authorized Claude writer session",
      "  work-plan       Create a checksum-gated first/next work package plan",
      "  work-start      Authorize and run a planned work package end to end",
      "  work-status     Show human-readable work package state",
      "  work-cancel     Consume the active authorization",
      "  status           Show queue and latest-review status",
      "  wait             Wait for the next queued report",
      "  doctor           Validate platform selection without running work",
      "  migrate-control  Plan/apply/rollback a legacy v2/v3 CONTROL migration",
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
  const scenarioIndex = args.indexOf("--fake-scenario");
  const fakeScenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : "PASS";
  const modelFreeCommands = new Set(["work-plan", "work-status", "work-cancel", "status", "wait", "migrate-control"]);
  let adapterDefinition = null;
  let implementation = {};
  if (fakeRequested) {
    if (!["work-start", "doctor"].includes(command)) {
      throw new Error("--fake-cli is supported only by work-start and doctor.");
    }
    implementation = createFakeAdapter(bridgeRoot, fakeScenario);
    adapterDefinition = {
      target: "portable-fake",
      id: implementation.id,
    };
  } else if (!modelFreeCommands.has(command)) {
    adapterDefinition = selectAdapter(manifest, process.platform, process.arch);
    const moduleUrl = resolveAdapterModule(bridgeRoot, adapterDefinition.module);
    implementation = await import(moduleUrl);
  }
  if (command === "doctor") {
    const paths = getBridgePaths(repoRoot, bridgeRoot);
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
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write("Review bridge failed closed: " + error.message + "\n");
  process.exitCode = 2;
}
