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
import { failureLine, translatedFailure } from "./service/database/serverErrors.mjs";
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
  const modelFreeCommands = new Set(["work-plan", "work-status", "work-cancel", "status", "logs", "wait", "up", "down", "ps", "prune", "rm", "clean", "stop", "backup", "graph", "graph-mcp"]);
  // Native start and resume take this machine's adapter only after the reviewer check and the yes,
  // so without the proof they are refused the same way on every platform, adapter or not.
  const checksFirst = !fakeRequested && ["start", "resume"].includes(command);
  // doctor reports the database before the adapter (as start checks the reviewer before it, E7b): a
  // database that cannot be opened is said the same way on every platform, adapter or not.
  if (command === "doctor") {
    const config = await readJson(getBridgePaths(repoRoot, bridgeRoot, { privateRootName }).bridgeConfigPath).catch(() => null);
    if (config?.project_id) await (await import("./service/database/index.mjs")).openDatabase();
  }
  let adapterDefinition = null;
  let implementation = {};
  let adapterSource = null;
  if (fakeRequested) {
    if (!["start", "resume", "work-plan", "work-start", "doctor", "watch", "up"].includes(command)) {
      throw new Error("--fake-cli is supported only by start, resume, work-plan, work-start, doctor, watch, and up. Leave --fake-cli out.");
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
    // For what calls no model, a plan's list of MCP servers among it: any defined platform's adapter.
    inspectionAdapter: async () => {
      const definition = loadAdapterForInspection(manifest, process.platform, process.arch, { bridgeRoot });
      return definition ? await import(resolveAdapterModule(bridgeRoot, definition.module)) : UNSUPPORTED_ADAPTER;
    },
    adapterId: adapterDefinition?.id || null,
    adapterDefinition,
    adapterSource,
    privateRootName,
  });
}

// A failure the person can act on is said in the project's language (RC3-DOWN-01); the translations are
// loaded only for it.
async function failureTranslator(error) {
  if (!translatedFailure(error)) return null;
  try {
    const { createTranslator, resolveLocale } = await import("./features/workOrder/i18n.mjs");
    return await createTranslator(await resolveLocale(getBridgePaths(takeProject(process.argv.slice(2)).repoRoot, bridgeRoot, { privateRootName })));
  } catch {
    return null;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(failureLine(error, await failureTranslator(error)) + "\n");
  process.exitCode = 2;
}
