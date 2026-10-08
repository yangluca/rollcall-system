/**
 * 師大影像藝術創作社 · 點名繳費收據系統
 * Google Apps Script 後端
 *
 * v2.0（2026-10-08）重點：
 * 1. 電話正規化 normalizePhone：0912345678 / 912345678 / 0912-345-678 / +886 912345678 都能對到同一人
 * 2. 修復 asText 單引號 bug：經 API 寫入的 "'" 前綴會變字面值，導致 pollCode / 歷史收據 / 防重複簽到全部比對失敗
 * 3. 收據 code 不再設 30 分鐘期限，社員端改為輪詢自動跳轉
 * 4. 新 API：roster / walkin / updateMember / markAttendance / addNote / courseStats / finance
 * 5. 單堂轉學期全額折抵（calculateFee 內建）
 */

// ============ 設定 ============
const SPREADSHEET_ID = '1T2PB8XloNpLS11PqYa5cUCERGTbO3R3ZBx9toL1A5Rk';
const SHEET_NAMES = {
  MEMBERS: 'members',
  COURSES: 'courses',
  FEES: 'fees',
  STAFF: 'staff',
  RECORDS: 'records',
  SYNC: '報名同步',
  ATTENDANCE: 'attendance'
};

// members 欄位：A name | B phone | C email | D identity | E memberType | F paidSemester | G enrolledCourses | H locked | I note
// records 欄位：A timestamp | B courseDate | C courseName | D name | E phoneLast4 | F identity | G memberType | H fee | I paid | J code | K receiptItem | L receiptImageUrl | M note
// attendance 欄位：A timestamp | B courseDate | C courseName | D name | E phoneLast4 | F memberType | G identity | H note

// ============ Web App 入口 ============
function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Rollcall API is running', version: '2.0' });
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');
  const action = data.action;

  try {
    switch (action) {
      case 'submitForm':
        return submitForm(data);
      case 'lookup':
        return lookupMember(data);
      case 'checkin':
        return checkin(data);
      case 'manualCheckin':
        return manualCheckin(data);
      case 'locate':
        return locateMember(data);
      case 'confirm':
        return confirmPayment(data);
      case 'redeem':
        return redeemReceipt(data);
      case 'history':
        return getHistory(data);
      case 'uploadReceiptImage':
        return uploadReceiptImage(data);
      case 'pollCode':
        return pollCode(data);
      case 'syncNow':
        return syncNowAction(data);
      // v2.0 新增
      case 'roster':
        return roster(data);
      case 'walkin':
        return walkin(data);
      case 'updateMember':
        return updateMember(data);
      case 'markAttendance':
        return markAttendance(data);
      case 'addNote':
        return addNote(data);
      case 'courseStats':
        return courseStats(data);
      case 'finance':
        return finance(data);
      default:
        return jsonResponse({ status: 'error', message: '未知動作: ' + action }, 400);
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message }, 500);
  }
}

// ============ 工具函數 ============
function jsonResponse(payload, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
  // GAS TextOutput 不支援 setHttpCode，狀態碼通過回傳 payload.status 表示
  return output;
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

// 取得分頁，不存在就自動建立（可帶標題列）
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function getConfig() {
  const sheet = getSheet(SHEET_NAMES.FEES);
  const data = sheet.getDataRange().getValues();
  const config = {};
  for (let i = 0; i < data.length; i++) {
    config[data[i][0]] = data[i][1];
  }
  return config;
}

function getActiveCourse() {
  const sheet = getSheet(SHEET_NAMES.COURSES);
  const rows = sheet.getDataRange().getValues();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const date = row[0];
    const active = row[3];

    const activeVal = (active === true || active === 'TRUE' || active === 'true' || active === 1);
    if (!date || !activeVal) continue;

    const courseDate = parseDateValue(date);
    if (!courseDate) continue;
    courseDate.setHours(0, 0, 0, 0);

    if (courseDate.getTime() === today.getTime()) {
      return {
        date: formatDate(courseDate),
        name: row[1],
        receiptItem: row[2]
      };
    }
  }
  return null;
}

// 解析課程日期：自動辨識民國年（≤200 視為民國年，+1911 轉西元）
// 支援格式：115/8/30、2026/8/30、2026-08-30、或 Sheets 日期物件
function parseDateValue(raw) {
  if (!raw) return null;
  let d;
  if (raw instanceof Date) {
    d = new Date(raw.getTime());
  } else {
    d = new Date(String(raw).replace(/^'/, '')); // 去掉可能殘留的 asText 單引號
  }
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() <= 200) {
    d.setFullYear(d.getFullYear() + 1911);
  }
  return d;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getSemesterName(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const rocYear = year - 1911;

  // 9月~隔年1月 = 第一學期；2月~8月 = 第二學期
  const semester = (month >= 9 || month <= 1) ? 1 : 2;

  // 若是1月，學年度算前一年
  const displayYear = (month === 1) ? rocYear - 1 : rocYear;
  return `${displayYear}-${semester}`;
}

function phoneLast4(phone) {
  const s = String(phone == null ? '' : phone).replace(/\D/g, '');
  return s.slice(-4);
}

// 電話正規化：只留數字 → 去 886 國碼 → 去開頭 0 → 台灣手機 9 碼
// 0912345678 → 912345678
// 912345678 → 912345678
// 0912-345-678 → 912345678
// +886 912345678 → 912345678
// （也相容 Sheets 把開頭 0 吃掉後的 912345678 數字、以及 asText 殘留的單引號）
function normalizePhone(p) {
  let d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.indexOf('886') === 0 && d.length >= 11) d = d.slice(3);
  while (d.charAt(0) === '0' && d.length > 9) d = d.slice(1);
  return d;
}

// 電話比對：輸入 ≥9 碼時全碼比對；不足 9 碼（例如末四碼）用末碼比對
function phonesMatch(stored, input) {
  const a = normalizePhone(stored);
  const b = normalizePhone(input);
  if (!a || !b) return false;
  if (b.length >= 9) return a === b;
  return a.slice(-b.length) === b;
}

// 寫入 members 用的電話格式：統一成 10 碼「0xxxxxxxxx」字串
// （欄位格式由 setupV2 設為純文字，不再用 asText 單引號——API 寫入時單引號會變字面值）
function phoneToStore(p) {
  const n = normalizePhone(p);
  if (n.length === 9) return '0' + n;
  return String(p == null ? '' : p).trim();
}

// 寬鬆的真值判斷（Sheets 讀回可能是 boolean / 'TRUE' / 1 / 'Y'）
function isTrue(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'Y' || s === 'YES';
}

// 姓名比對：去空白、轉小寫後比較（防末四碼被遍歷時需同時知道姓名）
function namesMatch(a, b) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
  return norm(a) === norm(b) && norm(a) !== '';
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ============ 社員查找 ============
function rowToMember(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    name: row[0],
    phone: row[1],
    email: row[2],
    identity: row[3] || 'student',
    memberType: row[4] || 'single',
    paidSemester: isTrue(row[5]),
    enrolledCourses: row[6] || '',
    locked: isTrue(row[7]),
    note: row[8] || ''
  };
}

