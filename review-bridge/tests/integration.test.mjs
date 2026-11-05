// Keeps the person's database out of these tests (see the fixture).
import "./fixtures/isolatedDataHome.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJson } from "../service/records/fileStore.mjs";
import { validateWriterPolicy } from "../policy/policyChecks.mjs";

function makeControl(maxCalls = 1) {
  return {
    schema_version: 2,
    authorization_status: "active",
    mode: "bounded_standing_correction",
    dispatch_transport: "writer_cli_resume_same_session",
    active_writer_session: "session-test-1",
    iteration: 0,
    reviewer_policy: { priority: "medium", model: null, effort: "medium" },
    token_policy: {
      writer_mode: "writer_only",
      writer_effort: "low",
      writer_disallowed_tools: ["Agent"],
      writer_self_review: "one_local_consistency_pass",
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      rounds_per_resume: maxCalls,
      call_timeout: 1,
    },
  };
}

test("writer policy requires the generic human-owner reconstruction gate", () => {
  const control = makeControl(1);
  delete control.token_policy.full_reconstruction_requires_human;
  assert.throws(
    () => validateWriterPolicy(control, 1, 1),
    /active writer-only bounded authorization/,
  );
});

test("JSON reader accepts a UTF-8 BOM", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-bom-"));
  const file = path.join(directory, "control.json");
  await fsp.writeFile(file, "\uFEFF{\"ok\":true}\n", "utf8");
  assert.deepEqual(await readJson(file), { ok: true });
  await fsp.rm(directory, { recursive: true, force: true });
});
