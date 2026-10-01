# HANDOFF-ADDENDUM — 師大影像藝術創作社「點名繳費收據系統」

> 交接日期：2026-10-01
> 交接方：Hermes Agent（Luca 的助理）
> 接收方：新 AI Agent（任何工具鏈）
> 文件性質：**這是交接文件，不是完工報告。** 系統有多處未經端到端驗證，第 9 節務必先讀。

## 可信度標記說明

本文件每個技術宣稱都標了可信度，請照這個排序信任：

| 標記 | 意義 |
|---|---|
| `[已驗證]` | 本次交接時**實際重跑指令**確認過（curl / grep / ls / git） |
| `[記得但不確定]` | 來自先前對話記憶，未在本次重新驗證 |
| `[推測]` | 依程式碼或現象推導，未經實測 |
| `[不知道]` | 交接方確實不知道，接手方需自行查明 |

---

## 1. 系統定位

手機優先、零成本的社團點名／繳費／電子收據系統，用來取代 Accupass/KKTIX。

核心流程：
```
社員到場 → 手機開簽到頁輸入「姓名 + 電話末四碼」
        → 系統判斷今天這堂要不要繳費
        → 要繳：到櫃檯付現，幹部在幹部頁確認收款 → 產生 6 位領取碼
        → 社員輸入該碼 → 網頁渲染出電子收據（可下載、自動留存到 Drive）
```

## 2. 技術棧與架構

```
社員手機 ─┐
          ├─→ GitHub Pages 靜態頁 ──fetch(POST, text/plain)──→ GAS Web App ──→ Google Sheets
幹部手機 ─┘                                                        │
                                                                    └──→ Google Drive（收據圖片留存）
```

- 前端：純靜態 HTML（無框架），託管 GitHub Pages
- 後端：單一 `backend.gs`（Google Apps Script Web App），`doPost` 依 `action` 路由
- 資料庫：Google Sheets（多分頁）；收據圖片存 Google Drive
- 成本：零（全在 Google 免費額度內）

## 3. 關鍵資源（接手方需要的位址）

| 項目 | 值 | 可信度 |
|---|---|---|
| GitHub repo | `https://github.com/yangluca/rollcall-system`（public） | `[已驗證]` |
| GitHub Pages 入口 | `https://yangluca.github.io/rollcall-system/` | `[已驗證]` HTTP 200 |
| GAS Web App URL | `https://script.google.com/macros/s/AKfycbyyCMJBLqtjN8rUH6i-IDOrmVyWPpTt99D1_zNDrCOwbbisi6jjlOhPEaIa6VPgV8fN/exec` | `[已驗證]` grep 自前端 + doGet HTTP 200 |
| 系統試算表 ID | `1T2PB8XloNpLS11PqYa5cUCERGTbO3R3ZBx9toL1A5Rk` | `[已驗證]` grep 自 backend.gs |
| Drive 收據資料夾 | `師大影像社 收據`（程式自動建立/尋找） | `[已驗證]` backend.gs:657 |
| 表單回覆試算表 ID | `[不知道]` — 未記錄，需問 Luca | `[不知道]` |
| 幹部密碼 | `[不知道]` — 存在 `staff` 分頁，請勿寫入任何文件 | `[不知道]` |
| 試算表共用權限設定 | `[不知道]` — 交接方未查（Luca 先前說曾設為「限制」） | `[不知道]` |

**重要架構事實**：`backend.gs` 是綁在**系統試算表**的 Apps Script 專案；「表單提交」觸發器無法設在這支（系統表沒綁表單），見第 9 節。

## 4. 專案檔案清單

`[已驗證]` 2026-10-01 盤點：

| 檔案 | 大小 | 用途 | 最後修改 |
|---|---|---|---|
| `backend.gs` | 25 KB | GAS 後端（全部 API） | 09-18 |
| `index.html` | 2.7 KB | 入口頁（社員簽到／幹部收款／領取收據 三卡） | 09-17 |
| `checkin.html` | 8.6 KB | 社員簽到頁 | 08-31 |
| `admin.html` | 11 KB | 幹部收款頁（末四碼定位、確認收款、產生 code） | 08-30 |
| `receipt.html` | 12 KB | 收據領取頁（canvas 渲染 + 3D 傾斜） | 08-31 |
| `manual.html` | 13 KB | 幹部操作手冊（**已從 index 移除入口，檔案保留**） | 08-30 |
| `design-preview.html` | 15 KB | 早期手機 UI 原型（參考用，非線上流程） | 08-30 |
| `receipt-3d-demo.html`、`receipt-3d-final.html`、`receipt-overlay-demo.html` | 4-7 KB | 收據視覺實驗殘檔（**線上流程未使用**） | 08-29 |
| `receipt-scan.jpg` | 185 KB | 收據底圖（826×516 掃描） | 08-29 |
| `stamp.png` | 216 KB | 社團章去背圖（579×431） | 08-30 |
| `ChenYuluoyan-2.0-Thin.ttf` | 9.5 MB | 辰宇落雁 Thin 手寫字體 | 08-29 |
| `.nojekyll` | 0 | 關閉 GitHub Pages 的 Jekyll | 08-30 |

