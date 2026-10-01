# GAS Backend — Security Hardening

A GAS + Sheets backend has no auth middleware, no rate limiter, and no session. A static frontend on GitHub Pages hardcodes the `SPREADSHEET_ID` and Web App URL in a **public repo**. This file is the checklist for hardening that stack without breaking the non-programmer's workflow.

## The three biggest risks (audit in this order)

1. **Sheet sharing = "Anyone with link"** — if the Sheet is shared "anyone with the link", then anyone who finds the `SPREADSHEET_ID` (it's in your public repo) can read every member's name/phone/email + plaintext staff passwords. **Mitigation: set the Sheet share to "Restricted" (受限制).** The script still works because it runs under "Execute as = me".
2. **Deployment "Who has access = Only myself"** — see SKILL.md. This breaks the app for all non-owner callers. "Execute as = me" + "Who has access = anyone" is the correct pair.
3. **Weak/plaintext staff password + no rate limit** — a numeric 4-digit admin password is brute-forceable in minutes. Add rate limiting (below) and require ≥6 chars.

## Rate-limiting a staff/admin password with CacheService

GAS has no built-in rate limiter. `CacheService.getScriptCache()` gives a key/value store with TTL — perfect for a lockout counter (note: it's global per script, so one staff's lockout locks everyone; acceptable at club scale).

```javascript
function validateStaff(password) {
  const cache = CacheService.getScriptCache();
  if (cache.get('staff_locked') === '1') return null;      // locked out
  const rows = SpreadsheetApp.openById(SHEET_ID).getSheetByName('staff').getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(password)) {
      cache.remove('staff_fail');                          // success clears counter
      return { name: rows[i][0] };
    }
  }
  const fail = parseInt(cache.get('staff_fail') || '0', 10) + 1;
  if (fail >= 5) { cache.put('staff_locked', '1', 600); cache.remove('staff_fail'); }
  else { cache.put('staff_fail', String(fail), 600); }     // 600s = 10 min TTL
  return null;
}
```

## Prevent enumeration with dual-factor lookup

Never let a public endpoint resolve a member from a single low-entropy key alone (e.g. a 4-digit phone suffix — only 10,000 values, trivially enumerable to build a name→payment-status table). Require a second factor only the legitimate member knows (their name):

```javascript
function namesMatch(a, b) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
  return norm(a) === norm(b) && norm(a) !== '';
}
// in the public checkin handler, AFTER finding member by last4:
if (data.name && !namesMatch(member.name, data.name)) {
  return jsonResponse({ status: 'error', message: '姓名與末四碼不符' }, 404);
}
```

The name match is lenient enough (strips whitespace, case) that real members pass, but a brute-force attacker without the name can't. Keep staff-facing lookups keyed by suffix only (they're already behind the password gate) — don't add friction to the fast staff flow.

## One-time redemption codes: length + expiry

- **Length:** 6 digits = 1e6; 8 digits = 1e8. `Math.floor(10000000 + Math.random() * 90000000)`.
- **Expiry:** store `new Date()` in the record's timestamp column, and on redeem reject codes older than ~30 min. This bounds the window if a code leaks.

```javascript
const ts = new Date(record.timestamp);
const ageMin = (Date.now() - ts.getTime()) / 60000;
if (isNaN(ageMin) || ageMin > 30) {
  return jsonResponse({ status: 'error', message: '此收據密碼已過期' }, 410);
}
```

Note: `Math.random()` is not cryptographically secure. For club-scale one-time codes that's acceptable; for real money/sensitive flows use `Utilities.getUuid()` or crypto.

## CORS is not a lever you can pull

GAS controls `Access-Control-Allow-Origin` from the deployment's "Who has access" setting — you cannot set a custom CORS header from `ContentService`. Tightening the origin allow-list is not possible in code; the only knob is the access setting. Don't promise a "restrict CORS to my domain" fix on GAS.

## Records of hardening to keep in sync

After changing backend code, the frontend must also change the matching UI text/validation (e.g. 6-digit → 8-digit code inputs, password `inputmode="numeric"` → `"text"`). Grep for the old digit count across ALL html files (`\d{6}`, `6 位`, `maxlength="6"`) — one source file forgotten here causes a mismatched-format bug at the field.
