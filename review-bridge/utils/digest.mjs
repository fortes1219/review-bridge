import { createHash } from "node:crypto";

// Key order does not change a value's identity.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  const source = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return createHash("sha256").update(source, "utf8").digest("hex");
}
