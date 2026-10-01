# 師大影像藝術創作社 · 點名繳費收據系統 — GAS 參考設計

> 來源：2026-08 與 Luca 共同建置的社團點名收據系統
> 技術栈：GitHub Pages 靜態前端 + Google Apps Script Web App + Google Sheets + Google Drive

## 架構概覽

這是一個較重的 GAS 應用：多工作表（multi-worksheet）、身份分級費用、一次性領取碼、收據圖片上傳 Drive。若你的 GAS 專案需要類似的業務邏輯，可以復用下面的 schema 與流程。

```
社員手機簽到頁──┬
              │
幹部收款頁──┬ │ fetch(POST)
              │ │
    收據領取頁──┴ │
                  ▼
          GAS Web App (doPost)
                  │
    ┌─────────┐ │
    │ Google Sheets │ ←─┘
    └─────────┘
    members / courses / fees / staff / records
                  │
                  ▼
          Google Drive（收據圖片）
```

## Sheets Schema（5 分頁）

### members
| name | phone | email | identity | memberType | paidSemester | enrolledCourses |
|------|-------|-------|----------|------------|--------------|-----------------|
| 王小明 | 0912345678 | ... | student | semester | TRUE | |

- `identity`: `student` / `public`
- `memberType`: `semester` / `single`
- `paidSemester`: 只是初始標記，真正的學年度繳費判斷依 `records` 品名前綴
- `enrolledCourses`: 單堂社員報名的堂次，存「月/日」key 的逗號分隔串（如 `10/8,10/15`）。學期社員留空。

### courses
| date | name | receiptItem | active |
|------|------|-------------|--------|
| 2026-09-15 | 光線構圖基礎 | 單堂社課 | TRUE |

### fees
| studentSemesterFee | 1800 |
| publicSemesterFee | 3500 |
| studentSingleFee | 250 |
| publicSingleFee | 450 |
| currency | 新台幣 |

### staff
| name | password |
|------|----------|
| 社長 | 1234 |

### records
| timestamp | courseDate | courseName | name | phoneLast4 | identity | memberType | fee | paid | code | receiptItem | receiptImageUrl |

## 費用計算邏輯

```js
function calculateFee(member, course) {
  const semester = getSemesterName(course.date);

  if (member.memberType === 'semester') {
    if (hasPaidSemester(member.phone, semester)) {
      return { fee: 0, item: course.receiptItem, type: 'semester_paid' };
    }
    const fee = member.identity === 'student'
      ? config.studentSemesterFee
      : config.publicSemesterFee;
    return { fee, item: `${semester} 學期社費`, type: 'semester_first' };
  }

  const fee = member.identity === 'student'
    ? config.studentSingleFee
    : config.publicSingleFee;
  return { fee, item: course.receiptItem, type: 'single' };
}
```

## 單堂社員按堂次收費（多堂獨立）

單堂社員可能報名**複數堂**，每堂各自繳費。不能把「單堂」當成一個整體的布林狀態（繳了第一堂就永遠已繳），否則他來其他堂會被誤判免費。

關鍵：單堂是否已繳，要用「**這堂課的日期**」去比對 `records`，不是看這個人有沒有繳過任何單堂費。

```js
// 單堂社員分支
const todayKey = monthDayKey(course.date);
if (hasPaidSingleCourse(member.phone, todayKey)) {
  return { fee: 0, item: course.receiptItem, type: 'single_paid' };
}
const fee = member.identity === 'student' ? config.studentSingleFee : config.publicSingleFee;
return { fee, item: course.receiptItem, type: 'single' };

// 只比對「今天這堂課」有沒有 paid 記錄（跨堂獨立、同堂去重）
function hasPaidSingleCourse(phone, dateKey) {
  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === phoneLast4(phone) && rows[i][6] === 'single'
        && (rows[i][8] === true || rows[i][8] === 'TRUE' || rows[i][8] === 'true')
        && monthDayKey(rows[i][1]) === dateKey) return true;
  }
  return false;
}
```

附帶修正一個隱形 bug：`hasPaidSemester` 原本比對品名時讀錯欄位（讀到 `rows[i][7]` 金額欄，而非 `rows[i][10]` 品名欄），導致學期社員繳過費後每次仍被重複收費。比對語意欄位時務必對照 records 的實際欄位順序（見上方 schema），不要憑記憶猜 index。