## 5. Google Sheets Schema

`[已驗證]` 自 backend.gs 程式碼：

### members（7 欄）
`name | phone | email | identity | memberType | paidSemester | enrolledCourses`

- `identity`: `student` / `public`
- `memberType`: `single`（單堂）/ `semester`（學期）
- `paidSemester`: 初始標記。真正的學期繳費判斷靠 `records` 品名前綴，**不靠這欄**
- `enrolledCourses`: 單堂社員報名的堂次，「月/日」逗號分隔（如 `10/8,10/15`）。學期社員留空

### courses
`date | name | receiptItem | active`

- `date` 支援民國年（≤200 自動 +1911）或西元
- `active` 為真者，且日期等於**今天**，才會被 `getActiveCourse()` 選中 → 一天只開一堂簽到

### fees（key-value 兩欄）
`[已驗證]` 程式讀取鍵名：`studentSemesterFee` / `publicSemesterFee` / `studentSingleFee` / `publicSingleFee`

`[記得但不確定]` 目前值應為：學期 1800（學生）/ 3500（社會）；單堂 250（學生）/ 450（社會）。
⚠️ **接手方請自行讀取試算表確認**，先前的 1700/3200 已通知 Luca 更新，但交接方未實際讀表驗證。

### staff
`name | password`

### records（12 欄）
`timestamp | courseDate | courseName | name | phoneLast4 | identity | memberType | fee | paid | code | receiptItem | receiptImageUrl`

> ⚠️ **欄位順序是陷阱**：`[7]` 是 fee（金額）、`[10]` 才是 receiptItem（品名）。曾有一個 bug 就是比對品名時誤讀 `[7]`，詳見第 8 節。

### 報名同步（新增，5 欄）
由 `IMPORTRANGE` 從表單回覆表拉過來，**不是手寫的**：
`姓名 | 電話 | email | 方案 | 單堂選擇`

1. 對應表單回覆表欄位：姓名=C、電話=E、email=D、方案=H、單堂選擇=K
2. 第 1 列是標題，程式從第 2 列開始讀
3. ⚠️ **不要在這分頁手動加資料** — IMPORTRANGE 是動態陣列，手動填的格子會讓它展開時報 `#REF!`

## 6. API 動作清單

`[已驗證]` `doPost` 的 switch 支援 10 個 action：

| action | 用途 |
|---|---|
| `submitForm` | 報名表單提交（寫入/更新 member） |
| `lookup` | 用電話查社員 + 算今日費用 |
| `checkin` | 社員自助簽到（姓名+末四碼驗證） |
| `manualCheckin` | 幹部代簽到（社員沒帶手機） |
| `locate` | 幹部用末四碼定位社員 |
| `confirm` | 幹部確認收款 → 產生 6 位 code |
| `redeem` | 社員用 code 領收據 |
| `history` | 查歷史收據 |
| `uploadReceiptImage` | 收據圖片上傳 Drive（以 code 驗證） |
| `pollCode` | 社員端輪詢是否有新 code（**目前前端未使用**，見第 9 節） |

另有非 API 入口：
- `doGet` — 健康檢查，回 `{status:'ok'}`
- `syncMembers()` — 從「報名同步」分頁解析寫入 members
- `fixPaidSemesterColumn()` — 一次性修復函式（見第 7 節）
- `onFormSubmit()` — 相容舊觸發器的入口，現在只轉呼叫 `syncMembers()`

## 7. 本次工作期（2026-09）的重要改動

依 commit 時序（`[已驗證]` git log）：

