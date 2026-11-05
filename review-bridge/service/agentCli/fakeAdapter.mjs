import path from "node:path";

const scenarios = new Set(["PASS", "FAIL_THEN_PASS", "HARD_STOP", "RATE_LIMIT"]);

export function createFakeAdapter(bridgeRoot, requestedScenario = "PASS") {
  const scenario = String(requestedScenario || "PASS").toUpperCase();
  if (!scenarios.has(scenario)) {
    throw new Error("Unsupported fake scenario: " + scenario);
  }
  const fakeClaude = path.join(bridgeRoot, "tests", "fixtures", "fake-claude.mjs");
  const fakeCodex = path.join(bridgeRoot, "tests", "fixtures", "fake-codex.mjs");
  let codexCalls = 0;
  let claudeCalls = 0;
  return {
    id: "portable-fake-cli",
    scenario,
    async resolveExecutable() {
      return process.execPath;
    },
    buildInvocation(kind, executable, args) {
      // Only reviews count toward the scenario; a contract check is a Codex call but not a review.
      const contractCheck = args.some((arg) => String(arg).endsWith("contract.check.schema.json"));
      if (kind === "claude") claudeCalls += 1;
      else if (!contractCheck) codexCalls += 1;
      let gate = "PASS";
      if (scenario === "FAIL_THEN_PASS") gate = codexCalls === 1 ? "FAIL" : "PASS";
      if (scenario === "HARD_STOP") gate = "HARD_STOP";
      return {
        command: executable,
        args: [kind === "claude" ? fakeClaude : fakeCodex, ...args],
        env: {
          ...process.env,
          FAKE_CODEX_GATE: gate,
          FAKE_CLAUDE_CALL: String(claudeCalls),
          FAKE_CLAUDE_RESULT: scenario === "RATE_LIMIT" ? "RATE_LIMIT" : "OK",
        },
      };
    },
    // T0-07: no desktop notification in fake mode; a test may capture or fail it through the environment.
    async notify(title, message) {
      if (process.env.FAKE_NOTIFY_FAIL === "1") throw new Error("fake notification failure");
      if (process.env.FAKE_NOTIFY_FILE) {
        const fs = await import("node:fs/promises");
        await fs.appendFile(process.env.FAKE_NOTIFY_FILE, JSON.stringify({ title, message, at: new Date().toISOString() }) + "\n");
        return { sent: true, channel: "fake_file" };
      }
      return { sent: false, reason: "fake_cli" };
    },
  };
}