## 學年度計算

- 9月 ~ 隔年1月 → 第 1 學期
- 2月 ~ 8月 → 第 2 學期
- 1月特殊處理：學年度往前推一年

```js
function getSemesterName(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const rocYear = year - 1911;
  const semester = (month >= 9 || month <= 1) ? 1 : 2;
  const displayYear = (month === 1) ? rocYear - 1 : rocYear;
  return `${displayYear}-${semester}`;
}
```

## 重複填表處理

以電話號碼為唯一鍵（末四碼即可）：
- 已存在 → 更新姓名/email/身份/會員類型
- 不存在 → 新增
- 已繳費狀態不會因重複填表而被覆蓋

> **識別鍵是「末四碼」，開頭 0 被刪無害。** `phoneLast4` 取電話末四位當唯一鍵，所以 Sheets 把電話當數字、自動刪掉開頭 `0`（`0912345678`→`912345678`）完全不影響簽到/定位/收款/領收據。只有未來要用「完整電話」聯絡社員時，才需把電話欄設成「純文字」格式保留開頭 0。

## Google 表單報名 → 自動搬運到 members（onFormSubmit 觸發器）

社員報名常傾向用 Google Forms（社員熟悉、免寫前端、可上傳檔案）。但 Forms 的回覆會寫進它**自己生成的「表單回覆」分頁**，不會自動進 `members`。中間需要一個「可安裝觸發器」自動搬運。

```js
// Forms 題目順序決定 e.values 欄位：第 0 欄固定是時間戳記，之後每題照順序佔一欄
// 題1=姓名 題2=電話 題3=Email 題4=身分 題5=報名類型
function onFormSubmit(e) {
  const values = e.values || [];
  const member = {
    name: String(values[1] || '').trim(),
    phone: String(values[2] || '').trim(),
    email: String(values[3] || '').trim(),
    identity: mapIdentity(values[4]),
    memberType: mapMemberType(values[5])
  };
  if (!member.name || !member.phone) return; // 缺資料不寫入，避免空列污染名單
  upsertMember(member);  // 複用現有的去重/更新邏輯
}

function mapIdentity(v) {
  const s = String(v || '').trim();
  return s.indexOf('社會') !== -1 ? 'public' : 'student';
}
function mapMemberType(v) {
  const s = String(v || '').trim();
  return s.indexOf('學期') !== -1 ? 'semester' : 'single';
}
```

關鍵要點（最容易踩雷的地方）：

- **欄位順序是鐵律**：`e.values[0]` 固定是時間戳記，之後每題照 Forms 題目順序佔一欄。題目順序一改，觸發器的 index 就要跟著改。
- **必須手動設「可安裝觸發器」，光寫函式不會生效**：Apps Script → 左邊時鐘圖示 → 新增觸發器 → 函式選 `onFormSubmit` → 事件來源「試算表」→ 事件類型「表單提交」。
- **Forms 回覆目的地要指向「現有試算表」**（就是系統那本），會在該試算表新增「表單回覆 1」分頁（別刪這個分頁）。
- **選項文字 → 系統代碼對應**：Forms 單選題回傳的是人話（「學生 / 社會人士」），觸發器要 map 成系統代碼（`student / public`），不要直接在 Forms 用英文代碼（社員看不懂）。
- **複用 upsertMember**：重複報名會更新資料而非重複建檔，也保留已繳費標記。

> **欄位漂移改建（現行做法）**：表單後來被重新設計（新增「單堂選擇」複選題、把「身份」和「方案」合併成一題），導致 `e.values[]` 全部錯位、選項文字也對不上（「學生 $1800；社會人士 $3500」這類選項沒有「學期」字樣）。現行已改用**解耦同步**：在系統試算表另建「報名同步」分頁，用 `IMPORTRANGE` 只拉 5 個特定欄（姓名/電話/email/方案/單堂選擇），再由 GAS `syncMembers()` 解析後 upsert 進 members。方案→系統代碼改由 `parsePlan()`（含「單堂」→single，否則 semester）。**身分不從學校科系欄推斷**：單堂社員的身分直接從方案文字判斷（含「社會」→public，否則 student）；學期社員的方案文字不帶身分（如「學生 $1800；社會人士 $3500」），一律預設 `student`，由幹部收款時人工驗證並手動修正 members 的 identity 欄。改表單只需改 IMPORTRANGE 的欄字母，不動後端邏輯。見 SKILL.md 的「field-index drift」一節。

