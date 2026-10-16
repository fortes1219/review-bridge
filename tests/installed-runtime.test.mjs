import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadInstalledServiceModules } from "../installer/neutral-install.mjs";

async function writeModule(runtimeRoot, relative, layout) {
  const file = path.join(runtimeRoot, ...relative.split("/"));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, relative.endsWith("paths.mjs")
    ? "export function getBridgePaths() { return { layout: \"" + layout + "\" }; }\n"
    : "export const layout = \"" + layout + "\";\n", "utf8");
}

test("an installed runtime is read in its own layout: feature-based first, then the core/ layout of older installs", async (t) => {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-installed-runtime-"));
  t.after(() => fsp.rm(runtimeRoot, { recursive: true, force: true }));
  assert.equal(await loadInstalledServiceModules(runtimeRoot), null, "no page service module means nothing to load");

  await writeModule(runtimeRoot, "core/paths.mjs", "core");
  await writeModule(runtimeRoot, "core/service.mjs", "core");
  const older = await loadInstalledServiceModules(runtimeRoot);
  assert.equal(older.service.layout, "core");
  assert.equal(older.getBridgePaths().layout, "core");

  await writeModule(runtimeRoot, "utils/paths.mjs", "feature");
  await writeModule(runtimeRoot, "features/setupCheck/pageService.mjs", "feature");
  const current = await loadInstalledServiceModules(runtimeRoot);
  assert.equal(current.service.layout, "feature");
  assert.equal(current.getBridgePaths().layout, "feature");
});
