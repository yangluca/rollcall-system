/**
 * 師大影像藝術創作社 · 點名繳費收據系統
 * Google Apps Script 後端
 */

// ============ 設定 ============
const SPREADSHEET_ID = '1T2PB8XloNpLS11PqYa5cUCERGTbO3R3ZBx9toL1A5Rk';
const SHEET_NAMES = {
  MEMBERS: 'members',
  COURSES: 'courses',
  FEES: 'fees',
  STAFF: 'staff',
  RECORDS: 'records'
};

// ============ Web App 入口 ============
function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Rollcall API is running' });
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
  const headers = rows[0];
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
    d = new Date(raw);
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
  const s = String(phone).replace(/\D/g, '');
  return s.slice(-4);
}

// 姓名比對：去空白、轉小寫後比較（防末四碼被遍歷時需同時知道姓名）
function namesMatch(a, b) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
  return norm(a) === norm(b) && norm(a) !== '';
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function findMemberByPhone(phone) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const target = phoneLast4(phone);

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][1]) === target) {
      return {
        rowIndex: i + 1,
        name: rows[i][0],
        phone: rows[i][1],
        email: rows[i][2],
        identity: rows[i][3] || 'student',
        memberType: rows[i][4] || 'single',
        paidSemester: rows[i][5] === true || rows[i][5] === 'TRUE' || rows[i][5] === 'true'
      };
    }
  }
  return null;
}

function findMemberByLast4(last4) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][1]) === last4) {
      return {
        rowIndex: i + 1,
        name: rows[i][0],
        phone: rows[i][1],
        email: rows[i][2],
        identity: rows[i][3] || 'student',
        memberType: rows[i][4] || 'single',
        paidSemester: rows[i][5] === true || rows[i][5] === 'TRUE' || rows[i][5] === 'true'
      };
    }
  }
  return null;
}

function calculateFee(member, course) {
  const config = getConfig();
  const semester = getSemesterName(course.date);

  if (member.memberType === 'semester') {
    // 學期社員：今學年度已繳費了嗎？
    if (hasPaidSemester(member.phone, semester)) {
      return { fee: 0, item: course.receiptItem, type: 'semester_paid' };
    }
    const fee = member.identity === 'student' ? config.studentSemesterFee : config.publicSemesterFee;
    return { fee: fee, item: `${semester} 學期社費`, type: 'semester_first' };
  } else {
    // 單堂社員
    const fee = member.identity === 'student' ? config.studentSingleFee : config.publicSingleFee;
    return { fee: fee, item: course.receiptItem, type: 'single' };
  }
}

function hasPaidSemester(phone, semester) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (phoneLast4(rows[i][4]) === phoneLast4(phone) && rows[i][6] === 'semester') {
      // 有學期費繳費紀錄，再看品名是否同學年度
      const item = String(rows[i][7] || '');
      if (item.startsWith(semester)) return true;
    }
  }
  return false;
}

function upsertMember(member) {
  const sheet = getSheet(SHEET_NAMES.MEMBERS);
  const existing = findMemberByPhone(member.phone);

  if (existing) {
    // 更新現有資料，但保留 paidSemester
    sheet.getRange(existing.rowIndex, 1, 1, 5).setValues([[
      member.name,
      member.phone,
      member.email,
      member.identity,
      member.memberType
    ]]);
    return { action: 'updated', rowIndex: existing.rowIndex };
  } else {
    // 新增
    const newRow = [
      member.name,
      member.phone,
      member.email,
      member.identity,
      member.memberType,
      false
    ];
    sheet.appendRow(newRow);
    return { action: 'created' };
  }
}

function addRecord(record) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  sheet.appendRow([
    new Date(),
    record.courseDate,
    record.courseName,
    record.name,
    record.phoneLast4,
    record.identity,
    record.memberType,
    record.fee,
    record.paid,
    record.code || '',
    record.receiptItem || '',
    record.receiptImageUrl || ''
  ]);
}

function findRecordByCode(code) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
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
        paid: rows[i][8],
        code: rows[i][9],
        receiptItem: rows[i][10],
        receiptImageUrl: rows[i][11]
      };
    }
  }
  return null;
}

function getMemberHistory(last4) {
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();
  const history = [];

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) === String(last4) && rows[i][8] === true) {
      history.push({
        courseDate: rows[i][1],
        courseName: rows[i][2],
        name: rows[i][3],
        fee: rows[i][7],
        receiptItem: rows[i][10],
        code: rows[i][9]
      });
    }
  }
  return history.sort((a, b) => new Date(b.courseDate) - new Date(a.courseDate));
}

// ============ API 動作 ============

// 1. 報名表單提交（重複填表自動更新）
function submitForm(data) {
  const member = {
    name: data.name,
    phone: data.phone,
    email: data.email,
    identity: data.identity || 'student',
    memberType: data.memberType || 'single'
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
function checkin(data) {
  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByLast4(data.last4);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料，請先填寫報名表單' }, 404);
  }

  // 姓名雙重驗證：末四碼之外，還需姓名相符（防末四碼被暴力遍歷洩漏個資）
  if (data.name && !namesMatch(member.name, data.name)) {
    return jsonResponse({ status: 'error', message: '姓名與末四碼不符，請確認報名資料' }, 404);
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
      message: '請到櫃檯繳費，幹部會提供領收據密碼'
    });
  }

  // 已繳費（學期社員已繳），寫入簽到紀錄
  addRecord({
    courseDate: course.date,
    courseName: course.name,
    name: member.name,
    phoneLast4: phoneLast4(member.phone),
    identity: member.identity,
    memberType: member.memberType,
    fee: 0,
    paid: true,
    receiptItem: feeInfo.item,
    code: '',
    receiptImageUrl: ''
  });

  const history = getMemberHistory(phoneLast4(member.phone));

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

  return checkin({ name: data.name, last4: phoneLast4(data.phone) });
}