## 一次性領取碼流程（自動派送版）

原始設計是「幹部口頭報 code → 社員手動輸入」。這對現場不順（口頭報容易聽錯、社員要找輸入框）。改良為**跨端輪詢自動派送**，社員完全不用聽、不用輸：

1. 社員簽到頁 `checkin.html` 顯示「需要繳費 + 等待幹部確認收款…」，同時啟動輪詢
2. 幹部收現金 → `confirmPayment` 產生 6 位碼寫入 records
3. 社員端每 3 秒 call `pollCode` 查「這組姓名+末四碼是否已有可領取的 code」
4. 查到 code → 停止輪詢，畫面自動跳出 code +「領取收據 →」按鈕
5. 按鈕跳 `receipt.html?code=XXXXXX`，該頁讀 URL 參數自動填入並直接 redeem（連輸入都不用）

### pollCode 後端動作

```js
// 社員端輪詢：查「這個末四碼是否已有幹部剛產生的 code」
function pollCode(data) {
  const member = findMemberByLast4(data.last4);
  if (!member) return jsonResponse({ status: 'error', message: '找不到報名資料' }, 404);
  if (data.name && !namesMatch(member.name, data.name)) {
    return jsonResponse({ status: 'error', message: '姓名與末四碼不符' }, 404);
  }

  const last4 = phoneLast4(member.phone);
  const rows = getSheet('records').getDataRange().getValues();
  // 從最新往回找：末四碼相符 + 已繳費 + 有 code + 未過期
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][4]) === last4 && rows[i][8] === true && rows[i][9]) {
      const ageMin = (Date.now() - new Date(rows[i][0]).getTime()) / 60000;
      if (!isNaN(ageMin) && ageMin <= 30) {
        return jsonResponse({ status: 'ok', code: String(rows[i][9]), name: rows[i][3], fee: rows[i][7] });
      }
    }
  }
  return jsonResponse({ status: 'ok', code: null }); // 還沒好，前端繼續輪詢
}
```

### 前端輪詢（checkin.html）

```js
function startPolling(name, last4) {
  let attempts = 0;
  const maxAttempts = 200; // 200 × 3 秒 = 10 分鐘後停止，避免無限輪詢
  pollTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) { clearInterval(pollTimer); pollTimer = null; /* 顯示「請洽幹部」 */ return; }
    try {
      const res = await callAPI('pollCode', { name, last4 });
      if (res.code) {
        clearInterval(pollTimer); pollTimer = null;
        // 顯示 code + <a href="receipt.html?code=${res.code}">領取收據 →</a>
      }
    } catch (e) { /* 偶發失敗（斷網）繼續等下一個週期 */ }
  }, 3000);
}
```

### 領取頁自動填入 + 自動 redeem（receipt.html）

```js
(function autoRedeemFromUrl() {
  const code = (new URLSearchParams(window.location.search).get('code') || '').trim();
  if (!/^\d{6}$/.test(code)) return;
  $('code').value = code;
  setTimeout(() => $('btnRedeem').click(), 400); // 略延遲確保事件監聽已註冊
})();
```

### 關鍵要點

- **輪詢要設上限**（如 10 分鐘），否則幹部一直沒收款，社員手機就會無限打 API 吃 quota。
- **輪詢查詢也要做姓名驗證**，否則又回到「末四碼可被遍歷」的漏洞。
- **`pollCode` 回 `code: null` 而非 error**：前端把 null 當「還沒好、繼續等」，把 error 當「真的失敗」，兩者語意不同。
- **`clearInterval` 要記 ID 並清成 null**，且 `renderResult` 開頭先清舊 timer，避免社員重複點「查詢」時疊加多個輪詢迴圈。
- **收據圖片留存**：社員 redeem 成功看到收據後，用 fire-and-forget 把 canvas `toDataURL` 上傳後端存 Drive（`.catch(()=>{})` 讓上傳失敗不影響顯示）。收據存 Drive 用「知道連結即可檢視」權限，幹部之後可從 records 分頁拿 URL 手動寄 Email 給沒帶手機的社員。

## 收據圖片上傳 Drive

