// T0-11 甲 2: what the setup page says for each state of the reviewer read-only check. A pure
// function shared by the page (watch.js) and the Node tests, so every sentence is tested with fake
// outputs. It says only what was established: a check that did not pass started no work and new
// native work stays locked; a call count is a record, not a cost.

// Codex 2026-10-16: Bridge limits a check to one reviewer CLI launch; it cannot bound or know the
// model requests made inside the CLI. Before and during a check the page says exactly that.
export const RETRY_CONFIRM = "這會再啟動一次 reviewer CLI；可能消耗模型額度，實際模型請求次數與 token 無法預先保證；不會自動重試。確定嗎？";

// Technical reasons, shown only under 詳細資訊.
export const REASONS = Object.freeze({
  sandbox_denied_write: "reviewer 實際嘗試寫入，被唯讀沙箱擋下，且沒有留下檔案。",
  write_allowed: "唯讀限制未通過。",
  write_reported_success: "寫入指令回報成功，但檔案沒有出現。",
  no_write_attempt: "reviewer 沒有真的嘗試寫入（可能拒絕或略過）。",
  denial_not_evidenced: "寫入失敗，但看不出是沙箱擋下的。",
  timeout: "檢查逾時。",
  rate_limited: "provider 回報用量限制。",
  invocation_error: "reviewer CLI 執行失敗。",
  incomplete_run: "reviewer CLI 沒有完整跑完。",
  ambiguous_output: "reviewer 的輸出無法明確對應到固定的寫入測試。",
  unsupported_provider: "目前選的 reviewer 無法提供可驗證的唯讀沙箱證據，所以不能進行檢查。若要使用此檢查，請重新執行 init 並選擇 codex 作為 reviewer。",
  adapter_not_verified: "這個平台的 adapter 尚未驗證，reviewer 唯讀實測與原生工作在這裡不開放。",
  configuration_changed: "角色、CLI、adapter、檢查程式或沙箱設定和檢查時不同。",
  fingerprint_unavailable: "目前讀不到用來比對的設定（例如 CLI 版本暫時查不出），無法確認和檢查時相同。",
  probe_error_after_start: "檢查程式在 reviewer CLI 啟動之後出錯。",
  probe_error_unclear: "檢查程式出錯，不確定 reviewer CLI 是否已啟動。",
});

// T0-11 F2/F3: refusals the server gives before anything was started; only these may say
// that no model was used.
const NOT_STARTED = new Set([
  "host_rejected", "origin_rejected", "token_rejected", "content_type_rejected", "invalid_body",
  "method_not_allowed", "replayed_request", "reviewer_not_ready", "probe_not_started", "adapter_not_verified",
]);

const NO_WORK = "這次檢查沒有啟動任何工作；";

// Codex 2026-10-16: Bridge counts reviewer CLI launches (call attempts); whether the CLI reached a
// model, and how much it used, is not known, and the page says so.
function callsLine(readonly) {
  return Number.isInteger(readonly.cli_launches)
    ? "這次檢查啟動了 " + readonly.cli_launches + " 次 reviewer CLI（呼叫嘗試），實際模型用量不知道。" : "";
}

// T0-11 F7: the person is asked to pass on an id only when its record exists.
function handOver(readonly) {
  return readonly.diagnostic_id ? "請把診斷編號交給維護者。" : "請找維護者（這次沒有可查的診斷編號）。";
}

// write_allowed covers several observations; only the ones actually seen are listed.
function observedLines(readonly) {
  const seen = readonly.observed || {};
  return [
    ...(seen.sentinel_present ? ["觀察到：測試要寫的檔案出現了。"] : []),
    ...(seen.file_changes > 0 ? ["觀察到：" + seen.file_changes + " 個檔案變更事件。"] : []),
    ...(seen.unexpected_entries > 0 ? ["觀察到：臨時資料夾裡多出 " + seen.unexpected_entries + " 個項目。"] : []),
  ];
}

function detailsFor(readonly) {
  return [
    "技術原因（" + (readonly.reason || "unknown") + "）：" + (REASONS[readonly.reason] || "無法判讀。"),
    ...(readonly.state === "failed" ? observedLines(readonly) : []),
    Number.isInteger(readonly.cli_launches)
      ? "reviewer CLI 啟動次數：" + readonly.cli_launches + " 次（呼叫嘗試；有沒有真的用到模型、用了多少，Bridge 不知道）。"
      : "不確定 reviewer CLI 有沒有啟動。",
    readonly.diagnostic_id
      ? "診斷編號：" + readonly.diagnostic_id + (readonly.checked_at ? "（檢查時間 " + readonly.checked_at + "）" : "")
      : readonly.audit_recorded === false ? "這次的紀錄沒有寫進稽核檔，沒有可查的診斷編號。" : "沒有診斷編號。",
    ...(readonly.audit_cleanup === "failed" ? ["舊紀錄這次沒有清掉。"] : []),
    ...(readonly.audit_cleanup === "skipped_invalid_retention" ? ["bridge.json 的保留天數無效，這次沒有清理舊紀錄。"] : []),
  ];
}

