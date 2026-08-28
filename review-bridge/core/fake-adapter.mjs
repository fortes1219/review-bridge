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
      if (kind === "claude") claudeCalls += 1;
      else codexCalls += 1;
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
    async notify() {},
  };
}