```js
function uploadReceiptImage(data) {
  const base64 = data.imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/png', `receipt_${data.code}.png`);

  // ⚠️ getFoldersByName().next() 在資料夾不存在時會「拋例外」而非回傳 null，
  // 所以 `if (!folder)` 永遠執行不到（程式直接炸掉）。要用 hasNext() 判斷：
  const folders = DriveApp.getFoldersByName('師大影像社 收據');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('師大影像社 收據');

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const url = file.getDownloadUrl().replace('?download=1', '?export=view');
  // 回填 records 表
  return url;
}
```

**GAS 服務需要加入 Google Drive API v2。**

> 上傳時段性：`uploadReceiptImage` 若由「社員領收據時自動上傳」觸發，社員沒有幹部密碼，所以**不要用 `validateStaff(staffPassword)` 驗證**，改用 `findRecordByCode(data.code)`（code 本身就是一次性收據憑證）當作授權。

## 前端收據顯示：用 canvas 做預覽，不要用 DOM overlay

原先用 `<img>` 底圖 + 絕對定位 `<div class="ov">` 疊加文字時，在手機頁面很容易字過大：

- DOM overlay 的 `font-size` 是固定 px，但收據底圖會被 CSS `max-width:360px` 縮小
- 導致 36px 的文字在 360px 寬的收據上顯得比例失調

**解決方案：** 預覽和下載都用同一個 `renderReceiptCanvas()` 函數：

1. 創建 `canvas`，大小等於底圖原始尺寸（例如 826×516）
2. `drawImage()` 底圖
3. 用 `fillText()` 動態寫入名字、日期、品名、金額
4. 將 canvas 掛回頁面，用 CSS `width:100%` 縮放顯示
5. 下載時直接取 `canvas.toDataURL('image/png')`

這樣預覽與下載的比例、字級、位置完全一致。

### 合計金額位數對齊（最終版）

金額欄位為：

```
[萬] [仟] [佰] [拾] [元]
```

這裡的實作經驗有兩次轉折：

1. **不要用 `padStart(5,'0')` 填前導零**。前導零會被畫出來，看起來像「00150」。
2. **不要用 DOM overlay 做預覽**。底圖被 CSS 縮小後，固定 px 字級會變得巨大失比例。

最終做法：

```js
const feeStr = String(fee);
// 萬 / 仟 / 佰 / 拾 / 元；整組從最初的 0.315~0.675 向左移一欄，再往右移 5%
const digitX = [0.275, 0.365, 0.455, 0.545, 0.635];
const startIdx = digitX.length - feeStr.length;

// 國字數字：社團收據通常希望用大寫中文數字
const cnDigit = ['零','壹','貳','參','肆','伍','陸','柒','捌','玖'];

for (let i = 0; i < feeStr.length; i++) {
  ctx.fillText(cnDigit[parseInt(feeStr[i])], W * digitX[startIdx + i], H * 0.815);
}
```

- 150 → 使用後三欄 `[佰][拾][元]`。
- 1700 → 使用後四欄 `[仟][佰][拾][元]`，1 在仟、 7 在佰。
- 12500 → 使用全部五欄。

位數增加時整個數字塊會自動向左擴展（右對齊），同時保持個位數在「元」上方。

### 3D 空閒旋轉動畫

社員領取收據後，讓收據紙緩緩立體旋轉，增加儀式感。用 CSS animation 實現，不需要每一幀都用 JS 重繪：

```css
.receipt-wrap.idle{
  animation: idleSpin 6s ease-in-out infinite;
}
@keyframes idleSpin{
  0%,100%{ transform: rotateX(5deg) rotateY(-13deg); }
  50%{ transform: rotateX(-3deg) rotateY(13deg); }
}
```

- 初始 HTML 給 `.receipt-wrap` 加上 `idle` class。
- 顯示收據時不要移除 `idle`，讓它自動旋轉。
- 使用者開始拖曳時移除 `idle`，放手後重新加回來：

