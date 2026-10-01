# 師大影像藝術創作社 · 點名繳費收據系統 — 實作計畫 v2

> 狀態：設計完成，待實作
> 建立：2026-08-29
> 實作方式：Hermes 規劃 → OpenCode TDD 實作

---

## 0. 已確定的設計決策（鎖定，不可再變）

| 項目 | 決策 |
|------|------|
| 身份辨識 | 姓名 + 電話末四碼（跨校/社會人士通用） |
| 簽到 | 社員自助（手機）輸入姓名 + 末四碼 |
| 代簽到 | 幹部後台手動代簽到（社員沒帶手機） |
| 繳費定位 | 幹部輸入末四碼定位 |
| 收款確認 | 幹部點「確認收款」→ 生成收據編號 + 6 位一次性 code |
| 收據交付 | 幹部口頭報 code，社員輸入領取 |
| email | 系統生成收據圖片寫入 Sheets，幹部手動 Gmail 寄 |
| 收據底圖 | 真實「免用統一發票收據」掃描（receipt-scan.jpg） |
| 收據字體 | 辰宇落雁 Thin（ChenYuluoyan-2.0-Thin.ttf） |
| 收據顏色 | 藍筆墨水 #2b4a9e |
| 年月日 | 民國年（114） |
| 統一編號 | 8 格留空（不印） |
| 商號地址 | 不填 |
| 收據專用章 | 圖檔之後補，先留空 |
| 品名 | 「單堂社課」，未來依課程表動態填入 |
| 社團名稱 | 師大影像藝術創作社 |
| UI | BDFM 白極簡（Space Grotesk），mobile-first |
| 技術 | GitHub Pages + Google Apps Script + Google Sheets（零成本） |

---

## 1. 系統架構

```
社員手機 ─┐
          ├─→ GitHub Pages 靜態頁 ──fetch──→ Apps Script ──→ Google Sheets
幹部手機 ─┘                                      │
                                                  └──→ Google Drive（收據圖片）
```

- 前端兩頁：`index.html`（社員）、`admin.html`（幹部）
- 後端：單一 Code.gs，`doPost` 依 `action` 路由
- 收據圖片：前端 canvas 渲染 → base64 → GAS 存 Drive

---

## 2. Google Sheets 結構（5 分頁）

### ① `報名名單`（Google Form 自動寫入，唯讀）
| A | B | C | D | E | F |
|---|---|---|---|---|---|
| 時間戳記 | 姓名 | 電話 | Email | 身分類別 | 報名堂次 |

- 身分類別：`學期社員` 或 `單堂社員`

### ② `課程表`（幹部維護）
| A | B | C | D |
|---|---|---|---|
| 堂次 | 日期 | 課程名稱 | 時間 |

### ③ `社費設定`（幹部維護）
| A | B |
|---|---|
| 項目 | 金額 |
| 學期社費 | （幹部填） |
| 單堂社費 | （幹部填） |

### ④ `幹部密碼`（幹部維護）
| A |
|---|
| （一組密碼，幹部自訂） |

### ⑤ `簽到繳費紀錄`（系統自動寫入）
| A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 堂次 | 日期 | 姓名 | 末四碼 | 身分類別 | 簽到時間 | 繳費金額 | 繳費方式 | 收據編號 | code | code狀態 | 收據圖片URL |

- code狀態：`未領取` / `已領取`
- 收據編號格式：`R-{堂次}-{3位序號}`，例 `R-04-007`

---

## 3. Apps Script 後端（Code.gs）

### 3.1 路由骨架

