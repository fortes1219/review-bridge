import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function targetKey(platform, arch) {
  if (!platform || !arch) {
    throw new Error("Platform and architecture are required.");
  }
  return platform + "-" + arch;
}

export function selectAdapter(manifest, platform, arch) {
  if (!manifest || manifest.schema_version !== 2 || !manifest.adapters) {
    throw new Error("Review bridge manifest is invalid or unsupported.");
  }
  const target = targetKey(platform, arch);
  const adapter = manifest.adapters[target];
  if (!adapter || !["active", "candidate"].includes(adapter.status)) {
    const planned = Object.entries(manifest.adapters)
      .filter(([, value]) => !["active", "candidate"].includes(value.status))
      .map(([key, value]) => key + " (" + value.status + ")")
      .join(", ") || "none";
    throw new Error(
      "No active review bridge adapter for " + target + ". Planned targets: " + planned + ".",
    );
  }
  if (!adapter.id || !adapter.module) {
    throw new Error("Adapter definition for " + target + " is incomplete.");
  }
  return { target, ...adapter };
}

// The adapter for model-free checks (the page, init, roles-check): any defined adapter whose module
// is present. `eligible` is true only when the manifest marks it active or candidate, and it is set
// after the definition is copied, so nothing in a definition or passed by a caller can grant it. A
// status only gates model calls, never the page or a check that calls no model. Null when this
// platform has no definition or its module is missing: the caller reports "not ready", never fails.
export function loadAdapterForInspection(manifest, platform, arch, { bridgeRoot }) {
  if (!manifest || manifest.schema_version !== 2 || !manifest.adapters) {
    throw new Error("Review bridge manifest is invalid or unsupported.");
  }
  const target = targetKey(platform, arch);
  const adapter = manifest.adapters[target];
  if (!adapter?.id || !adapter.module) return null;
  let moduleUrl;
  try {
    moduleUrl = resolveAdapterModule(bridgeRoot, adapter.module);
  } catch {
    return null;
  }
  if (!fs.existsSync(fileURLToPath(moduleUrl))) return null;
  return { ...adapter, target, eligible: ["active", "candidate"].includes(adapter.status) };
}

// For a platform with no usable adapter: every check reports the CLI missing, and no model can start.
export const UNSUPPORTED_ADAPTER = Object.freeze({
  async resolveExecutable() { throw new Error("This platform has no Review Bridge adapter."); },
  buildInvocation() { throw new Error("This platform has no Review Bridge adapter."); },
  async notify() { return { sent: false, reason: "no_adapter" }; },
});

// What every adapter a command or the page service uses must provide; bootstrap.mjs and the page service's
// entry file (internal/pageService.mjs) check the one they take. UNSUPPORTED_ADAPTER and the fake adapter provide all three.
export function assertPlatformContract(implementation) {
  if (typeof implementation.resolveExecutable !== "function"
      || typeof implementation.buildInvocation !== "function"
      || typeof implementation.notify !== "function") {
    throw new Error("Selected adapter does not implement the platform contract.");
  }
}

export function resolveAdapterModule(bridgeRoot, modulePath) {
  const root = path.resolve(bridgeRoot);
  const candidate = path.resolve(root, modulePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Adapter module escaped the review bridge root.");
  }
  return pathToFileURL(candidate).href;
}

export function bridgeRootFrom(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}