```js
function init3DTilt() {
  const wrap = document.getElementById('receiptWrap');
  let isDragging = false, startX, startY, rotX = 5, rotY = -13;

  const onMove = (x, y) => {
    const dx = x - startX;
    const dy = y - startY;
    rotY = Math.max(-30, Math.min(30, -13 + dx * 0.3));
    rotX = Math.max(-30, Math.min(30, 5 - dy * 0.3));
    wrap.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  };

  const endDrag = () => {
    isDragging = false;
    wrap.classList.add('idle');
    wrap.style.transform = '';
  };

  wrap.addEventListener('mousedown', e => {
    isDragging = true;
    wrap.classList.remove('idle');
    startX = e.clientX; startY = e.clientY;
  });
  window.addEventListener('mousemove', e => { if (isDragging) onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', endDrag);
  // touch events 同理...
}
```

### 透明印章/社章疊加（stamp overlay）

收據底圖留空的「收據專用章」欄位，可讓使用者提供去背 PNG 印章後疊上 canvas。實作要點：

```js
// 在 renderReceiptCanvas 最後（所有 fillText 之後）呼叫
await drawStamp(ctx, W * 0.82, H * 0.59, Math.min(W, H) * 0.70);

async function drawStamp(ctx, x, y, size) {
  return new Promise((resolve) => {
    const stamp = new Image();
    stamp.src = 'stamp.png';
    stamp.onload = () => {
      const aspect = stamp.naturalWidth / stamp.naturalHeight;  // 保持長寬比
      const w = size;
      const h = w / aspect;
      ctx.save();
      ctx.translate(x, y);                       // 中心定位
      ctx.rotate(-20 * Math.PI / 180);           // 傾斜 20°（逆時針）
      ctx.drawImage(stamp, -w / 2, -h / 2, w, h); // 以中心為基準繪製
      ctx.restore();
      resolve();
    };
    stamp.onerror = () => resolve();             // 圖檔載入失敗時不炸
  });
}
```

- 位置 `x,y` 用收據寬高的百分比（`W * 0.82` / `H * 0.59`），大小用 `Math.min(W,H)` 的倍率，讓印章隨收據解析度自動縮放。
- 一定要 `await` 圖檔 `onload`，否則在圖片尚未載入時就呼叫 `toDataURL()` 會得到空白印章。
- 印章 PNG 需一起 commit 到 repo（GitHub Pages 才能載到），去背用 RGBA 透明 PNG。
- 使用者常會要求反覆微調（往右 20%、放大 2.5 倍、往上 5%…）。把位置/大小/角度都寫成**單一 `drawStamp(ctx, x, y, size)` 呼叫裡的明確數字**，每次只改一個參數，改完 commit + push + 請使用者 hard-refresh，是最高效的迭代迴圈。

### 社員繳費後的導航

原本簽到頁顯示「我已取得密碼，刷新」會讓頁面重新載入，使用者不知道要去哪裡輸入 6 位 code。
改為直接提供一個「前往領取收據 →」按鈕，跳轉到 `receipt.html`：

```html
<a href="receipt.html" class="btn secondary">前往領取收據 →</a>
```

（後來進一步改成：幹部確認收款後，社員簽到頁自動輪詢到 code，直接點「領取收據」帶 `?code=` 跳轉——見上節「一次性領取碼流程（自動派送版）」。）

## 前端檔案結構

```
rollcall-system/
├── index.html          # 導覽：社員簽到 / 幹部收款 / 領取收據
├── checkin.html        # 社員簽到頁
├── admin.html          # 幹部收款、代簽、產生 code
├── receipt.html        # 輸入 code 領 3D 收據 + 下載
├── receipt-scan.jpg    # 空白收據掃描
├── ChenYuluoyan-2.0-Thin.ttf  # 手寫字體
└── .nojekyll          # 禁用 Jekyll（因為有 .gs 和 ttf 非網頁檔）
```

> **幹部專用文件（如「幹部操作手冊」manual.html）不要放進公開入口 `index.html` 的連結。** 說明書含幹部密碼、試算表維護等敏感內容，只給幹部看；保留檔案本身（幹部直接開網址或私下傳閱），但不要從社員會看到的首頁連結過去。

## 部署檢查清單

- [ ] Sheets 5 分頁建立完成
- [ ] 貼上 GAS 代碼
- [ ] 加入 Google Drive API 服務
- [ ] 部署 Web App（Execute as: Me / Access: Anyone）
- [ ] 取得 Web App URL，填入前端 `API_URL`
- [ ] repo 加 `.nojekyll` 後推上 GitHub Pages
- [ ] 稍微測試簽到→收款→領收據

## 實際部署 URL 範例

```
https://yangluca.github.io/rollcall-system/
```
