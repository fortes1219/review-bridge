import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../service/records/fileStore.mjs";

// As write-file-atomic's own tests do, the failure is given through a mocked fs call, not provoked.
test("an atomic JSON write whose rename fails keeps the old file and leaves no temp file", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-file-store-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "plan.json");
  await writeJsonAtomic(file, { version: 1 });

  const failure = Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" });
  const rename = t.mock.method(fsp, "rename", async () => { throw failure; });
  await assert.rejects(writeJsonAtomic(file, { version: 2, id: randomUUID() }), failure);
  rename.mock.restore();

  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { version: 1 });
  assert.deepEqual(await fsp.readdir(directory), ["plan.json"]);
});
