import assert from "node:assert/strict";
import test from "node:test";

import { inspectRoleReadiness, validateRoles } from "../installer/role-readiness.mjs";

test("role check reports two selected providers without claiming native readiness", async () => {
  const calls = [];
  const result = await inspectRoleReadiness({ writer: "codex", reviewer: "claude" }, {
    adapter: { async resolveExecutable(provider) { return `/${provider}`; } },
    statusProbe(executable, args) {
      calls.push({ executable, args });
      return executable === "/codex"
        ? { status: 0, stdout: "", stderr: "Logged in using ChatGPT\n" }
        : { status: 0, stdout: '{"loggedIn":true}', stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    { executable: "/codex", args: ["login", "status"] },
    { executable: "/claude", args: ["auth", "status", "--json"] },
  ]);
  assert.equal(result.checks.writer.authenticated, true);
  assert.equal(result.checks.reviewer.authenticated, true);
  assert.equal(result.checks.writer.next_action, "none");
  assert.equal(result.ready_for_reviewer_probe, true);
  assert.equal(result.reviewer_readonly_proven, "not_run");
  assert.equal(result.separate_sessions_proven, "not_run");
  assert.equal(result.native_ready, false);
});

test("missing CLI and uncertain auth fail closed without a model call", async () => {
  let statusCalls = 0;
  const result = await inspectRoleReadiness({ writer: "claude", reviewer: "codex" }, {
    adapter: {
      async resolveExecutable(provider) {
        if (provider === "codex") throw new Error("not found");
        return "/claude";
      },
    },
    statusProbe() {
      statusCalls += 1;
      return { status: 0, stdout: "unexpected output", stderr: "" };
    },
  });
  assert.equal(statusCalls, 1);
  assert.deepEqual(result.checks.writer, {
    provider: "claude", cli_present: true, authenticated: "unknown", next_action: "recheck_sign_in",
  });
  assert.deepEqual(result.checks.reviewer, {
    provider: "codex", cli_present: false, authenticated: "unknown", next_action: "install_cli",
  });
  assert.equal(result.ready_for_reviewer_probe, false);
  assert.equal(result.native_ready, false);
});

test("a positive-looking response with a failed status cannot prove login", async () => {
  const result = await inspectRoleReadiness({ writer: "claude", reviewer: "codex" }, {
    adapter: { async resolveExecutable(provider) { return `/${provider}`; } },
    statusProbe(executable) {
      return executable === "/claude"
        ? { status: 1, stdout: '{"loggedIn":true}', stderr: "" }
        : { status: 1, stdout: "", stderr: "Logged in using ChatGPT" };
    },
  });
  assert.equal(result.checks.writer.authenticated, "unknown");
  assert.equal(result.checks.reviewer.authenticated, "unknown");
  assert.equal(result.native_ready, false);
});

test("role selection rejects unregistered providers", () => {
  assert.throws(() => validateRoles({ writer: "other", reviewer: "codex" }), /writer must be one of/);
});

test("a signed-out CLI gets a sign-in action and a thrown probe remains unknown", async () => {
  const result = await inspectRoleReadiness({ writer: "claude", reviewer: "codex" }, {
    adapter: { async resolveExecutable(provider) { return `/${provider}`; } },
    statusProbe(executable) {
      if (executable === "/codex") throw new Error("probe failed");
      return { status: 1, stdout: '{"loggedIn":false}', stderr: "" };
    },
  });
  assert.equal(result.checks.writer.next_action, "sign_in");
  assert.equal(result.checks.reviewer.authenticated, "unknown");
  assert.equal(result.checks.reviewer.next_action, "recheck_sign_in");
  assert.equal(result.ready_for_reviewer_probe, false);
});

test("installer and installed runtime share one readiness implementation", async () => {
  const installer = await import("../installer/role-readiness.mjs");
  const runtime = await import("../review-bridge/core/role-readiness.mjs");
  assert.equal(installer.inspectRoleReadiness, runtime.inspectRoleReadiness);
  assert.equal(installer.validateRoles, runtime.validateRoles);
  assert.equal(installer.PROVIDERS, runtime.PROVIDERS);
});
