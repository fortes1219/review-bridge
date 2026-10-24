// The reviewer read-only check for `start`. The proof lives only in the running page service
// (nativeGate.mjs), so the check runs there, through the same request the page's Check button
// sends: the page's session token, its own origin, and one request id. Nothing is decided here;
// the service decides and holds the result, and the start gate reads it back from the service.
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";

import { probeAuditDir } from "../../service/index.mjs";
import { localDateKey } from "../../utils/dates.mjs";
import { checkService, serviceUp } from "./pageService.mjs";
import { PROBE_TIMEOUT_MS } from "./reviewerProbe.mjs";
import { TOKEN_HEADER } from "./watchServer.mjs";

function pageRequest(port, { method = "GET", requestPath, headers = {}, body = null, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const host = "localhost:" + port;
    const request = http.request({
      host: "127.0.0.1", port, method, path: requestPath, timeout: timeoutMs,
      headers: { Host: host, ...(body === null ? {} : { Origin: "http://" + host, "Content-Type": "application/json" }), ...headers },
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data }));
    });
    request.once("timeout", () => request.destroy(new Error("The page did not answer in time.")));
    request.once("error", reject);
    request.end(body === null ? undefined : JSON.stringify(body));
  });
}

// The token the page itself carries; any reader of the page has it, as the browser does.
async function pageToken(port) {
  const page = await pageRequest(port, { requestPath: "/" });
  const token = /name="review-bridge-session" content="([0-9a-f]{64})"/.exec(page.body)?.[1];
  if (page.status !== 200 || !token) throw new Error("The Bridge page did not give its session token.");
  return token;
}

export function probeAuditFile(paths, at = new Date()) {
  return path.join(probeAuditDir(paths), localDateKey(at) + ".jsonl");
}

// Starts the page if it is not running, then reports the check: passed earlier in this page
// session, passed now, or not passed with the reason and where its record is.
export async function ensureReviewerChecked({ paths, onStart = () => {} }) {
  let service = await checkService(paths);
  if (!service.running) {
    await serviceUp({ paths, bootstrapPath: path.join(paths.bridgeRoot, "bootstrap.mjs"), out: { write: () => {} } });
    service = await checkService(paths);
  }
  if (!service.running) return { ok: false, reason: "page_not_running", detail: service.reason, url: null };
  const url = service.url;
  if (service.status?.reviewer_readonly?.state === "proven") return { ok: true, already: true, url };
  if (service.status?.platform_eligible !== true) {
    return { ok: false, reason: service.status?.platform_status === "fake" ? "page_runs_fake_cli" : "adapter_not_verified", url };
  }
  onStart(service.status?.roles?.reviewer || "reviewer");
  const port = service.session.port;
  const response = await pageRequest(port, {
    method: "POST", requestPath: "/api/reviewer-probe", timeoutMs: PROBE_TIMEOUT_MS + 30_000,
    headers: { [TOKEN_HEADER]: await pageToken(port) },
    body: { confirm: "one_model_call", request_id: randomUUID() },
  });
  let answer;
  try { answer = JSON.parse(response.body); } catch { answer = null; }
  if (response.status !== 200 || answer?.ok !== true) {
    return { ok: false, reason: answer?.error || "probe_failed", url };
  }
  const result = answer.result;
  return {
    ok: result.proven === true,
    reason: result.reason,
    diagnostic_id: result.diagnostic_id,
    audit_path: result.audit_recorded ? probeAuditFile(paths, new Date(result.checked_at)) : null,
    url,
  };
}