| commit | 內容 |
|---|---|
| `4ff266b` | **按堂次收費**：單堂社員改為「用今天這堂課的日期」判斷是否已繳（跨堂獨立、同堂去重）；新增 `monthDayKey` / `parseEnrolledDates` / `hasPaidSingleCourse` / `parsePlan`；**修 `hasPaidSemester` 讀錯欄位的 bug** |
| `bccf2cb` | 移除學期社員身分的自動猜測（改人工驗證）；index 移除手冊入口 |
| `31642ed` | **修 `upsertMember` 覆蓋 paidSemester 欄的 bug**；新增一次性修復函式 `fixPaidSemesterColumn` |

### 改動 1：單堂社員「按堂次」收費（核心修正）

**問題**：單堂社員可能報名複數堂，每堂各自繳費。原本「單堂」被當成一個整體布林狀態，無法判斷「這一堂」繳過沒。

**解法**：用「月/日」當統一 key，比對三邊資料：

| 來源 | 原始格式 | 統一成 |
|---|---|---|
| 表單「單堂選擇」 | `10/08（四）｜張碩尹` | `10/8` |
| courses 表 | `2026-10-08` | `10/8` |
| records 表 | `2026-10-08` | `10/8` |

`calculateFee()` 單堂分支 → `hasPaidSingleCourse(phone, monthDayKey(course.date))`。

**解析非結構化文字的方式**（接手方理解重點）：
1. `parseEnrolledDates`：先按逗號（全形／半形）切開
2. 每段用正規式 `(\d{1,2})\/(\d{1,2})` 抓「月/日」，忽略 `（四）｜講師` 等雜訊
3. `parseInt` 去前導零統一格式

> ⚠️ **前提**：每堂課都以「月/日」開頭、且課程名不含「數字/數字」。若日後改表單日期格式（例如改成「10月8日」），這兩個函式必須跟著改。

### 改動 2：修 `hasPaidSemester` 讀錯欄位

原程式讀 `rows[i][7]`（fee 金額欄）來比對品名，導致學期社員繳過費後**每次仍被重複收費**。改讀 `rows[i][10]`（receiptItem 品名欄）。

### 改動 3：修 `upsertMember` 覆蓋 paidSemester

原「更新」路徑用 `setValues` 寫 6 欄，把 `enrolledCourses` 塞進第 6 欄（paidSemester 的位置），造成單堂社員的 F 欄被堂次日期污染、G 欄反而沒更新。

**已修**：更新時只寫 A~E（姓名/電話/email/身分/類型）+ 獨立寫 G（報名堂次），**F 欄完全不碰**。
**已備**：`fixPaidSemesterColumn()` 一次性清掉已被污染的 F 欄（只清 `memberType === 'single'` 的列）。

### 改動 4：報名同步架構（表單與系統分離）

Luca 要求「表單與系統分離、只同步特定欄位」，所以**放棄**原本的 `onFormSubmit` 直接搬運，改成：

```
表單回覆表（獨立）──IMPORTRANGE 拉 5 欄──→ 系統表「報名同步」分頁──syncMembers()──→ members
```

- 觸發方式：Apps Script 時間驅動觸發器（建議每天），或手動執行 `syncMembers`
- `syncMembers` 只做 upsert（新增/更新），**不會刪除** members 內手動加的資料

### 改動 5：收據旋轉幅度 +20%

`receipt.html` idle 動畫：週期 6s→5s、Y 軸 ±13°→±15.6°、X 軸 5°~-3°→6°~-3.6°。

## 8. 關鍵設計決策與原因

| 決策 | 原因 |
|---|---|
| 身份辨識用「姓名 + 電話末四碼」 | 跨校／社會人士通用；不用 email |
| 末四碼 + 姓名雙重驗證 | 防末四碼被暴力遍歷洩漏個資 |
| 幹部密碼失敗 5 次鎖 10 分鐘 | 防暴力破解（`CacheService` 實作，`[已驗證]` backend.gs:761） |
| 收據 code 為 **6 位數字**、30 分鐘過期 | `[已驗證]` `generateCode` = 100000~999999；`ageMin > 30` 失效 |
| 收據交付：幹部口頭報 code、社員手動輸入 | 自動輪詢版本不穩定，已回滾（見第 9 節） |
| 收據圖片自動上傳 Drive、權限「知道連結可檢視」 | 幹部可事後手動寄 email，不自動寄信 |
| 學期社員身分**不自動判斷** | 表單的學期選項不區分學生/社會，從「學校科系」欄猜不可靠 → 改人工驗證 |
| Sheets 分頁：members/courses/fees/staff/records + 報名同步 | 見第 5 節 |