function findMemberByPhone(phone) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (phonesMatch(rows[i][1], phone)) {
      return rowToMember(rows[i], i + 1);
    }
  }
  return null;
}

function findMemberByLast4(last4) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();
  const target = phoneLast4(last4);

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][1]) === target) {
      return rowToMember(rows[i], i + 1);
    }
  }
  return null;
}

// 幹部操作用：名單回傳的 rowIndex 直接定位（避免末四碼撞號收錯人）
function findMemberByRow(rowIndex) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const idx = parseInt(rowIndex, 10);
  if (!idx || idx < 2 || idx > sheet.getLastRow()) return null;
  const row = sheet.getRange(idx, 1, 1, 9).getValues()[0];
  if (!row[0] && !row[1]) return null;
  return rowToMember(row, idx);
}

// 幹部操作時的社員定位：優先 rowIndex → 全電話 → 末四碼
function resolveMember(data) {
  if (data.rowIndex) {
    const m = findMemberByRow(data.rowIndex);
    if (m) return m;
  }
  if (data.phone) return findMemberByPhone(data.phone);
  if (data.last4) return findMemberByLast4(data.last4);
  return null;
}

// ============ 費用計算 ============
// 一次讀取 records，避免名單模式逐人重讀試算表
function buildFeeContext() {
  return {
    config: getConfig(),
    recordRows: getSheet(SHEET_NAMES.RECORDS).getDataRange().getValues()
  };
}

function calculateFee(member, course, ctx) {
  ctx = ctx || buildFeeContext();
  const config = ctx.config;
  const semester = getSemesterName(course.date);

  if (member.memberType === 'semester') {
    // 學期社員：今學年度已繳費了嗎？
    if (hasPaidSemester(member.phone, semester, ctx.recordRows)) {
      return { fee: 0, item: course.receiptItem, type: 'semester_paid', credit: 0 };
    }
    const fullFee = Number(member.identity === 'student' ? config.studentSemesterFee : config.publicSemesterFee) || 0;
    // 單堂轉學期：本學期已繳的單堂費全額折抵
    const credit = singleCourseCredit(member.phone, semester, ctx.recordRows);
    const fee = Math.max(0, fullFee - credit);
    const item = credit > 0 ? `${semester} 學期社費（已折抵單堂 $${credit}）` : `${semester} 學期社費`;
    return { fee: fee, item: item, type: 'semester_first', credit: credit };
  } else {
    // 單堂社員：今天這堂課是否已繳過費？（跨堂獨立、同堂去重）
    const todayKey = monthDayKey(course.date);
    if (hasPaidSingleCourse(member.phone, todayKey, ctx.recordRows)) {
      return { fee: 0, item: course.receiptItem, type: 'single_paid', credit: 0 };
    }
    const fee = Number(member.identity === 'student' ? config.studentSingleFee : config.publicSingleFee) || 0;
    return { fee: fee, item: course.receiptItem, type: 'single', credit: 0 };
  }
}

function hasPaidSemester(phone, semester, recordRows) {
  const rows = recordRows || getSheet(SHEET_NAMES.RECORDS).getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === phoneLast4(phone) && rows[i][6] === 'semester') {
      // 有學期費繳費紀錄，再看「品名」([10]) 是否同學年度
      const item = String(rows[i][10] || '');
      if (item.indexOf(semester) !== -1) return true;
    }
  }
  return false;
}

// 單堂社員：判斷「今天這堂課」是否已繳費（用月/日比對，跨堂獨立、同堂去重）
function hasPaidSingleCourse(phone, dateKey, recordRows) {
  const rows = recordRows || getSheet(SHEET_NAMES.RECORDS).getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === phoneLast4(phone) && rows[i][6] === 'single') {
      const paid = isTrue(rows[i][8]);
      if (paid && monthDayKey(rows[i][1]) === dateKey) return true;
    }
  }
  return false;
}

// 本學期已繳的單堂費總額（單堂轉學期時全額折抵用）
function singleCourseCredit(phone, semester, recordRows) {
  const rows = recordRows || getSheet(SHEET_NAMES.RECORDS).getDataRange().getValues();
  let sum = 0;

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === phoneLast4(phone) && rows[i][6] === 'single' && isTrue(rows[i][8])) {
      const d = parseDateValue(rows[i][1]);
      if (d && getSemesterName(d) === semester) {
        sum += Number(rows[i][7]) || 0;
      }
    }
  }
  return sum;
}

