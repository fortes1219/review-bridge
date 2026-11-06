import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import test from "node:test";

import { confirmedRetry, probeReplyText, readinessView, RETRY_CONFIRM } from "../ui/readiness-view.js";

// T0-11 甲 2: the setup page's sentences, checked with fake /api/status bodies.
function status(readonly, extra = {}) {
  return {
    probe_supported: true, probe_available: true, probe_in_flight: false,
    reviewer_readonly: { state: "not_run", reason: null, checked_at: null, diagnostic_id: null, cli_launches: null, observed: null, ...readonly },
    ...extra,
  };
}

const UNKNOWN_REASONS = ["denial_not_evidenced", "no_write_attempt", "timeout", "rate_limited", "invocation_error", "incomplete_run", "ambiguous_output"];
const checked = { checked_at: "2026-10-15T13:48:04.220Z", diagnostic_id: "RBP-1A2B3C4D", cli_launches: 1, audit_recorded: true, audit_cleanup: "done" };
const noObservation = { sentinel_present: false, unexpected_entries: 0, file_changes: 0 };

test("D1 every state says only what was established", () => {
  const notRun = readinessView(status({}));
  assert.equal(notRun.readonly.text, "這次網頁服務啟動後還沒檢查過。按下按鈕前，reviewer 不會被視為可用。");
  assert.equal(notRun.probe.primaryVisible, true);
  assert.equal(notRun.probe.retryVisible, false);

  assert.equal(readinessView(status({}, { probe_in_flight: true, probe_available: false })).readonly.text, "檢查中（最多啟動一次 reviewer CLI，可能消耗模型額度），請稍候…");

  for (const reason of UNKNOWN_REASONS) {
    const view = readinessView(status({ state: "unknown", reason, ...checked, observed: noObservation }));
    assert.equal(view.readonly.text, "設定檢查未完成。這次檢查沒有啟動任何工作；新的原生工作仍被安全鎖住。這次檢查啟動了 1 次 reviewer CLI（呼叫嘗試），實際模型用量不知道。不需要自己重試；維護者需要時，可在詳細資訊裡再檢查一次。", reason);
    assert.ok(view.readonly.details.some((line) => line.includes("RBP-1A2B3C4D")), reason + ": the diagnostic id is in the details");
    assert.ok(view.readonly.details.some((line) => line.includes("（" + reason + "）")), reason + ": the technical reason is in the details");
  }
  // No call count in the state: no number in the sentence.
  const uncounted = readinessView(status({ state: "unknown", reason: "timeout", diagnostic_id: "RBP-00000001" }));
  assert.doesNotMatch(uncounted.readonly.text, /\d+ 次/);

  const allowed = readinessView(status({ state: "failed", reason: "write_allowed", ...checked, observed: { sentinel_present: false, unexpected_entries: 2, file_changes: 0 } }));
  assert.equal(allowed.readonly.text, "設定檢查沒通過：唯讀限制未通過。這次檢查沒有啟動任何工作；新的原生工作被安全鎖住。請勿使用這個 reviewer 設定。請把診斷編號交給維護者。");
  // Only what was observed is listed.
  assert.ok(allowed.readonly.details.includes("觀察到：臨時資料夾裡多出 2 個項目。"));
  assert.equal(allowed.readonly.details.some((line) => /測試要寫的檔案出現了|檔案變更事件/.test(line)), false);

  const reported = readinessView(status({ state: "failed", reason: "write_reported_success", ...checked, observed: noObservation }));
  assert.equal(reported.readonly.text, "設定檢查沒通過：寫入指令回報成功（檔案沒有出現）。這次檢查沒有啟動任何工作；新的原生工作被安全鎖住。請把診斷編號交給維護者。");

  const proven = readinessView(status({ state: "proven", reason: "sandbox_denied_write", ...checked }));
  assert.equal(proven.readonly.text, "唯讀檢查通過（只在這次網頁服務執行期間有效）。開始工作前還要先用 work-plan 建好工作計畫，再由你在自己的終端機跑 work-start、看完卡片輸入 y。");
  assert.equal(proven.native.text, "唯讀已確認。開工還要先有工作計畫，並由你在自己的終端機看完卡片輸入 y。");

  const stale = readinessView(status({ state: "stale", reason: "configuration_changed", ...checked }));
  assert.equal(stale.readonly.text, "先前的檢查目前無法沿用。新的原生工作被安全鎖住；需要時再檢查一次（最多啟動一次 reviewer CLI，可能消耗模型額度）。");
  assert.equal(stale.probe.primaryVisible, true);

  const unsupported = readinessView(status({}, { probe_supported: false, probe_available: false }));
  assert.match(unsupported.readonly.text, /無法提供可驗證的唯讀證據/);

  // Words that would claim more than was established, in any state.
  const every = [notRun, uncounted, allowed, reported, proven, stale, unsupported,
    ...UNKNOWN_REASONS.map((reason) => readinessView(status({ state: "unknown", reason, ...checked })))];
  for (const view of every) {
    const all = [view.readonly.text, view.native.text, ...(view.readonly.details || [])].join("\n");
    assert.doesNotMatch(all, /人類授權驗證尚未提供|Bridge 尚未開始工作|費用|token/i, all);
    if (view !== proven) assert.equal(view.native.text, "還不能開始原生工作：reviewer 唯讀檢查還沒通過，新的原生工作被安全鎖住。");
  }
  for (const view of [allowed, reported]) assert.doesNotMatch(view.readonly.text, /能寫入|寫入了檔案|留下了檔案/);
});