```javascript
const SHEET_ID = 'YOUR_SHEET_ID';   // 部署時填入

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = body.action;
  try {
    let result;
    switch (action) {
      case 'lookup':         result = lookup(body); break;
      case 'checkin':        result = checkin(body); break;
      case 'manualCheckin':  result = manualCheckin(body); break;
      case 'locate':         result = locate(body); break;
      case 'confirm':        result = confirm(body); break;
      case 'redeem':         result = redeem(body); break;
      case 'uploadReceipt':  result = uploadReceipt(body); break;
      default: result = { ok: false, error: 'unknown action' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

### 3.2 每個動作的規格

| 動作 | 輸入 | 輸出 | 邏輯 |
|------|------|------|------|
| `lookup` | name, last4 | 身分、應繳金額、是否已繳 | 查報名名單 → 算應繳金額 |
| `checkin` | name, last4 | ok / error | 寫入⑤，狀態未繳 |
| `manualCheckin` | name, last4, 密碼 | ok / error | 幹部代簽到，驗密碼 |
| `locate` | last4, 密碼 | 該員資料 | 查⑤已簽到未繳，驗密碼 |
| `confirm` | 簽到ID, 金額, 方式, 密碼 | 收據編號 + code | 生成編號+code，寫入⑤ |
| `redeem` | code | 收據內容 | 驗code → 回傳 → 標記已領取 |
| `uploadReceipt` | base64, 收據編號 | 圖片URL | 存Drive，寫URL到⑤ |

### 3.3 費用規則（核心）

```javascript
function calcAmount(身分類別, name, last4, 堂次) {
  if (身分類別 === '學期社員') {
    // 查此人是否已有「學期社費」繳費紀錄
    const paid = 查⑤是否有此人學期社費紀錄(name, last4);
    return paid ? 0 : 學期社費金額;
  } else { // 單堂社員
    const paid = 查⑤此人本堂是否已繳(name, last4, 堂次);
    return paid ? 0 : 單堂社費金額;
  }
}
```

不硬編「前三堂」邏輯，靠「身分類別 + 繳費紀錄」自動判斷。

### 3.4 收據編號與 code 生成

```javascript
function genReceiptNo(堂次) {
  // 查⑤當堂最大序號 + 1，格式 R-{堂次}-{序號}
}
function genCode() {
  // 6 位隨機數字，確保當天不撞號
}
```

---

## 4. 前端頁面

### 4.1 index.html（社員頁，mobile-first）

三種狀態（單頁切換）：
1. **簽到**：社團名 + 當堂資訊卡（堂次/日期/時間）+ 姓名輸入 + 末四碼輸入 + 「簽到」黑按鈕
2. **簽到結果**：姓名大字 + 身分標籤 + 應繳金額大字 + 「確認簽到」
3. **領收據**：輸入 6 位 code → 「領取」→ 顯示 3D 收據（真實掃描 + 手寫藍字 + 拖曳旋轉）

### 4.2 admin.html（幹部頁，密碼保護）

1. **登入**：密碼輸入 + 登入
2. **主畫面**：目前堂次（可切換）+ 待繳費名單 + 末四碼快速定位輸入 + 「手動簽到」入口
3. **確認收款**：名字 + 金額 + 繳費方式（現金/轉帳）+ 「確認收款」大按鈕
4. **收款完成**：6 位 code 大字（口頭報給社員）+ 收據編號 + 「寄送 Email」按鈕

### 4.3 收據渲染（動態文字定位，已定稿）

收據掃描尺寸 826×516，文字用百分比定位：

| 欄位 | left | top | 字號 |
|------|------|-----|------|
| 姓名 | 22% | 11% | 36px |
| 年 | 68.5% | 13% | 22px |
| 月 | 79% | 13% | 22px |
| 日 | 90% | 13% | 22px |
| 品名 | 9% | 28% | 26px |
| 數量 | 35% | 28% | 26px |
| 單價 | 44.5% | 28% | 26px |
| 總價 | 57% | 28% | 26px |
| 合計佰 | 42% | 81.5% | 26px |
| 合計拾 | 51% | 81.5% | 26px |
| 合計元 | 60% | 81.5% | 26px |

- 字體：辰宇落雁 Thin，顏色 #2b4a9e
- 合計的萬、仟位留空（金額 < 1000）
- 參考實作檔：`receipt-3d-final.html`（已含完整 3D 旋轉 + 定位）

---

## 5. 收據圖片生成（email 用）

```
幹部確認收款 → 前端 canvas 渲染收據（掃描圖 + 文字）→ toDataURL → base64
→ POST uploadReceipt → GAS 存 Drive → 回傳 URL → 寫入⑤收據圖片URL
→ 幹部從 Sheets 點開圖片，手動 Gmail 寄給社員
```

---

## 6. 部署步驟

1. 建 Sheets 5 分頁，填入 SHEET_ID
2. 開 Apps Script，貼 Code.gs，部署 Web App（任何人可存取）
3. 前端把 API_URL 改成 GAS 部署 URL
4. 前端推到 GitHub Pages（`yangluca.github.io/rollcall/`）
5. 端到端驗證：簽到 → 繳費 → 領收據

---

## 7. 分階段任務

### Phase 1（MVP — 先跑通核心）
1. Sheets 5 分頁 + SHEET_ID
2. Code.gs 後端 7 動作（不含 uploadReceipt）
3. index.html 社員頁（簽到 + 領收據 + 3D 收據）
4. admin.html 幹部頁（登入 + 定位 + 收款 + code）
5. 端到端驗證

### Phase 2
6. 收據圖片生成 + uploadReceipt + Drive
7. code 防呆（撞號/重領/過期）

### Phase 3
8. 對帳儀表板（收入/欠繳/出席率）
9. 收據專用章圖檔套入

---

## 8. 待補參數（不卡 Phase 1）

1. 學期社費、單堂社費金額（幹部在③填）
2. 繳費方式選項（暫定現金/轉帳）
3. 收據專用章圖檔（之後給）
4. SHEET_ID（建 Sheets 時取得）
