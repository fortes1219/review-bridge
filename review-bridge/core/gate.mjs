export function parseReviewGate(review) {
  const source = String(review);
  const gates = [...source.matchAll(/^\s*REVIEW_GATE\s*:\s*(PASS|FAIL)\s*$/gim)];
  const hardStops = [...source.matchAll(/^\s*HARD_STOP_REQUIRED\s*:\s*(true|false)\s*$/gim)];
  if (gates.length !== 1 || hardStops.length !== 1) {
    throw new Error(
      "Codex review must contain exactly one REVIEW_GATE line and exactly one "
      + "HARD_STOP_REQUIRED line.",
    );
  }
  return {
    review_gate: gates[0][1].toUpperCase(),
    hard_stop_required: hardStops[0][1].toLowerCase() === "true",
  };
}