test("D2 after an unclear or failed check the paid button is put away; a retry is a second, confirmed step", async () => {
  for (const readonly of [{ state: "unknown", reason: "denial_not_evidenced", ...checked }, { state: "failed", reason: "write_allowed", ...checked, observed: noObservation }]) {
    const view = readinessView(status(readonly));
    assert.equal(view.probe.primaryVisible, false, readonly.state + ": the paid button is not shown");
    assert.equal(view.probe.retryVisible, true, readonly.state + ": the retry sits in the details");
    assert.notEqual(view.readonly.details, null);
  }
  let calls = 0;
  const run = async () => { calls += 1; return { proven: "unknown" }; };
  const asked = [];
  assert.deepEqual(await confirmedRetry((message) => { asked.push(message); return false; }, run), { sent: false });
  assert.equal(calls, 0, "cancel sends nothing");
  assert.deepEqual(asked, [RETRY_CONFIRM]);
  assert.equal(RETRY_CONFIRM, "這會再啟動一次 reviewer CLI；可能消耗模型額度，實際模型請求次數與 token 無法預先保證；不會自動重試。確定嗎？");
  const confirmed = await confirmedRetry(() => true, run);
  assert.equal(confirmed.sent, true);
  assert.equal(calls, 1, "confirm sends exactly one");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "nothing is sent again by itself");
});

// T0-11 甲 3: what the page may say when something failed, checked against what the code knows.
test("E1/E4 the reply line says no model was used only for refusals made before anything started", () => {
  for (const code of ["probe_not_started", "reviewer_not_ready", "token_rejected", "replayed_request", "invalid_body"]) {
    assert.equal(probeReplyText({ ok: false, error: code }), "檢查沒有開始，未使用模型（" + code + "）。", code);
  }
  for (const code of ["probe_failed", "internal_error", "unreadable_reply"]) {
    const line = probeReplyText({ ok: false, error: code }, { before: "t1", after: "t1" });
    assert.doesNotMatch(line, /未使用模型/, code);
    assert.equal(line, "檢查出錯，不確定有沒有啟動 reviewer CLI（" + code + "）。重新整理後沒有看到新的檢查結果。");
  }
  assert.equal(probeReplyText({ ok: false, error: "probe_failed" }, { before: "t1", after: "t2" }),
    "檢查出錯，不確定有沒有啟動 reviewer CLI（probe_failed）。重新整理後看到一次新的檢查結果，見上方。");
  assert.equal(probeReplyText({ ok: false, network: true }, { before: null, after: null }), "沒有收到回覆，不確定這次檢查有沒有開始。重新整理後沒有看到新的檢查結果。");
  assert.equal(probeReplyText({ ok: false, network: true }, { refreshed: false }), "沒有收到回覆，不確定這次檢查有沒有開始。無法讀取最新狀態。");
  assert.equal(probeReplyText({ ok: true }, { refreshed: false }), "無法讀取最新狀態。");
  assert.equal(probeReplyText({ ok: true }), "");
  assert.equal(probeReplyText({ ok: false, error: "in_flight" }), "已有一個檢查在進行中，這次沒有送出。");
});