// 各種日期格式統一成「月/日」（無前導零），例如 10/8、12/3
// 支援：「2026-10-08」（formatDate）、「10/08（四）｜…」（報名堂次）、Date 物件、殘留單引號
function monthDayKey(input) {
  if (input instanceof Date) {
    return `${input.getMonth() + 1}/${input.getDate()}`;
  }
  const s = String(input || '').replace(/^'/, '').trim();
  let m = s.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${parseInt(m[1])}/${parseInt(m[2])}`;
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${parseInt(m[2])}/${parseInt(m[3])}`;
  return s;
}

// 解析報名表「單堂選擇」欄（複選，逗號分隔），回傳「月/日」key 陣列
function parseEnrolledDates(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const keys = [];
  const parts = s.split(/[,，]/);
  for (const p of parts) {
    const k = monthDayKey(p);
    if (k && k.indexOf('/') !== -1) keys.push(k);
  }
  return keys;
}

// 合併兩串「月/日」堂次：聯集、去重、按日期排序
function mergeEnrolled(oldStr, newStr) {
  const seen = {};
  const add = s => {
    String(s || '').split(/[,，]/).forEach(x => {
      const k = x.trim();
      if (k && k.indexOf('/') !== -1) seen[k] = true;
    });
  };
  add(oldStr);
  add(newStr);
  const keys = Object.keys(seen);
  keys.sort((a, b) => {
    const pa = a.split('/').map(Number);
    const pb = b.split('/').map(Number);
    return (pa[0] * 100 + pa[1]) - (pb[0] * 100 + pb[1]);
  });
  return keys.join(',');
}

function upsertMember(member) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const existing = findMemberByPhone(member.phone);

  if (existing) {
    // 更新姓名/電話/email/身分/類型（A~E），保留 paidSemester（F 欄）不動
    sheet.getRange(existing.rowIndex, 1, 1, 5).setValues([[
      member.name,
      phoneToStore(member.phone),
      member.email,
      member.identity,
      member.memberType
    ]]);
    // 更新報名堂次（G 欄）
    sheet.getRange(existing.rowIndex, 7).setValue(member.enrolledCourses || '');
    return { action: 'updated', rowIndex: existing.rowIndex };
  } else {
    // 新增
    const newRow = [
      member.name,
      phoneToStore(member.phone),
      member.email,
      member.identity,
      member.memberType,
      false,
      member.enrolledCourses || ''
    ];
    sheet.appendRow(newRow);
    return { action: 'created' };
  }
}

// 一次性修復：先前 bug 把「報名堂次」誤寫進單堂社員的 paidSemester（F 欄），
// 執行方式：Apps Script 編輯器 → 選 fixPaidSemesterColumn → 執行一次即可
function fixPaidSemesterColumn() {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();
  let fixed = 0;
  for (let i = 1; i < rows.length; i++) {
    // 單堂社員不會有學期費標記：F 欄一律清為 false
    if (rows[i][4] === 'single' && rows[i][5] !== false && rows[i][5] !== 'FALSE' && rows[i][5] !== 'false') {
      sheet.getRange(i + 1, 6).setValue(false);
      fixed++;
    }
  }
  return jsonResponse({ status: 'ok', fixed: fixed });
}

// ============ 繳費紀錄（records）============
function addRecord(record) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  sheet.appendRow([
    new Date(),
    record.courseDate,
    record.courseName,
    record.name,
    phoneLast4(record.phoneLast4 || record.phone),
    record.identity,
    record.memberType,
    record.fee,
    record.paid,
    record.code || '',
    record.receiptItem || '',
    record.receiptImageUrl || '',
    record.note || ''
  ]);
}

// 用 code 找紀錄：從最新往回找（code 為隨機 6 位，只取最新一筆避免歷史碰撞）
function findRecordByCode(code) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();

  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][9]) === String(code)) {
      return {
        rowIndex: i + 1,
        timestamp: rows[i][0],
        courseDate: rows[i][1],
        courseName: rows[i][2],
        name: rows[i][3],
        phoneLast4: rows[i][4],
        identity: rows[i][5],
        memberType: rows[i][6],
        fee: rows[i][7],
        paid: isTrue(rows[i][8]),
        code: rows[i][9],
        receiptItem: rows[i][10],
        receiptImageUrl: rows[i][11],
        note: rows[i][12] || ''
      };
    }
  }
  return null;
}

function getMemberHistory(last4) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();
  const history = [];
  const target = phoneLast4(last4);

  for (let i = 1; i < rows.length; i++) {
    // 讀取端一律用 phoneLast4 正規化（相容 asText 單引號殘留的舊資料）
    if (phoneLast4(rows[i][4]) === target && isTrue(rows[i][8]) && rows[i][9]) {
      history.push({
        courseDate: rows[i][1],
        courseName: rows[i][2],
        name: rows[i][3],
        fee: rows[i][7],
        receiptItem: rows[i][10],
        code: String(rows[i][9])
      });
    }
  }
  return history.sort((a, b) => new Date(b.courseDate) - new Date(a.courseDate));
}

// ============ 出席紀錄（與繳費紀錄分離）============
// records 只放「繳費／收據」資料，避免簽到紀錄污染對帳；
// 「誰來過」記在 attendance。
const ATTENDANCE_HEADERS = ['timestamp', 'courseDate', 'courseName', 'name', 'phoneLast4', 'memberType', 'identity', 'note'];

function addAttendance(rec) {
  const sheet = getOrCreateSheet(SHEET_NAMES.ATTENDANCE, ATTENDANCE_HEADERS);
  sheet.appendRow([
    new Date(),
    rec.courseDate,
    rec.courseName,
    rec.name,
    phoneLast4(rec.phoneLast4 || rec.phone),
    rec.memberType,
    rec.identity,
    rec.note || ''
  ]);
}

// 同一個人同一堂是否已有出席紀錄（避免重複簽到產生多筆）
function hasAttendance(last4, courseDate) {
  const sheet = getSheet(SHEET_NAMES.ATTENDANCE);
  if (!sheet) return false;
  const rows = sheet.getDataRange().getValues();
  const key = monthDayKey(courseDate);
  const target = phoneLast4(last4);
  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === target && monthDayKey(rows[i][1]) === key) return true;
  }
  return false;
}

// ============ API 動作 ============

// 1. 報名表單提交（重複填表自動更新）
function submitForm(data) {
  const member = {
    name: data.name,
    phone: data.phone,
    email: data.email,
    identity: data.identity || 'student',
    memberType: data.memberType || 'single',
    enrolledCourses: data.enrolledCourses || ''
  };

  const result = upsertMember(member);
  return jsonResponse({ status: 'ok', action: result.action });
}

// 2. 社員簽到查詢
function lookupMember(data) {
  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByPhone(data.phone);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料，請先填寫報名表單' }, 404);
  }

  const feeInfo = calculateFee(member, course);
  const history = getMemberHistory(phoneLast4(member.phone));

  return jsonResponse({
    status: 'ok',
    member: {
      name: member.name,
      identity: member.identity,
      memberType: member.memberType,
      phoneLast4: phoneLast4(member.phone)
    },
    course: course,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    feeType: feeInfo.type,
    history: history
  });
}

