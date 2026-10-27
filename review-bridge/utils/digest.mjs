import { createHash } from "node:crypto";

const isTree = (value) => Boolean(value) && typeof value === "object";
const open = (source) => ({ source, keys: Array.isArray(source) ? [...source.keys()] : Object.keys(source).sort(), values: [] });

// Key order does not change a value's identity. Walked with a stack, not recursion: each open
// array or object collects its children's results and is closed once it has all of them.
export function canonical(value) {
  if (!isTree(value)) return value;
  const stack = [open(value)];
  for (;;) {
    const top = stack[stack.length - 1];
    if (top.values.length < top.keys.length) {
      const child = top.source[top.keys[top.values.length]];
      if (isTree(child)) stack.push(open(child));
      else top.values.push(child);
      continue;
    }
    stack.pop();
    const closed = Array.isArray(top.source) ? top.values : Object.fromEntries(top.keys.map((key, index) => [key, top.values[index]]));
    if (!stack.length) return closed;
    stack[stack.length - 1].values.push(closed);
  }
}

export function digest(value) {
  const source = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return createHash("sha256").update(source, "utf8").digest("hex");
}