// status is the /api/status body. Returns the texts and which controls the page shows.
export function readinessView(status) {
  const readonly = status.reviewer_readonly || { state: "not_run" };
  const supported = status.probe_supported !== false;
  // RC3-LINUX-00: on an unverified platform the button is shown but never enabled.
  const eligible = status.platform_eligible !== false;
  const view = {
    readonly: { text: "", tone: "", details: null },
    probe: { primaryVisible: false, primaryDisabled: true, retryVisible: false, note: "" },
    native: { text: "", tone: "bad" },
  };
  if (!eligible) {
    view.readonly = { text: REASONS.adapter_not_verified, tone: "bad", details: null };
    view.probe.primaryVisible = true;
    view.probe.primaryDisabled = true;
  } else if (!supported) {
    view.readonly = { text: REASONS.unsupported_provider, tone: "bad", details: null };
  } else if (status.probe_in_flight) {
    view.readonly = { text: "檢查中（最多啟動一次 reviewer CLI，可能消耗模型額度），請稍候…", tone: "", details: null };
    view.probe.primaryVisible = true;
  } else if (readonly.state === "not_run") {
    // F12: only this process's memory is known; an earlier process may have checked.
    view.readonly = { text: "這次網頁服務啟動後還沒檢查過。按下按鈕前，reviewer 不會被視為可用。", tone: "", details: null };
    view.probe.primaryVisible = true;
    view.probe.primaryDisabled = !status.probe_available;
  } else if (readonly.state === "proven") {
    view.readonly = {
      text: "唯讀檢查通過（只在這次網頁服務執行期間有效）。開始工作前還要先用 work-plan 建好工作計畫，再由你在自己的終端機跑 work-start、看完卡片輸入 y。",
      tone: "ok", details: null,
    };
  } else if (readonly.state === "stale") {
    view.readonly = {
      text: "先前的檢查目前無法沿用。新的原生工作被安全鎖住；需要時再檢查一次（最多啟動一次 reviewer CLI，可能消耗模型額度）。",
      tone: "bad", details: detailsFor(readonly),
    };
    view.probe.primaryVisible = true;
    view.probe.primaryDisabled = !status.probe_available;
  } else if (readonly.state === "failed") {
    const main = readonly.reason === "write_allowed"
      ? "設定檢查沒通過：唯讀限制未通過。" + NO_WORK + "新的原生工作被安全鎖住。請勿使用這個 reviewer 設定。" + handOver(readonly)
      : readonly.reason === "write_reported_success"
        ? "設定檢查沒通過：寫入指令回報成功（檔案沒有出現）。" + NO_WORK + "新的原生工作被安全鎖住。" + handOver(readonly)
        : "設定檢查沒通過。" + NO_WORK + "新的原生工作被安全鎖住。" + handOver(readonly);
    view.readonly = { text: main, tone: "bad", details: detailsFor(readonly) };
    view.probe.retryVisible = true;
  } else {
    view.readonly = {
      text: "設定檢查未完成。" + NO_WORK + "新的原生工作仍被安全鎖住。" + callsLine(readonly)
        + "不需要自己重試；維護者需要時，可在詳細資訊裡再檢查一次。",
      tone: "bad", details: detailsFor(readonly),
    };
    view.probe.retryVisible = true;
  }
  if (view.probe.primaryVisible && eligible && supported && !status.probe_available && !status.probe_in_flight) {
    view.probe.note = "Reviewer 需先安裝 CLI 並登入，才能進行檢查。";
  }
  if (view.probe.retryVisible) view.probe.retryDisabled = !status.probe_available;
  view.native = !eligible
    ? { text: REASONS.adapter_not_verified, tone: "bad" }
    : readonly.state === "proven"
    ? { text: "唯讀已確認。開工還要先有工作計畫，並由你在自己的終端機看完卡片輸入 y。", tone: "ok" }
    : { text: "還不能開始原生工作：reviewer 唯讀檢查還沒通過，新的原生工作被安全鎖住。", tone: "bad" };
  return view;
}

// T0-11 F1/F2/F3/F6/F11: what the page may say about the reply to its check request. `before`
// and `after` are the checked_at the watch memory reported before and after; only a changed
// value is evidence that a check happened.
export function probeReplyText(reply, { before = null, after = null, refreshed = true } = {}) {
  if (reply?.ok) return refreshed ? "" : "無法讀取最新狀態。";
  let first;
  if (reply?.error === "in_flight") first = "已有一個檢查在進行中，這次沒有送出。";
  else if (reply?.error === "unsupported_reviewer") first = REASONS.unsupported_provider;
  else if (reply?.error === "adapter_not_verified") first = REASONS.adapter_not_verified + "檢查沒有開始，未使用模型。";
  else if (reply?.error && NOT_STARTED.has(reply.error)) first = "檢查沒有開始，未使用模型（" + reply.error + "）。";
  else if (reply?.network) first = "沒有收到回覆，不確定這次檢查有沒有開始。";
  else first = "檢查出錯，不確定有沒有啟動 reviewer CLI（" + (reply?.error || "unknown") + "）。";
  if (!refreshed) return first + "無法讀取最新狀態。";
  if (reply?.error && (NOT_STARTED.has(reply.error) || reply.error === "in_flight" || reply.error === "unsupported_reviewer")) return first;
  return first + (after && after !== before ? "重新整理後看到一次新的檢查結果，見上方。" : "重新整理後沒有看到新的檢查結果。");
}

// T0-11 C2: a retry is a second, explicit step. Nothing is sent unless the person confirms.
export async function confirmedRetry(confirm, run) {
  if (!confirm(RETRY_CONFIRM)) return { sent: false };
  return { sent: true, result: await run() };
}