test("E1 an error after the CLI started shows the count it knows; an unclear one shows no number", () => {
  const after = readinessView(status({ state: "unknown", reason: "probe_error_after_start", ...checked }));
  assert.match(after.readonly.text, /這次檢查啟動了 1 次 reviewer CLI（呼叫嘗試），實際模型用量不知道。/);
  assert.ok(after.readonly.details.includes("技術原因（probe_error_after_start）：檢查程式在 reviewer CLI 啟動之後出錯。"));
  const unclear = readinessView(status({ state: "unknown", reason: "probe_error_unclear", ...checked, cli_launches: null }));
  assert.doesNotMatch(unclear.readonly.text, /\d+ 次/);
  assert.ok(unclear.readonly.details.includes("不確定 reviewer CLI 有沒有啟動。"));
  for (const view of [after, unclear]) assert.doesNotMatch([view.readonly.text, ...view.readonly.details].join("\n"), /未使用模型/);
});

test("E2 without a written record there is no diagnostic id to hand over", () => {
  const failed = readinessView(status({ state: "failed", reason: "write_allowed", ...checked, diagnostic_id: null, audit_recorded: false, observed: noObservation }));
  const unknown = readinessView(status({ state: "unknown", reason: "denial_not_evidenced", ...checked, diagnostic_id: null, audit_recorded: false }));
  for (const view of [failed, unknown]) {
    const all = [view.readonly.text, ...view.readonly.details].join("\n");
    assert.doesNotMatch(all, /RBP-|請把診斷編號交給維護者/);
    assert.ok(view.readonly.details.includes("這次的紀錄沒有寫進稽核檔，沒有可查的診斷編號。"));
  }
  assert.match(failed.readonly.text, /請找維護者（這次沒有可查的診斷編號）。$/);
});

test("E3 cleanup that did not happen is said, never claimed", () => {
  const skipped = readinessView(status({ state: "unknown", reason: "timeout", ...checked, audit_cleanup: "skipped_invalid_retention" }));
  assert.ok(skipped.readonly.details.includes("bridge.json 的保留天數無效，這次沒有清理舊紀錄。"));
  const failed = readinessView(status({ state: "unknown", reason: "timeout", ...checked, audit_cleanup: "failed" }));
  assert.ok(failed.readonly.details.includes("舊紀錄這次沒有清掉。"));
  const done = readinessView(status({ state: "unknown", reason: "timeout", ...checked }));
  assert.equal(done.readonly.details.some((line) => /清/.test(line)), false, "a successful cleanup is not announced");
});

// Codex 2026-10-16: a launched CLI is an attempt; nothing on the page may say a model call happened.
test("A4 a CLI that started but returned no model result is shown as a launch with unknown model use", () => {
  for (const reason of ["invocation_error", "rate_limited", "timeout", "incomplete_run"]) {
    const view = readinessView(status({ state: "unknown", reason, ...checked, cli_launches: 1 }));
    const all = [view.readonly.text, ...view.readonly.details].join("\n");
    assert.match(view.readonly.text, /啟動了 1 次 reviewer CLI（呼叫嘗試），實際模型用量不知道/, reason);
    assert.ok(view.readonly.details.includes("reviewer CLI 啟動次數：1 次（呼叫嘗試；有沒有真的用到模型、用了多少，Bridge 不知道）。"), reason);
    assert.doesNotMatch(all, /記錄了 \d+ 次模型呼叫|模型呼叫紀錄|用了 \d+ 次模型/, reason);
  }
});

