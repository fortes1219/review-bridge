import { spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { PROVIDERS } from "../../service/index.mjs";

export const LOOPBACK_HOST = "127.0.0.1";
export const PUBLIC_HOST = "localhost";
export const TOKEN_HEADER = "x-review-bridge-token";
export const DEFAULT_WATCH_PORT = 8080;
const MAX_BODY = 16 * 1024;
const validMcp = (mcp) => [mcp?.off, mcp?.allow].every((names) => Array.isArray(names) && names.every((name) => typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name)));
const queryMcp = (text) => {
  if (text === null) return null;
  try {
    const mcp = JSON.parse(text);
    return validMcp(mcp) ? { off: mcp.off, allow: mcp.allow } : undefined;
  } catch {
    return undefined;
  }
};
const STATIC = Object.freeze({
  "/": ["watch.html", "text/html; charset=utf-8"],
  "/watch.js": ["watch.js", "text/javascript; charset=utf-8"],
  "/readiness-view.js": ["readiness-view.js", "text/javascript; charset=utf-8"],
  "/watch.css": ["watch.css", "text/css; charset=utf-8"],
});
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

export function assertLoopbackBind(host) {
  if (host !== LOOPBACK_HOST) throw new Error("watch binds only to " + LOOPBACK_HOST + ".");
  return host;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function reject(res, status, code) {
  send(res, status, { ok: false, error: code });
}

function tokenMatches(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Best-effort, model-free lookup of the program listening on a port (win32 only).
export function findPortOwner(port, platform = process.platform) {
  if (platform !== "win32") return null;
  try {
    const options = { encoding: "utf8", windowsHide: true, timeout: 5000 };
    const netstat = spawnSync("netstat", ["-ano", "-p", "TCP"], options);
    const line = String(netstat.stdout || "").split(/\r?\n/)
      .map((entry) => entry.trim().split(/\s+/))
      .find((cols) => cols.length >= 5 && cols[3] === "LISTENING" && cols[1].endsWith(":" + port));
    const pid = line ? Number(line[4]) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const tasklist = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], options);
    const name = /^"([^"]+)"/.exec(String(tasklist.stdout || "").trim())?.[1];
    return name || null;
  } catch {
    return null;
  }
}

export function portBumpNotice(requested, url, owner) {
  return requested + " 被" + (owner ? " " + owner + " " : "") + "占用，改用 " + url;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, rejectListen) => {
    const onError = (error) => { server.off("listening", onListening); rejectListen(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// Controller-owned local page. GET never has side effects; the single POST may
// start at most one reviewer probe after every origin/token/type check passes.
export async function startWatchServer({
  service,
  uiRoot,
  host = LOOPBACK_HOST,
  port = 0,
  strictPort = false,
  token = randomBytes(32).toString("hex"),
  serviceId = randomBytes(16).toString("hex"),
}) {
  if (!/^[0-9a-f]{32}$/.test(serviceId)) throw new Error("watch service id must be 32 lowercase hex characters.");
  assertLoopbackBind(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("watch port must be 0 through 65535.");
  const usedRequestIds = new Set();
  let origin = null;
  let allowedHosts = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host)) return reject(res, 421, "host_rejected");
      // The page may be opened as localhost or 127.0.0.1; the origin must match the Host it used.
      const requestOrigin = "http://" + req.headers.host;
      const url = new URL(req.url, requestOrigin);
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        let content = await fsp.readFile(path.join(uiRoot, file), "utf8");
        if (file === "watch.html") content = content.replace("__SESSION_TOKEN__", token);
        return send(res, 200, content, type);
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        // C3: identity fields let the check tell this process from anything else on the port.
        const reviewer = url.searchParams.get("reviewer");
        if (reviewer !== null && !PROVIDERS.includes(reviewer)) return reject(res, 400, "invalid_reviewer");
        const mcp = queryMcp(url.searchParams.get("mcp"));
        if (mcp === undefined) return reject(res, 400, "invalid_mcp");
        return send(res, 200, { ok: true, ...(await service.status({ reviewer, mcp })), service_id: serviceId, pid: process.pid, port: server.address().port });
      }
      if (url.pathname === "/api/reviewer-probe") {
        if (req.method !== "POST") return reject(res, 405, "method_not_allowed");
        if (req.headers.origin !== requestOrigin) return reject(res, 403, "origin_rejected");
        if (!tokenMatches(token, req.headers[TOKEN_HEADER])) return reject(res, 403, "token_rejected");
        const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") return reject(res, 415, "content_type_rejected");
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return reject(res, 400, "invalid_body"); }
        if (body?.confirm !== "one_model_call" || typeof body.request_id !== "string"
          || !/^[A-Za-z0-9-]{16,64}$/.test(body.request_id)
          || (body.reviewer !== undefined && !PROVIDERS.includes(body.reviewer))
          || (body.mcp !== undefined && !validMcp(body.mcp))) {
          return reject(res, 400, "invalid_body");
        }
        if (usedRequestIds.has(body.request_id)) return reject(res, 409, "replayed_request");
        if (service.isInFlight()) return reject(res, 409, "in_flight");
        usedRequestIds.add(body.request_id);
        try {
          return send(res, 200, { ok: true, result: await service.run({ reviewer: body.reviewer ?? null, mcp: body.mcp ? { off: body.mcp.off, allow: body.mcp.allow } : null }) });
        } catch (error) {
          if (error.code === "in_flight") return reject(res, 409, "in_flight");
          if (error.code === "reviewer_not_ready") return reject(res, 409, "reviewer_not_ready");
          if (error.code === "unsupported_reviewer") return reject(res, 409, "unsupported_reviewer");
          if (error.code === "adapter_not_verified") return reject(res, 409, "adapter_not_verified");
          if (error.code === "shutting_down") return reject(res, 409, "shutting_down");
          // T0-11 F3: the service knows nothing was started. Anything else is not known (F6).
          if (error.code === "probe_not_started") return reject(res, 409, "probe_not_started");
          return reject(res, 500, "probe_failed");
        }
      }
      return reject(res, req.method === "GET" ? 404 : 405, req.method === "GET" ? "not_found" : "method_not_allowed");
    } catch {
      if (!res.headersSent) reject(res, 500, "internal_error");
    }
  });

  // Taken: the next one up, as far as 65535, as Vite and the database do (no other limit).
  const lastPort = port === 0 || strictPort ? port : 65535;
  for (let candidate = port; ; candidate += 1) {
    try {
      await listenOnce(server, candidate, host);
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (strictPort) {
        const refused = new Error("port " + port + " 被占用，watch.strict_port 為 true，不改用其他 port。");
        refused.code = "port_in_use";
        throw refused;
      }
      if (candidate >= lastPort) {
        const exhausted = new Error("port " + port + " 到 " + lastPort + " 都被占用。");
        exhausted.code = "port_in_use";
        throw exhausted;
      }
    }
  }
  const bound = server.address().port;
  allowedHosts = new Set([`${PUBLIC_HOST}:${bound}`, `${host}:${bound}`]);
  origin = `http://${PUBLIC_HOST}:${bound}`;
  return {
    server,
    url: origin + "/",
    port: bound,
    requestedPort: port,
    bumped: port !== 0 && bound !== port,
    token,
    serviceId,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