### 收據視覺參數（`[已驗證]` receipt.html）

- 文字色 `#2b4a9e`（藍筆墨水）；字體 ChenYuluoyan Thin
- 姓名位置 W 22% / H 11%；日期（民國年）W 68.5% / H 13%
- 合計金額國字大寫，位數右對齊，X 位置 `[0.245, 0.335, 0.425, 0.515, 0.605]`，Y 81.5%
- 社章：W 82% / H 59%、大小 `min(W,H) * 0.70`、旋轉 -20°
- idle 3D 旋轉：5s 循環、`rotateX(6deg) rotateY(-15.6deg)` ↔ `rotateX(-3.6deg) rotateY(15.6deg)`

## 9. ⚠️ 未解決問題、待驗證、已知風險（**接手方最先讀這裡**）

依風險排序：

### 🔴 R1：整條主流程從未端到端驗證
`[記得但不確定]` 簽到 → 繳費 → 產生 code → 領收據，**沒有一次完整的真機測試紀錄**。各環節分別做過靜態檢查，但從未串起來跑過一次真實流程。**接手方第一件事應該是走一遍完整流程並記錄結果。**

### 🔴 R2：`syncMembers` / 報名同步尚未驗證成功
`[記得但不確定]` Luca 在 09-17~09-18 期間設定了 IMPORTRANGE 與觸發器，但：
- 交接方**沒有讀過試算表**確認「報名同步」分頁是否真的拉到資料
- `syncMembers` 是否成功寫入 members`[不知道]`
- 從 Luca 的一張截圖得知：members 的 F 欄（paidSemester）曾被堂次資料污染 → 已修程式並提供 `fixPaidSemesterColumn()`，但**該修復函式尚未確認執行過**

### 🟠 R3：`fixPaidSemesterColumn()` 待執行
`[記得但不確定]` 交接時剛交付此函式，Luca 尚未回報執行結果。若未執行，members 的 F 欄仍有髒資料（不影響收費判斷，因為真正的學期判斷走 records，但會誤導人工閱讀）。

### 🟠 R4：`pollCode` 自動顯示 code 機制已停用但程式仍在
`[已驗證]` 後端仍有 `pollCode` action（含診斷 debug 輸出），但前端 `checkin.html` 已改回**手動輸入 6 位碼**。原因：自動輪詢版本一直沒能成功運作（前端等不到 code），Luca 決定回滾。
- 接手方若要重啟此功能，需先找出當時失敗的根因（`[不知道]`：可能是 records 欄位對不上、或 `paid` 欄位型別）
- `pollCode` 的 debug 輸出會把 records 最後 3 筆的末四碼/paid/code 回傳給前端，**正式上線前建議移除**

### 🟡 R5：學期社員身分需人工驗證
`[已驗證]` `parsePlan` 對學期社員一律回傳 `identity: 'student'`。若實際是社會人士，**會被收 1800 而非 3500**。Luca 需在 members 表人工改 `identity` 欄。
- 已知需確認的案例：`黃彥霖`（表單「學校科系」欄只寫「影音製作」，看不出身分）

### 🟡 R6：fees 價格是否已更新未驗證
`[不知道]` 程式讀的是試算表 `fees` 分頁，交接方未讀表。若仍是 1700/3200，學期費會收錯。**接手方請直接讀取確認。**

### 🟡 R7：收據「紙質毛邊」嘗試失敗並回滾
`[已驗證]` commit `4e608d7`→`0c42809`，共 6 次嘗試全部失敗（Luca 回報「沒有任何改變」「整張紙變色」「裁到收據內容」），最後 `receipt.html` 已還原到未加毛邊的狀態。
- **不要再重複這條路**：在 canvas 上畫毛邊的路徑已證明效果不佳；若要做，改用 CSS `clip-path` 或預先做好帶毛邊的底圖素材。

### 🟡 R8：電話開頭 0 會被 Sheets 吃掉
`[推測]` Sheets 把電話當數字，`0912345678` → `912345678`。
- **不影響系統**：辨識只用末四碼（`phoneLast4` 取後四位），開頭 0 在第一位，兩者無關
- 僅影響「用完整電話聯絡社員」的場景；解法是把電話欄格式設為「純文字」

### ⚪ R9：`manual.html` 內容已過時
`[推測]` 手冊寫於 08-30，內含舊價格（1700/3200）與舊的 `onFormSubmit` 說明，未隨架構更新。

## 10. 被否決／回滾的實驗

