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
