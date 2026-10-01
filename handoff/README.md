# 交接包索引 — 師大影像藝術創作社「點名繳費收據系統」

給接手本專案的 AI Agent。**請依序閱讀**：

| 順序 | 檔案 | 內容 |
|---|---|---|
| 1 | `HANDOFF-ADDENDUM.md` | 主文件：系統架構、資源位址、API、本次改動、**風險清單（第 9 節必讀）**、環境、asset map |
| 2 | `HERMES-MEMORY.md` | 專案事實、Luca 的偏好、**明確未知清單（你必須自行查明的 12 項）** |
| 3 | `references/rollcall-receipt-system.md` | ⭐ 系統的完整參考設計（schema、費用邏輯、按堂次收費） |
| 4 | `references/*.md` | GAS 資安強化、Web App 除錯、GitHub Pages 部署、交付紀錄 |
| 5 | `original-plan/2026-08-29-rollcall-system.md` | 專案原始實作計畫（含鎖定的設計決策） |

## 30 秒讀完版

- 系統**已上線但未驗收**：零件都寫好、靜態檢查都過，但主流程從未端到端實測過一次。
- 你的第一個動作：向 Luca 索取「表單回覆試算表 URL」，並實測一次完整流程。
- 最大的兩個坑：① `records` 分頁欄位順序（`[7]` 是金額、`[10]` 才是品名）② 「報名同步」分頁不能手動加資料。
- 已被試過並失敗的路（別重蹈）：收據紙質毛邊（6 次）、自動顯示領取碼輪詢。

## 專案本體

程式碼在上一層目錄（`../`），GitHub：`https://github.com/yangluca/rollcall-system`

> ⚠️ 本資料夾含內部資訊與個人資料，**請勿提交到公開 repo**。
