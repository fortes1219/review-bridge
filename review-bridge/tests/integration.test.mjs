import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJson } from "../core/io.mjs";
import { validateWriterPolicy } from "../core/policy.mjs";

function makeControl(maxCalls = 1) {
  return {
    schema_version: 2,
    authorization_status: "active",
    mode: "bounded_standing_correction",
    dispatch_transport: "claude_cli_resume_same_session",
    active_claude_session: "session-test-1",
    iteration: 0,
    codex_policy: {
      classification_profile: "test-profile-v1",
      default_review_level: "STANDARD",
      allowed_review_levels: ["LIGHT", "STANDARD", "FULL", "SECURITY", "FINAL_CLOSURE"],
      effort_by_level: {
        LIGHT: "low",
        STANDARD: "medium",
        FULL: "high",
        SECURITY: "high",
        FINAL_CLOSURE: "high",
      },
    },
    token_policy: {
      claude_mode: "writer_only",
      claude_effort: "low",
      claude_disallowed_tools: ["Agent"],
      independent_semantic_reviewer: "Codex",
      claude_self_review: "one_local_consistency_pass",
      full_reconstruction_on_correction: false,
      full_reconstruction_requires_human: true,
      max_claude_calls_per_resume: maxCalls,
      max_claude_minutes_per_call: 1,
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