// 3. 社員簽到（只寫入未繳費紀錄，不產生 code）
// v2.0：支援全電話（data.phone，正規化比對），相容舊的末四碼（data.last4）
function checkin(data) {
  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  let member = data.phone ? findMemberByPhone(data.phone) : findMemberByLast4(data.last4);
  if (!member && tryAutoSync()) {
    // 可能是剛填完報名表單的人 → 即時同步一次再查（現場臨時報名情境）
    member = data.phone ? findMemberByPhone(data.phone) : findMemberByLast4(data.last4);
  }
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料，請先填寫報名表單' }, 404);
  }

  // 姓名雙重驗證：電話之外，還需姓名相符（防電話打錯查到別人）
  if (data.name && !namesMatch(member.name, data.name)) {
    return jsonResponse({ status: 'error', message: '姓名與電話不符，請確認報名資料' }, 404);
  }

  const feeInfo = calculateFee(member, course);

  // 若需繳費，不寫入紀錄（等幹部收款後才寫）
  if (feeInfo.fee > 0) {
    return jsonResponse({
      status: 'ok',
      checkedIn: false,
      needPayment: true,
      name: member.name,
      course: course,
      fee: feeInfo.fee,
      receiptItem: feeInfo.item,
      message: '請到櫃檯繳費，幹部確認後此頁面會自動跳轉收據'
    });
  }

  // 已繳費（學期社員已繳、或單堂已繳過這堂）→ 記出席，不寫入繳費紀錄
  const l4 = phoneLast4(member.phone);
  if (!hasAttendance(l4, course.date)) {
    addAttendance({
      courseDate: course.date,
      courseName: course.name,
      name: member.name,
      phoneLast4: l4,
      memberType: member.memberType,
      identity: member.identity
    });
  }

  const history = getMemberHistory(l4);

  return jsonResponse({
    status: 'ok',
    checkedIn: true,
    needPayment: false,
    fee: 0,
    history: history,
    message: '簽到成功，本堂無需繳費'
  });
}

// 4. 幹部手動代簽到
function manualCheckin(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByPhone(data.phone);
  if (!member) {
    // 沒有報名也可以代簽，先建檔
    upsertMember({
      name: data.name,
      phone: data.phone,
      email: data.email || '',
      identity: data.identity || 'student',
      memberType: data.memberType || 'single'
    });
  }

  return checkin({ name: data.name, phone: data.phone });
}

// 5. 幹部用末四碼定位社員（保留相容；新後台主要用 roster + rowIndex）
function locateMember(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = resolveMember(data);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該社員的報名資料' }, 404);
  }

  const feeInfo = calculateFee(member, course);

  return jsonResponse({
    status: 'ok',
    member: {
      rowIndex: member.rowIndex,
      name: member.name,
      identity: member.identity,
      memberType: member.memberType,
      phoneLast4: phoneLast4(member.phone),
      paidSemester: member.paidSemester
    },
    course: course,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    feeType: feeInfo.type,
    credit: feeInfo.credit
  });
}

// 6. 幹部確認收款，產生 code（同時記出席）
function confirmPayment(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = resolveMember(data);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該社員的報名資料' }, 404);
  }

  const feeInfo = calculateFee(member, course);
  const code = generateCode();

  // 若是學期社費，標記 members 表的 paidSemester
  if (feeInfo.type === 'semester_first') {
    const sheet = getSheet(SHEET_NAMES.MEMBERS);
    sheet.getRange(member.rowIndex, 6).setValue(true);
  }

  addRecord({
    courseDate: course.date,
    courseName: course.name,
    name: member.name,
    phoneLast4: phoneLast4(member.phone),
    identity: member.identity,
    memberType: member.memberType,
    fee: feeInfo.fee,
    paid: true,
    receiptItem: feeInfo.item,
    code: code,
    note: data.note || ''
  });

  // 收款完成同時記出席
  const l4 = phoneLast4(member.phone);
  if (!hasAttendance(l4, course.date)) {
    addAttendance({
      courseDate: course.date,
      courseName: course.name,
      name: member.name,
      phoneLast4: l4,
      memberType: member.memberType,
      identity: member.identity
    });
  }

  return jsonResponse({
    status: 'ok',
    code: code,
    memberName: member.name,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    credit: feeInfo.credit
  });
}

// 7. 社員輸入 code 領收據（v2.0：不再設 30 分鐘期限，可隨時補領）
function redeemReceipt(data) {
  const record = findRecordByCode(data.code);
  if (!record) {
    return jsonResponse({ status: 'error', message: '無效的收據密碼' }, 404);
  }

  if (!record.paid) {
    return jsonResponse({ status: 'error', message: '此密碼尚未完成繳費' }, 400);
  }

  return jsonResponse({
    status: 'ok',
    receipt: {
      name: record.name,
      courseDate: record.courseDate,
      courseName: record.courseName,
      receiptItem: record.receiptItem,
      fee: record.fee,
      code: record.code,
      imageUrl: record.receiptImageUrl
    }
  });
}

// 8. 查詢歷史收據
function getHistory(data) {
  const member = findMemberByPhone(data.phone);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料' }, 404);
  }

  const history = getMemberHistory(phoneLast4(member.phone));
  return jsonResponse({ status: 'ok', history: history });
}

// 9. 上傳收據圖片到 Google Drive（社員領收據時自動留存，用 code 驗證）
function uploadReceiptImage(data) {
  const record = findRecordByCode(data.code);
  if (!record) {
    return jsonResponse({ status: 'error', message: '找不到該筆繳費紀錄' }, 404);
  }

  const base64 = data.imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/png', `receipt_${data.code}.png`);

  // 在 Drive 根目錄建立/找到 "師大影像社 收據" 資料夾
  const folders = DriveApp.getFoldersByName('師大影像社 收據');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('師大影像社 收據');

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const url = file.getDownloadUrl().replace('?download=1', '?export=view');

  // 回填 records 表
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  sheet.getRange(record.rowIndex, 12).setValue(url);

  return jsonResponse({ status: 'ok', imageUrl: url });
}

// 10. 社員端輪詢：幹部確認收款後，社員頁面自動拿到 code 跳轉收據
// v2.0 修復：比對一律用 phoneLast4 正規化（舊資料殘留單引號也能對到）；
// 只認「今天這堂」的繳費紀錄（code 不設期限後，避免跳到歷史收據）
function pollCode(data) {
  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = data.phone ? findMemberByPhone(data.phone) : findMemberByLast4(data.last4);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料' }, 404);
  }
  if (data.name && !namesMatch(member.name, data.name)) {
    return jsonResponse({ status: 'error', message: '姓名與電話不符' }, 404);
  }

  const l4 = phoneLast4(member.phone);
  const todayKey = monthDayKey(course.date);
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();

  // 從最新往回找：末四碼相符 + 已繳費 + 有 code + 今天這堂
  for (let i = rows.length - 1; i >= 1; i--) {
    if (phoneLast4(rows[i][4]) === l4 && isTrue(rows[i][8]) && rows[i][9]
        && monthDayKey(rows[i][1]) === todayKey) {
      return jsonResponse({
        status: 'ok',
        code: String(rows[i][9]),
        name: rows[i][3],
        fee: rows[i][7]
      });
    }
  }

  return jsonResponse({ status: 'ok', code: null });
}

