export function parseOptions(args, schema) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const definition = schema[token];
    if (!definition) throw new Error("Unsupported option: " + token);
    if (definition.type === "boolean") {
      values[definition.key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Option " + token + " requires a value.");
    }
    if (definition.multiple) {
      (values[definition.key] ??= []).push(value);
      index += 1;
      continue;
    }
    values[definition.key] = definition.type === "number" ? Number(value) : value;
    if (definition.type === "number" && !Number.isFinite(values[definition.key])) {
      throw new Error("Option " + token + " requires a number.");
    }
    index += 1;
  }
  return values;
}