| 實驗 | 結果 | commit 範圍 |
|---|---|---|
| 收據紙質毛邊（6 次嘗試） | ❌ 全部失敗，回滾 | `4e608d7` → `0c42809` |
| 幹部確認後社員端自動顯示 code（pollCode 輪詢） | ⚠️ 未成功，回滾成手動輸入 | `cd84bc1` → `46bc0f2` |
| 收據 code 改成 8 位 | ⚠️ 回滾成 6 位 | `184628f` → `ee2e655` |
| 學期社員身分自動判斷（從學校科系欄猜） | ❌ 不可靠，改人工 | `bccf2cb` |

## 11. 環境事實（本機 = Luca 的 Mac）

`[已驗證]` 2026-10-01 實測：

| 項目 | 值 |
|---|---|
| OS | macOS 15.3.2 |
| Node | v24.11.0 |
| Python | 3.12.7（PEP 668 環境，裝套件需 venv/uv） |
| 專案路徑 | `/Users/yangtzping/rollcall-system/` |
| git 狀態 | working tree clean，與 origin/main 同步 |
| GitHub Pages | 4 頁面皆 HTTP 200 |
| GAS Web App | doGet HTTP 200 |

**Automations audit**（`[已驗證]`，確認轉移期間無衝突）：
- `~/Library/LaunchAgents/`：有 `ai.hermes.gateway`、`com.hermes.ngrok-line`、`com.hermes.opencode-proxy`、opencode-quota 兩支等 — **全部與本專案無關**
- Hermes cron jobs（3 個）：OpenCode Go 用量 ×2、每日晨報 — **全部與本專案無關**
- 本專案無任何本機排程；自動化全在 Google 端（Apps Script 觸發器）。**接手方若換機器，本機無需重建任何排程**

> ⚠️ 環境事實是「Luca 的 Mac」的，接手方若在別的機器工作，這些都要重新確認。

## 12. Asset Map — 專案資料夾外的累積知識

`[已驗證]` 以下檔案在**專案資料夾外**，新 Agent 不會自動繼承，建議一併複製到專案內：

| 路徑 | 大小 | 內容 |
|---|---|---|
| `~/.hermes/skills/software-development/gas-backend/references/rollcall-receipt-system.md` | 20 KB | ⭐ **最重要**：本系統的完整參考設計（schema、費用邏輯、按堂次收費、學年度計算） |
| `~/.hermes/skills/software-development/gas-backend/references/gas-security-hardening.md` | 4.5 KB | GAS 資安強化（密碼鎖定、末四碼遍歷防護） |
| `~/.hermes/skills/software-development/gas-backend/references/gas-webapp-debugging.md` | 8.5 KB | GAS Web App 除錯經驗 |
| `~/.hermes/skills/software-development/gas-backend/references/github-pages-deployment.md` | 1.1 KB | GitHub Pages 部署步驟 |
| `~/.hermes/skills/software-development/gas-backend/references/rollcall-code-delivery-log.md` | 2.4 KB | 程式交付紀錄 |
| `~/.hermes/plans/2026-08-29-rollcall-system.md` | 8.5 KB | 原始實作計畫（含鎖定的設計決策表） |

## 13. 交接方建議的第一步

1. **先讀** `~/.hermes/skills/.../rollcall-receipt-system.md`（本系統的完整設計）
2. **先問 Luca** 三件事：① 表單回覆試算表 URL ② 執行 `fixPaidSemesterColumn` 了沒 ③ fees 價格更新了沒
3. **再做一次完整流程實測**（R1）：用測試 member 走一遍「簽到 → 繳費 → 領收據」

---

## 交接摘要（≤5 行）

已交付：完整專案檔案（GitHub，working tree clean）、10 個 API 的 GAS 後端、5+1 分頁 Sheets schema、收據 canvas 視覺參數，以及本文件與 `HERMES-MEMORY.md`。
**未驗證的關鍵項**：整條主流程從未端到端實測（R1）、報名同步是否成功未確認（R2）、修復函式待執行（R3）；以上皆標 `[記得但不確定]` 或 `[不知道]`，請勿當成已完成。
**接手方第一個動作**：向 Luca 索取表單回覆試算表 URL，並實測一次完整的「簽到→繳費→領收據」流程。
**最大的坑**：`records` 分頁欄位順序（`[7]` 是金額、`[10]` 才是品名）曾造成隱形 bug；「報名同步」分頁不能手動加資料（會被 IMPORTRANGE 覆蓋報錯）。