// ============ v2.0 新 API：幹部後台 ============

// 11. 今日名單：登入後直接顯示，含今日應繳金額、繳費/簽到狀態
function roster(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const ctx = buildFeeContext();
  const todayKey = monthDayKey(course.date);

  // 一次讀 attendance，建立今日已簽到的末四碼集合
  const attendedSet = {};
  const attSheet = getSheet(SHEET_NAMES.ATTENDANCE);
  if (attSheet) {
    const aRows = attSheet.getDataRange().getValues();
    for (let i = 1; i < aRows.length; i++) {
      if (monthDayKey(aRows[i][1]) === todayKey) {
        attendedSet[phoneLast4(aRows[i][4])] = true;
      }
    }
  }

  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();
  const list = [];

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0] && !rows[i][1]) continue;
    const member = rowToMember(rows[i], i + 1);
    const enrolledKeys = parseEnrolledDates(member.enrolledCourses);
    // 今日相關：學期社員全體 ＋ 單堂有報今天堂次的人
    const relevant = member.memberType === 'semester' || enrolledKeys.indexOf(todayKey) !== -1;
    const feeInfo = calculateFee(member, course, ctx);
    const l4 = phoneLast4(member.phone);

    list.push({
      rowIndex: member.rowIndex,
      name: member.name,
      phoneLast4: l4,
      identity: member.identity,
      memberType: member.memberType,
      fee: feeInfo.fee,
      feeType: feeInfo.type,
      receiptItem: feeInfo.item,
      credit: feeInfo.credit,
      attended: !!attendedSet[l4],
      relevant: relevant,
      enrolledCourses: member.enrolledCourses,
      note: member.note
    });
  }

  // 排序：今日相關優先 → 單堂在學期前 → 未繳費優先 → 姓名
  list.sort((a, b) => {
    if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
    if (a.memberType !== b.memberType) return a.memberType === 'single' ? -1 : 1;
    const aUnpaid = a.fee > 0 ? 0 : 1;
    const bUnpaid = b.fee > 0 ? 0 : 1;
    if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid;
    return String(a.name).localeCompare(String(b.name), 'zh-Hant');
  });

  return jsonResponse({
    status: 'ok',
    staff: staff.name,
    course: course,
    todayKey: todayKey,
    members: list
  });
}

// 12. 現場報名＋報到一條龍：建檔/更新 → 回傳今日費用，接著用 confirm 收款
function walkin(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const name = String(data.name || '').trim();
  const phoneNorm = normalizePhone(data.phone);
  const identity = data.identity === 'public' ? 'public' : 'student';
  const memberType = data.memberType === 'semester' ? 'semester' : 'single';

  if (!name || phoneNorm.length < 9) {
    return jsonResponse({ status: 'error', message: '請輸入姓名與完整電話（10 碼）' }, 400);
  }

  const todayKey = monthDayKey(course.date);
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  let member = findMemberByPhone(data.phone);

  if (member) {
    // 舊社員：以現場資料為準更新，設手動鎖定（避免 syncMembers 用表單舊值蓋回）
    let enrolled = member.enrolledCourses;
    if (memberType === 'single') {
      enrolled = mergeEnrolled(enrolled, todayKey);
    } else {
      enrolled = ''; // 學期涵蓋全部，堂次清空
    }
    sheet.getRange(member.rowIndex, 1, 1, 8).setValues([[
      name,
      phoneToStore(data.phone),
      member.email,
      identity,
      memberType,
      member.paidSemester,
      enrolled,
      true // locked
    ]]);
    member = findMemberByRow(member.rowIndex);
  } else {
    // 新社員建檔（單堂自動把今天加進報名堂次）
    const enrolled = memberType === 'single' ? todayKey : '';
    sheet.appendRow([
      name,
      phoneToStore(data.phone),
      '',
      identity,
      memberType,
      false,
      enrolled,
      true, // locked
      ''    // note
    ]);
    member = findMemberByPhone(data.phone);
  }

  const feeInfo = calculateFee(member, course);

  return jsonResponse({
    status: 'ok',
    member: {
      rowIndex: member.rowIndex,
      name: member.name,
      identity: member.identity,
      memberType: member.memberType,
      phoneLast4: phoneLast4(member.phone)
    },
    course: course,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    feeType: feeInfo.type,
    credit: feeInfo.credit
  });
}

// 13. 變更社員資料：身份（學生/社會）、類型（單堂/學期）
// 變更後設手動鎖定；回傳新費用（單堂轉學期自動折抵本學期已繳單堂費）
function updateMember(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = resolveMember(data);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該社員' }, 404);
  }

  const oldType = member.memberType;
  const oldIdentity = member.identity;
  const identity = (data.identity === 'public' || data.identity === 'student') ? data.identity : oldIdentity;
  const memberType = (data.memberType === 'semester' || data.memberType === 'single') ? data.memberType : oldType;
  const todayKey = monthDayKey(course.date);

  let enrolled = member.enrolledCourses;
  if (memberType === 'single' && oldType !== 'single') {
    // 學期轉單堂：至少保留今天這堂
    enrolled = mergeEnrolled(enrolled, todayKey);
  } else if (memberType === 'semester') {
    enrolled = ''; // 學期涵蓋全部
  }
  // 單堂社員「加收今天這堂」（報了別場、今天突然出現）：把今天加入報名堂次
  if (data.addToday && memberType === 'single') {
    enrolled = mergeEnrolled(enrolled, todayKey);
  }

  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  sheet.getRange(member.rowIndex, 1, 1, 8).setValues([[
    member.name,
    phoneToStore(member.phone),
    member.email,
    identity,
    memberType,
    member.paidSemester,
    enrolled,
    true // locked：幹部手動改過，syncMembers 不再用表單值覆蓋
  ]]);

  const updated = findMemberByRow(member.rowIndex);
  const feeInfo = calculateFee(updated, course);

  // 學期轉單堂：已繳學期費的退費由幹部現場人工處理，系統不動舊紀錄
  const refundHint = (oldType === 'semester' && memberType === 'single')
    ? '注意：此社員原為學期社員，若已繳學期費，退費差額請現場人工處理並加備注。'
    : '';

  return jsonResponse({
    status: 'ok',
    member: {
      rowIndex: updated.rowIndex,
      name: updated.name,
      identity: updated.identity,
      memberType: updated.memberType,
      phoneLast4: phoneLast4(updated.phone)
    },
    changed: {
      identity: oldIdentity !== identity,
      memberType: oldType !== memberType
    },
    course: course,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    feeType: feeInfo.type,
    credit: feeInfo.credit,
    refundHint: refundHint
  });
}