// 5. 幹部用末四碼定位社員
function locateMember(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByLast4(data.last4);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該末四碼的報名資料' }, 404);
  }

  const feeInfo = calculateFee(member, course);

  return jsonResponse({
    status: 'ok',
    member: {
      name: member.name,
      identity: member.identity,
      memberType: member.memberType,
      phoneLast4: phoneLast4(member.phone),
      paidSemester: member.paidSemester
    },
    course: course,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item,
    feeType: feeInfo.type
  });
}

// 6. 幹部確認收款，產生 code
function confirmPayment(data) {
  const staff = validateStaff(data.staffPassword);
  if (!staff) {
    return jsonResponse({ status: 'error', message: '幹部密碼錯誤' }, 403);
  }

  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByLast4(data.last4);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到該末四碼的報名資料' }, 404);
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
    receiptImageBase64: data.receiptImageBase64 || ''
  });

  return jsonResponse({
    status: 'ok',
    code: code,
    memberName: member.name,
    fee: feeInfo.fee,
    receiptItem: feeInfo.item
  });
}

// 7. 社員輸入 code 領收據
function redeemReceipt(data) {
  const record = findRecordByCode(data.code);
  if (!record) {
    return jsonResponse({ status: 'error', message: '無效的收據密碼' }, 404);
  }

  if (!record.paid) {
    return jsonResponse({ status: 'error', message: '此密碼尚未完成繳費' }, 400);
  }

  // 限時：收款後 30 分鐘內有效，超過請洽幹部重開
  const ts = new Date(record.timestamp);
  const ageMin = (Date.now() - ts.getTime()) / 60000;
  if (isNaN(ageMin) || ageMin > 30) {
    return jsonResponse({ status: 'error', message: '此收據密碼已過期，請洽幹部' }, 410);
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

// 8. 查詢歷史收據
function getHistory(data) {
  const member = findMemberByPhone(data.phone);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料' }, 404);
  }

  const history = getMemberHistory(phoneLast4(member.phone));
  return jsonResponse({ status: 'ok', history: history });
}

// 10. 社員端輪詢：幹部確認收款後，查詢是否已有可領取的 code
function pollCode(data) {
  const course = getActiveCourse();
  if (!course) {
    return jsonResponse({ status: 'error', message: '今天沒有開放簽到的社課' }, 400);
  }

  const member = findMemberByLast4(data.last4);
  if (!member) {
    return jsonResponse({ status: 'error', message: '找不到報名資料' }, 404);
  }
  if (data.name && !namesMatch(member.name, data.name)) {
    return jsonResponse({ status: 'error', message: '姓名與末四碼不符' }, 404);
  }

  const last4 = phoneLast4(member.phone);
  const sheet = getSheet(SHEET_NAMES.RECORDS);
  const rows = sheet.getDataRange().getValues();

  // 從最新往回找：末四碼相符 + 已繳費 + 有 code + 尚未過期
  for (let i = rows.length - 1; i >= 1; i--) {
    const paid = rows[i][8] === true || rows[i][8] === 'TRUE' || rows[i][8] === 'true';
    if (String(rows[i][4]) === last4 && paid && rows[i][9]) {
      const ts = new Date(rows[i][0]);
      const ageMin = (Date.now() - ts.getTime()) / 60000;
      if (!isNaN(ageMin) && ageMin <= 30) {
        return jsonResponse({
          status: 'ok',
          code: String(rows[i][9]),
          name: rows[i][3],
          fee: rows[i][7]
        });
      }
    }
  }

  // 找不到 code：回傳診斷資訊，方便對照 records 分頁實際資料（除錯用）
  const recent = [];
  for (let i = Math.max(1, rows.length - 3); i < rows.length; i++) {
    recent.push({
      last4: String(rows[i][4] != null ? rows[i][4] : ''),
      paid: String(rows[i][8] != null ? rows[i][8] : ''),
      code: String(rows[i][9] != null ? rows[i][9] : '(空)')
    });
  }
  return jsonResponse({
    status: 'ok',
    code: null,
    debug: {
      targetLast4: last4,
      recordCount: Math.max(0, rows.length - 1),
      recent: recent
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

// ============ Google 表單報名 → 自動搬運到 members ============
// 當社員提交報名表單（Google Forms）時，自動把回覆寫進 members 分頁。
// 需在 Apps Script 設定「可安裝觸發器」：onFormSubmit / 事件來源=試算表 / 事件=表單提交。
//
// Forms 題目必須照此順序（回覆第 1 欄是時間戳記，自動帶入）：
//   題1 = 姓名、題2 = 電話、題3 = Email、題4 = 身分、題5 = 報名類型
function onFormSubmit(e) {
  const values = e.values || [];
  const member = {
    name: String(values[1] || '').trim(),
    phone: String(values[2] || '').trim(),
    email: String(values[3] || '').trim(),
    identity: mapIdentity(values[4]),
    memberType: mapMemberType(values[5])
  };

  // 姓名或電話缺一就不寫入（避免空資料污染名單）
  if (!member.name || !member.phone) return;

  upsertMember(member);
}

// 身分選項文字 → 系統代碼（student / public）
function mapIdentity(v) {
  const s = String(v || '').trim();
  if (s.indexOf('社會') !== -1 || s.toLowerCase() === 'public') return 'public';
  return 'student';
}

// 報名類型選項文字 → 系統代碼（single / semester）
function mapMemberType(v) {
  const s = String(v || '').trim();
  if (s.indexOf('學期') !== -1 || s.toLowerCase() === 'semester') return 'semester';
  return 'single';
}
