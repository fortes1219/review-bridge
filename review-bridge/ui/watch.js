"use strict";

const token = document.querySelector('meta[name="review-bridge-session"]').content;
const ROLE_NAMES = { writer: "Writer（寫入者）", reviewer: "Reviewer（獨立審查者）" };
const NEXT = {
  install_cli: (p) => `請先安裝 ${p} CLI，再按「重新檢查」。`,
  sign_in: (p) => `請先在終端機登入 ${p}（${p === "claude" ? "claude auth login" : "codex login"}），再按「重新檢查」。`,
  recheck_sign_in: (p) => `無法確認 ${p} 是否已登入。請確認登入狀態後按「重新檢查」。`,
};
const REASONS = {
  sandbox_denied_write: "已確認：reviewer 實際嘗試寫入，被唯讀沙箱擋下，且沒有留下檔案。",
  write_allowed: "未通過：reviewer 成功寫入了檔案。請勿使用這個 reviewer 設定。",
  write_reported_success: "未通過：寫入指令回報成功。請勿使用這個 reviewer 設定。",
  no_write_attempt: "無法確認：reviewer 沒有真的嘗試寫入（可能拒絕或略過）。這不算通過。",
  denial_not_evidenced: "無法確認：寫入失敗，但看不出是沙箱擋下的。這不算通過。",
  timeout: "無法確認：檢查逾時。這不算通過，也不會自動重試。",
  rate_limited: "無法確認：provider 回報用量限制。請稍後由你決定是否再按一次。",
  invocation_error: "無法確認：reviewer CLI 執行失敗。這不算通過。",
  incomplete_run: "無法確認：reviewer CLI 沒有完整跑完。這不算通過。",
  ambiguous_output: "無法確認：reviewer 的輸出無法明確對應到固定的寫入測試。這不算通過。",
  unsupported_provider: "目前選的 reviewer 無法提供可驗證的唯讀沙箱證據，所以不能進行檢查。若要使用此檢查，請重新執行 init 並選擇 codex 作為 reviewer。",
  configuration_changed: "先前的檢查已失效：角色、CLI、adapter、檢查程式或沙箱設定有變動，需要重新檢查。",
};

function text(id, value, cls) {
  const el = document.getElementById(id);
  el.textContent = value;
  el.className = cls || "";
}

function render(status) {
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
  const readonly = status.reviewer_readonly;
  if (readonly.state === "not_run") text("readonly-state", "尚未檢查。按下按鈕前，reviewer 不會被視為可用。");
  else text("readonly-state", (REASONS[readonly.reason] || "無法確認。這不算通過。")
    + (readonly.state === "proven" ? " 這個結果只在本次 watch 執行期間有效；關閉 watch 後需重新檢查。" : ""),
  readonly.state === "proven" ? "ok" : "bad");
  const probe = document.getElementById("probe");
  probe.disabled = !status.probe_available;
  if (!status.probe_supported) text("probe-result", REASONS.unsupported_provider, "bad");
  else if (!status.probe_available && !status.probe_in_flight) text("probe-result", "Reviewer 需先安裝 CLI 並登入，才能進行檢查。");
  text("native-state", "還不能。開始實際工作需要人類授權驗證，這一步尚未提供。" + (status.reviewer_readonly_proven === true ? "（reviewer 唯讀已確認）" : ""));
}

async function refresh() {
  const response = await fetch("/api/status", { cache: "no-store" });
  render(await response.json());
}

async function runProbe() {
  const button = document.getElementById("probe");
  button.disabled = true;
  text("probe-result", "檢查中，最多一次模型呼叫，請稍候…");
  try {
    const response = await fetch("/api/reviewer-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Review-Bridge-Token": token },
      body: JSON.stringify({ confirm: "one_model_call", request_id: crypto.randomUUID() }),
    });
    const body = await response.json();
    if (!body.ok) text("probe-result", body.error === "in_flight" ? "已有一個檢查在進行中。"
      : body.error === "unsupported_reviewer" ? REASONS.unsupported_provider
        : "檢查沒有開始，未使用模型（" + body.error + "）。", "bad");
    else text("probe-result", REASONS[body.result.reason] || "無法確認。這不算通過。", body.result.proven === true ? "ok" : "bad");
  } catch {
    text("probe-result", "無法連線到本機 Bridge。請確認 watch 仍在執行。", "bad");
  }
  await refresh().catch(() => {});
}

document.getElementById("refresh").addEventListener("click", () => refresh().catch(() => {}));
document.getElementById("probe").addEventListener("click", runProbe);
refresh().catch(() => text("native-state", "無法讀取狀態。", "bad"));