// 14. 補簽到（免繳費或已繳費社員，幹部直接記出席）
function markAttendance(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = resolveMember(data);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該社員' }, 404);
  }

  const l4 = phoneLast4(member.phone);
  if (hasAttendance(l4, course.date)) {
    return jsonResponse({ status: 'ok', already: true, message: member.name + ' 今天已簽到過' });
  }

  addAttendance({
    courseDate: course.date,
    courseName: course.name,
    name: member.name,
    phoneLast4: l4,
    memberType: member.memberType,
    identity: member.identity
  });

  return jsonResponse({ status: 'ok', already: false, message: member.name + ' 簽到完成' });
}

// 15. 備注：scope = member（跟著人，members I 欄）/ attendance（今日出席，H 欄）/ record（繳費紀錄，M 欄，用 code 定位）
function addNote(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const note = String(data.note || '').trim();
  if (!note) {
    return jsonResponse({ status: 'error', message: '備注內容不可為空' }, 400);
  }

  const scope = data.scope || 'member';

  if (scope === 'record') {
    const record = findRecordByCode(data.code);
    if (!record) {
      return jsonResponse({ status: 'error', message: '找不到該筆繳費紀錄' }, 404);
    }
    const recSheet = getSheet(SHEET_NAMES.RECORDS);
    const existing = String(record.note || '').trim();
    recSheet.getRange(record.rowIndex, 13).setValue(existing ? existing + '；' + note : note);
    return jsonResponse({ status: 'ok', scope: scope });
  }

  if (scope === 'attendance') {
    const course = getActiveCourse();
    if (!course) {
      return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
    }
    const member = resolveMember(data);
    if (!member) {
      return jsonResponse({ status: 'error', message: '找不到該社員' }, 404);
    }
    const l4 = phoneLast4(member.phone);
    const todayKey = monthDayKey(course.date);
    const attSheet = getSheet(SHEET_NAMES.ATTENDANCE);
    if (!attSheet) {
      return jsonResponse({ status: 'error', message: '尚無出席紀錄' }, 404);
    }
    const rows = attSheet.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      if (phoneLast4(rows[i][4]) === l4 && monthDayKey(rows[i][1]) === todayKey) {
        const existing = String(rows[i][7] || '').trim();
        attSheet.getRange(i + 1, 8).setValue(existing ? existing + '；' + note : note);
        return jsonResponse({ status: 'ok', scope: scope });
      }
    }
    return jsonResponse({ status: 'error', message: '該社員今天尚無出席紀錄，請改用「社員備注」' }, 404);
  }

  // scope === 'member'
  const member = resolveMember(data);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該社員' }, 404);
  }
  const memSheet = getSheet(SHEET_NAMES.MEMBERS);
  const existing = String(member.note || '').trim();
  memSheet.getRange(member.rowIndex, 9).setValue(existing ? existing + '；' + note : note);
  return jsonResponse({ status: 'ok', scope: scope });
}

// 16. 本堂報名情形：應到、已到、未繳費名單、本堂收入
function courseStats(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const ctx = buildFeeContext();
  const todayKey = monthDayKey(course.date);

  // 今日出席
  const attended = [];
  const attendedSet = {};
  const attSheet = getSheet(SHEET_NAMES.ATTENDANCE);
  if (attSheet) {
    const aRows = attSheet.getDataRange().getValues();
    for (let i = 1; i < aRows.length; i++) {
      if (monthDayKey(aRows[i][1]) === todayKey) {
        attended.push({ time: aRows[i][0], name: aRows[i][3], phoneLast4: phoneLast4(aRows[i][4]) });
        attendedSet[phoneLast4(aRows[i][4])] = true;
      }
    }
  }

  // 今日繳費明細
  const payments = [];
  let todayTotal = 0;
  for (let i = 1; i < ctx.recordRows.length; i++) {
    const r = ctx.recordRows[i];
    if (isTrue(r[8]) && monthDayKey(r[1]) === todayKey) {
      const fee = Number(r[7]) || 0;
      payments.push({ time: r[0], name: r[3], phoneLast4: phoneLast4(r[4]), item: r[10], fee: fee });
      todayTotal += fee;
    }
  }

  // 應到名單（學期全體＋單堂報今日）與未繳費名單
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();
  const expected = [];
  const unpaid = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0] && !rows[i][1]) continue;
    const member = rowToMember(rows[i], i + 1);
    const enrolledKeys = parseEnrolledDates(member.enrolledCourses);
    const relevant = member.memberType === 'semester' || enrolledKeys.indexOf(todayKey) !== -1;
    if (!relevant) continue;
    const feeInfo = calculateFee(member, course, ctx);
    const l4 = phoneLast4(member.phone);
    expected.push({
      name: member.name,
      phoneLast4: l4,
      identity: member.identity,
      memberType: member.memberType,
      attended: !!attendedSet[l4],
      fee: feeInfo.fee
    });
    if (feeInfo.fee > 0) {
      unpaid.push({ name: member.name, phoneLast4: l4, fee: feeInfo.fee, identity: member.identity, memberType: member.memberType });
    }
  }

  return jsonResponse({
    status: 'ok',
    course: course,
    expectedCount: expected.length,
    attendedCount: attended.length,
    paidCount: payments.length,
    todayTotal: todayTotal,
    expected: expected,
    attended: attended,
    unpaid: unpaid,
    payments: payments
  });
}

