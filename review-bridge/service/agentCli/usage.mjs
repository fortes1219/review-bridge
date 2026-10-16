// Token usage from the writer and reviewer CLIs' own output (R1.6): fixed shapes, never throws.

export function parseWriterUsage(stdoutText, { call = null } = {}) {
  try {
    const parsed = JSON.parse(stdoutText);
    const result = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    if (!result || typeof result !== "object") return { role: "writer", call, parse_error: true };
    const usage = result.usage && typeof result.usage === "object" ? result.usage : null;
    const models = result.modelUsage && typeof result.modelUsage === "object" ? Object.keys(result.modelUsage) : [];
    const number = (value) => (Number.isFinite(value) ? value : null);
    return {
      role: "writer",
      call,
      model: models.length ? models.join(",") : null,
      num_turns: number(result.num_turns),
      input_tokens: number(usage?.input_tokens),
      cache_read_input_tokens: number(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: number(usage?.cache_creation_input_tokens),
      output_tokens: number(usage?.output_tokens),
      total_cost_usd: number(result.total_cost_usd),
      ...(usage ? {} : { parse_error: true }),
    };
  } catch {
    return { role: "writer", call, parse_error: true };
  }
}

export function parseReviewerUsage(stderrText, { jobId = null } = {}) {
  const match = /tokens used\s*\r?\n\s*([\d,]+)\s*$/i.exec(String(stderrText || "").trimEnd());
  if (!match) return { role: "reviewer", job_id: jobId, parse_error: true };
  const tokens = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(tokens)) return { role: "reviewer", job_id: jobId, parse_error: true };
  return { role: "reviewer", job_id: jobId, tokens_used: tokens };
}
