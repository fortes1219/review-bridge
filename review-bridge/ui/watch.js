import { confirmedRetry, probeReplyText, readinessView } from "/readiness-view.js";

const token = document.querySelector('meta[name="review-bridge-session"]').content;
const ROLE_NAMES = { writer: "Writer（寫入者）", reviewer: "Reviewer（獨立審查者）" };
const NEXT = {
  install_cli: (p) => `請先安裝 ${p} CLI，再按「重新檢查」。`,
  sign_in: (p) => `請先在終端機登入 ${p}（${p === "claude" ? "claude auth login" : "codex login"}），再按「重新檢查」。`,
  recheck_sign_in: (p) => `無法確認 ${p} 是否已登入。請確認登入狀態後按「重新檢查」。`,
};

function text(id, value, cls) {
  const el = document.getElementById(id);
  el.textContent = value;
  el.className = cls || "";
}

let lastCheckedAt = null;

function render(status) {
  lastCheckedAt = status.reviewer_readonly?.checked_at || null;
  const roles = document.getElementById("roles");
  roles.replaceChildren();
  for (const role of ["writer", "reviewer"]) {
    const check = status.checks[role];
    const dt = document.createElement("dt");
    dt.textContent = `${ROLE_NAMES[role]}：${check.provider}`;
    const dd = document.createElement("dd");
    const cli = check.cli_present ? "已找到 CLI" : "找不到 CLI";
    const auth = check.authenticated === true ? "已登入" : check.authenticated === false ? "未登入" : "登入狀態不明";
    dd.textContent = `${cli}；${check.cli_present ? auth : "尚未檢查登入"}。` + (NEXT[check.next_action] ? " " + NEXT[check.next_action](check.provider) : "");
    dd.className = check.next_action === "none" ? "ok" : "bad";
    roles.append(dt, dd);
  }
  // T0-11 甲 2: every sentence below comes from readinessView, which the tests exercise.
  const view = readinessView(status);
  text("readonly-state", view.readonly.text, view.readonly.tone);
  const details = document.getElementById("readonly-details");
  details.hidden = !view.readonly.details;
  const lines = document.getElementById("readonly-evidence");
  lines.replaceChildren(...(view.readonly.details || []).map((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    return item;
  }));
  document.getElementById("cost-notice").hidden = !view.probe.primaryVisible;
  const probe = document.getElementById("probe");
  probe.hidden = !view.probe.primaryVisible;
  probe.disabled = view.probe.primaryDisabled;
  const retry = document.getElementById("probe-retry");
  retry.hidden = !view.probe.retryVisible;
  retry.disabled = Boolean(view.probe.retryDisabled);
  if (view.probe.note) text("probe-result", view.probe.note);
  text("native-state", view.native.text, view.native.tone);
}

async function refresh() {
  const response = await fetch("/api/status", { cache: "no-store" });
  render(await response.json());
}

async function runProbe() {
  document.getElementById("probe").disabled = true;
  document.getElementById("probe-retry").disabled = true;
  text("probe-result", "檢查中（最多啟動一次 reviewer CLI，可能消耗模型額度），請稍候…");
  const before = lastCheckedAt;
  let reply;
  try {
    const response = await fetch("/api/reviewer-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Review-Bridge-Token": token },
      body: JSON.stringify({ confirm: "one_model_call", request_id: crypto.randomUUID() }),
    });
    reply = await response.json().catch(() => ({ ok: false, error: "unreadable_reply" }));
  } catch {
    reply = { ok: false, network: true };
  }
  // The outcome itself comes from the watch memory; this line only says what the reply proves.
  const refreshed = await refresh().then(() => true, () => false);
  text("probe-result", probeReplyText(reply, { before, after: lastCheckedAt, refreshed }), reply.ok && refreshed ? "" : "bad");
}

document.getElementById("refresh").addEventListener("click", () => refresh().catch(() => {}));
document.getElementById("probe").addEventListener("click", runProbe);
// T0-11 C2: a retry after an unclear or failed check asks once more before it spends a call.
document.getElementById("probe-retry").addEventListener("click", () => confirmedRetry((message) => window.confirm(message), runProbe));
refresh().catch(() => text("native-state", "無法讀取狀態。", "bad"));