// 17. 金流總覽：本學期累計收入（分品名）＋ 今日入帳明細
function finance(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const semester = data.semester || getSemesterName(new Date());
  const todayKey = monthDayKey(new Date());
  const rows = getSheet(SHEET_NAMES.RECORDS).getDataRange().getValues();

  let semesterTotal = 0;
  const byItem = {};
  const todayPayments = [];
  let todayTotal = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!isTrue(r[8])) continue;
    const fee = Number(r[7]) || 0;
    const d = parseDateValue(r[1]);
    if (!d) continue;

    if (getSemesterName(d) === semester) {
      semesterTotal += fee;
      const item = String(r[10] || '（無品名）');
      // 品名含折抵說明時，併入基礎品名統計
      const baseItem = item.replace(/（已折抵單堂 \$\d+）/, '');
      if (!byItem[baseItem]) byItem[baseItem] = { item: baseItem, count: 0, total: 0 };
      byItem[baseItem].count++;
      byItem[baseItem].total += fee;
    }

    if (monthDayKey(d) === todayKey) {
      todayPayments.push({ time: r[0], name: r[3], item: r[10], fee: fee, note: r[12] || '' });
      todayTotal += fee;
    }
  }

  const itemList = Object.keys(byItem).map(k => byItem[k]);
  itemList.sort((a, b) => b.total - a.total);

  return jsonResponse({
    status: 'ok',
    semester: semester,
    semesterTotal: semesterTotal,
    byItem: itemList,
    today: {
      date: formatDate(new Date()),
      total: todayTotal,
      payments: todayPayments
    }
  });
}

// ============ 幹部驗證 ============
function validateStaff(password) {
  const cache = CacheService.getScriptCache();

  // 已被鎖定（暴力破解防護）：直接拒絕
  if (cache.get('staff_locked') === '1') {
    return null;
  }

  const sheet = getSheet(SHEET_NAMES.STAFF);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(password)) {
      // 驗證成功，清除失敗計數
      cache.remove('staff_fail');
      return { name: rows[i][0] };
    }
  }

  // 驗證失敗：累加計數，連續 5 次鎖定 10 分鐘
  const fail = parseInt(cache.get('staff_fail') || '0', 10) + 1;
  if (fail >= 5) {
    cache.put('staff_locked', '1', 600); // 鎖定 10 分鐘
    cache.remove('staff_fail');
  } else {
    cache.put('staff_fail', String(fail), 600);
  }
  return null;
}

// ============ 報名同步：直接讀「表單回覆表」寫入 members ============
// 架構：表單回覆表（獨立試算表） --syncMembers 直讀--> members
//
// 為什麼不經過「報名同步」分頁：IMPORTRANGE 有數分鐘~數小時的快取延遲，
// 撐不住「現場填表 → 馬上簽到」的流程。改成直讀原始回覆表，零延遲。
// 欄位對應用「標題文字」尋找（不寫死索引），表單改版加欄位也不會錯位。
const SIGNUP_SS_ID = '1Hk22NsecGx6SoW4YBn6b6QADBtZow9HaGwFHvnfunJk';
const SIGNUP_SHEET_NAME = '表單回覆 1';

// 在標題列中找欄位索引（patterns 任一命中；exclude 命中則跳過）
function findColByHeader(headers, patterns, exclude) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    if (!h) continue;
    if (exclude && exclude.some(x => h.indexOf(x) !== -1)) continue;
    if (patterns.some(p => h.indexOf(p) !== -1)) return i;
  }
  return -1;
}

// 取得表單回覆分頁（名稱不對時，改找含「姓名 + 電話」標題的分頁）
function getSignupSheet() {
  const ss = SpreadsheetApp.openById(SIGNUP_SS_ID);
  const named = ss.getSheetByName(SIGNUP_SHEET_NAME);
  if (named) return named;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const lastCol = sheets[i].getLastColumn();
    if (lastCol < 5) continue;
    const h = sheets[i].getRange(1, 1, 1, Math.min(lastCol, 25)).getValues()[0];
    const hasName = h.some(c => String(c).indexOf('姓名') !== -1);
    const hasPhone = h.some(c => String(c).indexOf('電話') !== -1);
    if (hasName && hasPhone) return sheets[i];
  }
  return sheets[0] || null;
}

function syncMembers() {
  const sheet = getSignupSheet();
  if (!sheet) {
    return jsonResponse({ status: 'error', message: '找不到表單回覆分頁' }, 500);
  }

  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) {
    return jsonResponse({ status: 'ok', total: 0, created: 0, updated: 0, skipped: 0, errors: 0 });
  }

  const headers = rows[0];
  const col = {
    name: findColByHeader(headers, ['姓名']),
    phone: findColByHeader(headers, ['電話']),
    email: findColByHeader(headers, ['電子郵件'], ['地址']),
    plan: findColByHeader(headers, ['我想入社報名', '報名']),
    enroll: findColByHeader(headers, ['可依需求自由選擇'])
  };

  if (col.name < 0 || col.phone < 0 || col.plan < 0) {
    return jsonResponse({
      status: 'error',
      message: '表單欄位對應失敗（找不到 姓名/電話/方案 欄）。目前標題：' + headers.join('｜')
    }, 500);
  }

  // 一次讀 members，建立「正規化電話 → 現況」索引（避免逐筆重讀）
  const memberSheet = getSheet(SHEET_NAMES.MEMBERS);
  const mRows = memberSheet.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < mRows.length; i++) {
    const key = normalizePhone(mRows[i][1]);
    if (key && !index[key]) {
      index[key] = {
        rowIndex: i + 1,
        paidSemester: mRows[i][5],
        enrolledCourses: mRows[i][6],
        locked: isTrue(mRows[i][7]),                                          // H 欄「手動鎖定」
        cur: [mRows[i][0], mRows[i][1], mRows[i][2], mRows[i][3], mRows[i][4]] // 現值：姓名/電話/email/身分/類型
      };
    }
  }

  const appends = [];
  let updated = 0, errors = 0, skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    try {
      const name = String(rows[i][col.name] || '').trim();
      const phone = String(rows[i][col.phone] || '').trim();
      if (!name || !phone) { skipped++; continue; }

      const email = col.email >= 0 ? String(rows[i][col.email] || '').trim() : '';
      const planText = String(rows[i][col.plan] || '').trim();
      const enrollText = col.enroll >= 0 ? String(rows[i][col.enroll] || '').trim() : '';

      const plan = parsePlan(planText);
      const enrolled = parseEnrolledDates(enrollText).join(',');
      const hit = index[normalizePhone(phone)];

      if (hit) {
        // 更新：一次寫 8 欄。
        // F 欄（paidSemester）沿用原值；G 欄（報名堂次）用「聯集」合併，
        // 避免同一個人再次填表單加報新堂次時，覆蓋掉先前已報名的堂次。
        const merged = plan.memberType === 'semester'
          ? ''   // 轉為學期社員：堂次清空（學期已涵蓋全部）
          : mergeEnrolled(hit.enrolledCourses, enrolled);

        // 幹部在 members 按了「手動鎖定」（H 欄，walkin / updateMember 會自動設）時，
        // 保留幹部修正過的 姓名/電話/email/身分/會員類型，不讓表單原始值蓋回去；
        // 「報名堂次」仍以表單聯集為準。
        const finalName  = hit.locked ? hit.cur[0] : name;
        const finalPhone = hit.locked ? phoneToStore(hit.cur[1]) : phoneToStore(phone);
        const finalEmail = hit.locked ? hit.cur[2] : email;
        const finalIdent = hit.locked ? hit.cur[3] : plan.identity;
        const finalType  = hit.locked ? hit.cur[4] : plan.memberType;

        memberSheet.getRange(hit.rowIndex, 1, 1, 8).setValues([[
          finalName, finalPhone, finalEmail, finalIdent, finalType, hit.paidSemester, merged, hit.locked
        ]]);
        updated++;
      } else {
        appends.push([name, phoneToStore(phone), email, plan.identity, plan.memberType, false, enrolled]);
      }
    } catch (e) {
      errors++;  // 逐筆防錯：單筆失敗不影響其他筆（不再全有全無）
    }
  }

  let created = 0;
  if (appends.length > 0) {
    memberSheet.getRange(memberSheet.getLastRow() + 1, 1, appends.length, 7).setValues(appends);
    created = appends.length;
  }

  return jsonResponse({
    status: 'ok',
    total: Math.max(0, rows.length - 1),
    created: created,
    updated: updated,
    skipped: skipped,
    errors: errors
  });
}

