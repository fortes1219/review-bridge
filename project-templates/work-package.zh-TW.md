---
# 要接著跑：放進 work-packages/ 底下同一個子目錄，檔名用 01-、02- 開頭。
# 每一個 key 都可以不寫；用不到的就刪掉。這裡以外的 key 會被拒絕。
# priority: medium        # low / medium / high / urgent；照 policy 的表決定模型和 effort
# writer: { model: gpt-5.6-sol, effort: high }   # 蓋過 priority 的表；model 要是 writer 那個 CLI 的
# reviewer: { model: opus, effort: medium }       # 蓋過 priority 的表；model 要是 reviewer 那個 CLI 的
# budget:                 # 每一項都可以不寫；每一項只能比 policy 的上限小
#   tokens: 2000000
#   tokens_per_call: 150000
#   call_timeout: 1200000 # 毫秒
#   test_timeout: 600000  # 毫秒
#   run_timeout: 7200000  # 毫秒
#   rounds: 2
# source_id: SHOP-412     # 你自己系統的單號；Bridge 只存不讀
---
# 【一句話說明這次的工作】

> 複製這個檔，填你需要的區塊，用不到的整塊刪掉。每個區塊從它的 `<!-- bridge:... -->` 那一行開始，到下一個標記為止；Bridge 會照原文放進合約裡同名的欄位。`##` 小標題是給人看的，用什麼語言都可以，Bridge 不讀。執行開工指令時，就是授權這張工單當下的內容。

<!-- bridge:context -->
## 背景與現況
【現在發生什麼事？為什麼這次要處理？】

<!-- bridge:outcome -->
## 期待的結果
【做完之後，使用者會看到什麼、能做什麼？】

<!-- bridge:requested_work -->
## 要做的事
【這次要改什麼、交出什麼？段落、清單、圖片連結或表格都可以。】

<!-- bridge:run_plan -->
## 執行計畫（兩個以上的 run 才需要；只有一件工作就讓這塊空著）

<!-- bridge:scope_notes.include -->
## 包含
【這次涵蓋的情境或工作】

<!-- bridge:scope_notes.exclude -->
## 不包含
【這次明確不處理的事】

<!-- bridge:scope_notes.must_keep -->
## 必須維持
【不能壞掉的既有行為、相容性、權限或資料規則】

<!-- bridge:scope_notes.expected_locations -->
## 可能會動到的位置（只是參考，不代表授權修改）
【已知可能會改到的檔案或模組】

<!-- bridge:acceptance -->
## 驗收（寫不出來就整塊刪掉，Bridge 會提幾組讓你選）
1. 【結果一，寫清楚適用的情境或限制】
2. 【結果二，寫清楚適用的情境或限制】

<!-- bridge:verification_hints -->
## 驗證提示（實際跑哪個測試指令，由 Bridge 依安裝的規則決定）
【可以試的操作流程、測試資料、預期畫面或既有測試名稱】

<!-- bridge:reproduction.environment -->
## 缺陷：環境
【裝置、作業系統、瀏覽器、產品版本】

<!-- bridge:reproduction.steps -->
## 缺陷：重現步驟
1. 【第一步】

<!-- bridge:reproduction.actual -->
## 缺陷：實際結果
【現在看到什麼】

<!-- bridge:reproduction.expected -->
## 缺陷：預期結果
【應該是什麼】

<!-- bridge:reproduction.frequency -->
## 缺陷：頻率與影響
【多常發生、影響到誰】

<!-- bridge:references -->
## 參考資料、附件與相依
- 【連結、路徑、設計稿、相關工單】

<!-- bridge:open_questions -->
## 待決問題（沒有就寫「無」；其他每一行都是一個問題，工作會停下來等你回答）
無
