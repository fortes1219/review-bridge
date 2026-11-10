---
description: Review Bridge 0.3.0-rc.3 的已知問題、四種可能中斷執行的情況，以及手動停止與重新執行的方法。
---

# 已知問題

## 0.3.0-rc.3：工作中斷後，紀錄仍可能顯示執行中

`start` 會在啟動它的終端機或 agent 工具裡以前景執行。如果啟動它的程序在工作中途被終止，實際工作可能已經停了，Bridge 的紀錄卻仍把這次 run 列為執行中。

writer 已寫入的改動會留在磁碟上，Bridge 不會自動重跑。你需要先用 `stop <run_id>` 結束這次執行，再用 `resume <run_id>` 重新執行。**在你手動 `stop` 之前，`down` 會拒絕關閉。**

### 哪些情況會中斷工作

- **agent 的指令執行工具逾時。** Claude Code 的 Bash 工具預設兩分鐘就會終止指令，最長十分鐘；兩輪 writer 加上測試，往往會超過這個時間。請拉長指令的逾時設定，或讓指令在背景執行，再等待結果檔。Codex 的 exec 工具也有自己的時間上限。
- **關閉正在執行 `start` 的終端機或 VS Code 視窗。** 單張工單的 `start` 期間按 Ctrl+C，也會結束指令，但 run 可能仍繼續執行。
- **電腦睡眠、關機或當機。** 工作可能在 Bridge 結束這次執行紀錄之前就中斷。
- **工作還在跑就安裝新版本。** `npx` 會原地替換快取中的程式。更新前請先讓工作結束，或手動停止，再執行 `npx review-bridge down`。

### 如何恢復

在專案目錄執行以下指令。先用 `status` 找到 run ID，停止該次執行，再重新執行：

```sh
npx review-bridge status
npx review-bridge stop <run_id>
npx review-bridge resume <run_id>
```

把 `<run_id>` 換成 `status` 顯示的 ID。`resume` 會建立新的執行，顯示授權卡片，等你同意後才開始；不會自動重跑剛才中斷的工作。詳見[開工](./guide/start)。

如果要先更新版本，請在 `stop` 後執行 `npx review-bridge down`，更新完成再 `resume`。`down` 不會替你結束仍被列為執行中的 run。

### 下個 patch 會修正什麼

**下個 patch 版會加入已中斷 run 的自動偵測。** 0.3.0-rc.3 還沒有這項功能，目前仍需照上面的步驟手動處理。

其他限制見[發行紀錄](./release-notes)。