// 即時同步（頻率限制 60 秒，避免被濫用）
function tryAutoSync() {
  const cache = CacheService.getScriptCache();
  if (cache.get('auto_sync_lock')) return false;
  cache.put('auto_sync_lock', '1', 60);
  try {
    syncMembers();
    return true;
  } catch (e) {
    return false;
  }
}

// 幹部手動觸發同步（課前拉一次最新名單）
function syncNowAction(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }
  return syncMembers();
}

// 一次性遷移：把 records 裡「未繳費的簽到紀錄」(fee=0 且無 code) 搬到 attendance，
// 讓 records 只留繳費／收據資料。可重複執行（第二次沒有東西可搬）。
// 執行方式：Apps Script 編輯器 → 選 migrateAttendance → 執行一次
function migrateAttendance() {
  const recSheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = recSheet.getDataRange().getValues();
  if (rows.length < 2) {
    return jsonResponse({ status: 'ok', moved: 0, kept: 0 });
  }

  const keep = [rows[0]];
  const toMove = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const fee = Number(r[7]) || 0;
    const hasCode = String(r[9] == null ? '' : r[9]).trim() !== '';
    if (fee === 0 && !hasCode) {
      toMove.push(r);
    } else {
      keep.push(r);
    }
  }

  // 先寫 attendance（同人同堂去重），完成後才重寫 records —— 順序確保不會遺失資料
  for (let i = 0; i < toMove.length; i++) {
    const r = toMove[i];
    const l4 = phoneLast4(r[4]);
    if (!hasAttendance(l4, r[1])) {
      addAttendance({
        courseDate: r[1],
        courseName: r[2],
        name: r[3],
        phoneLast4: l4,
        memberType: r[6],
        identity: r[5]
      });
    }
  }

  const width = rows[0].length;
  const padded = keep.map(function (row) {
    const arr = row.slice(0, width);
    while (arr.length < width) arr.push('');
    return arr;
  });
  recSheet.clear();
  recSheet.getRange(1, 1, padded.length, width).setValues(padded);

  return jsonResponse({
    status: 'ok',
    moved: toMove.length,
    kept: keep.length - 1,
    sheet: SHEET_NAMES.ATTENDANCE
  });
}

// v2.0 一次性設定：電話欄設純文字（防開頭 0 被吃）、補齊 note 欄標題
// 執行方式：Apps Script 編輯器 → 選 setupV2 → 執行一次
function setupV2() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // members：電話欄（B）設為純文字；補 H（locked）、I（note）標題
  const members = ss.getSheetByName(SHEET_NAMES.MEMBERS);
  members.getRange('B:B').setNumberFormat('@');
  if (members.getRange(1, 8).getValue() !== 'locked') members.getRange(1, 8).setValue('locked');
  if (members.getRange(1, 9).getValue() !== 'note') members.getRange(1, 9).setValue('note');

  // records：補 M 欄 note 標題
  const records = ss.getSheetByName(SHEET_NAMES.RECORDS);
  if (records.getRange(1, 13).getValue() !== 'note') records.getRange(1, 13).setValue('note');

  // attendance：補 H 欄 note 標題（不存在則建立）
  const att = getOrCreateSheet(SHEET_NAMES.ATTENDANCE, ATTENDANCE_HEADERS);
  if (att.getRange(1, 8).getValue() !== 'note') att.getRange(1, 8).setValue('note');

  return jsonResponse({ status: 'ok', message: 'setupV2 完成：電話欄已設純文字，note 欄標題已補齊' });
}

// 保留給舊的可安裝觸發器(onFormSubmit)相容入口：改為執行同步
function onFormSubmit() {
  return syncMembers();
}

// 解析報名表「方案」欄 → { memberType, identity }
// 選項：
//   「學生身分、單堂社員：$250 / 堂」 → single + student
//   「社會人士、單堂社員：$450 / 堂」 → single + public
//   「學生 $1800；社會人士 $3500」      → semester（身分不自動判斷，預設學生；幹部人工驗證後在 members 手動改 identity）
function parsePlan(planText) {
  const s = String(planText || '').trim();
  if (s.indexOf('單堂') !== -1) {
    return {
      memberType: 'single',
      identity: s.indexOf('社會') !== -1 ? 'public' : 'student'
    };
  }
  return {
    memberType: 'semester',
    identity: 'student'
  };
}