test("A4 a proof that cannot be reused says so without claiming the settings changed", () => {
  for (const reason of ["configuration_changed", "fingerprint_unavailable"]) {
    const view = readinessView(status({ state: "stale", reason, ...checked }));
    assert.equal(view.readonly.text, "先前的檢查目前無法沿用。新的原生工作被安全鎖住；需要時再檢查一次（最多啟動一次 reviewer CLI，可能消耗模型額度）。");
    assert.doesNotMatch(view.readonly.text, /變了/);
  }
  const unreadable = readinessView(status({ state: "stale", reason: "fingerprint_unavailable", ...checked }));
  assert.ok(unreadable.readonly.details.includes("技術原因（fingerprint_unavailable）：目前讀不到用來比對的設定（例如 CLI 版本暫時查不出），無法確認和檢查時相同。"));
});

// Codex 2026-10-16: the same fact before, during and after a check. Bridge bounds a check to one
// reviewer CLI launch and cannot bound the model requests inside it, so no text may promise a number
// of model calls; every warning names the launch limit and that it may use model quota.
test("A5 every page text about the cost of a check limits CLI launches and promises no number of model calls", async () => {
  const ui = new URL("../ui/", import.meta.url);
  const sources = {
    html: await fsp.readFile(new URL("watch.html", ui), "utf8"),
    page: await fsp.readFile(new URL("watch.js", ui), "utf8"),
    view: await fsp.readFile(new URL("readiness-view.js", ui), "utf8"),
  };
  for (const [name, text] of Object.entries(sources)) {
    assert.doesNotMatch(text, /最多一次模型呼叫|一次模型呼叫|會花費|將使用一次|會再用一次|會用一次|記錄了 .{0,20}次模型呼叫/, name);
  }
  const element = (id) => new RegExp('id="' + id + '"[^>]*>([^<]*(?:<strong>[^<]*</strong>[^<]*)?)<').exec(sources.html)?.[1];
  assert.equal(element("cost-notice"), "<strong>注意：</strong>每次按下最多啟動一次 reviewer CLI；可能消耗模型額度，實際模型請求次數與 token 無法預先保證；不會自動重試。Bridge 會在一個臨時空資料夾裡，請 reviewer 嘗試寫入一個檔案，並確認唯讀沙箱確實擋下。");
  for (const id of ["probe", "probe-retry"]) assert.match(element(id), /（最多啟動一次 reviewer CLI，可能消耗模型額度）$/, id);
  assert.match(sources.page, /檢查中（最多啟動一次 reviewer CLI，可能消耗模型額度），請稍候…/);
  assert.match(RETRY_CONFIRM, /實際模型請求次數與 token 無法預先保證；不會自動重試/);
  const stale = readinessView(status({ state: "stale", reason: "configuration_changed", ...checked }));
  assert.match(stale.readonly.text, /最多啟動一次 reviewer CLI，可能消耗模型額度/);
});

test("on an unverified platform the button is shown closed from the start, and the page says why", () => {
  const reason = "這個平台的 adapter 尚未驗證，reviewer 唯讀實測與原生工作在這裡不開放。";
  const view = readinessView(status({}, { platform_eligible: false, probe_available: false }));
  assert.equal(view.readonly.text, reason);
  assert.equal(view.probe.primaryVisible, true);
  assert.equal(view.probe.primaryDisabled, true);
  assert.equal(view.probe.note, "");
  assert.equal(view.native.text, reason);
  assert.equal(probeReplyText({ ok: false, error: "adapter_not_verified" }), reason + "檢查沒有開始，未使用模型。");
  // A verified platform, or a status from before this field, keeps the earlier behaviour.
  assert.equal(readinessView(status({}, { platform_eligible: true })).probe.primaryDisabled, false);
  assert.equal(readinessView(status({})).probe.primaryDisabled, false);
});
