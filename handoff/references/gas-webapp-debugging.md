# GAS Web App Debugging Recipes

Concrete debugging patterns for Google Apps Script Web App backends (deployed as
`https://script.google.com/macros/s/.../exec`). These came out of building a
club rollcall + receipt system; they save hours of "why is it 405 / why does it
say connection error" confusion.

## 1. POST Content-Type MUST be `text/plain`

GAS Web Apps reject `Content-Type: application/json` POSTs with **HTTP 405**
(and a Google Drive "找不到網頁" page). The frontend must send `text/plain`
with a raw JSON string body. GAS reads it via `e.postData.contents`.

```javascript
// ✅ CORRECT
await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ action: 'checkin', last4: '1234' })
});

// ❌ WRONG — GAS returns 405
await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ... })
});
```

In `doPost`:
```javascript
function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');
}
```

## 2. curl CANNOT reliably test GAS POSTs — don't trust it

GAS answers every Web App request with a **302 redirect** to
`script.googleusercontent.com/macros/echo?...`. Two traps:

- **curl downgrades POST→GET on 302** (default behavior). So `curl -X POST`
  becomes a GET at the redirect target → **405**. This is a *curl artifact*,
  NOT a bug in your code. The browser `fetch()` does NOT do this.
- The echo token is **single-use**, so you can't POST to it twice.

### Workarounds (pick one)
```bash
# A) Force curl to keep POST across the redirect:
#    NOTE: the echo token is single-use; the follow-up POST to the echo URL
#    may still return "找不到網頁" if the token is consumed. This is also a
#    curl/GAS redirect artifact, not a backend bug.
curl -s -L --post302 -X POST "$URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"checkin","last4":"1234"}'

# B) Probe with form-urlencoded to surface the REAL GAS error page
#    (GAS wraps the body as "payload=..." and JSON.parse fails, but the
#     error HTML title reveals the actual script error + line number):
curl -s -L -X POST "$URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode 'payload={"action":"checkin","last4":"1234"}' \
  | grep -o -E "<title>[^<]*</title>|第 [0-9]+ 行[^<]*"

# C) Just test in a real browser — it handles the redirect correctly.
#    This is the gold standard for GAS Web App POST debugging.
```

**Rule of thumb:** if `curl -X POST` returns 405 but the browser works, it's
the curl-downgrade trap, not your backend. If `--post302` later returns
"找不到網頁", that's the single-use echo token expiring — also not your code.

## 3. Surface the real error on the frontend (don't mask it)

A generic "連線發生問題 / connection error" catch hides the actual GAS error
and wastes debugging cycles. The frontend should read raw text, parse, and
re-throw the server's message:

```javascript
async function callAPI(action, payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action, ...payload })
  });
  const text = await res.text();          // never res.json() directly
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('伺服器回傳非預期內容：' + text.slice(0, 300));
  }
  if (json.status === 'error') throw new Error(json.message || '伺服器錯誤');
  return json;
}
// In the catch block: showResult('err', err.message)  ← shows the REAL reason
```

Always return errors from GAS as `{ status: 'error', message: '...' }` with
HTTP 200 (see `setHttpCode` note below).

## 4. `ContentService.TextOutput` has NO `setHttpCode()`

`ContentService.createTextOutput(...).setMimeType(...).setHttpCode(400)` throws
`setHttpCode is not a function`. Encode status in the JSON body instead; the
HTTP status is always 200.

```javascript
function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
// Frontend checks payload.status === 'error', not response.ok
```

## 5. ROC (民國) year parsing in Sheets dates

Taiwan uses 民國年 (ROC year = Western − 1911). If a club member types
`114/8/30` expecting 2025-08-30, `new Date("114/8/30")` parses as **year 114**
(AD 114), not 2025. GAS `Date` is always Western. Normalize on read:

```javascript
function parseDateValue(raw) {
  if (!raw) return null;
  const d = (raw instanceof Date) ? new Date(raw.getTime()) : new Date(raw);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() <= 200) d.setFullYear(d.getFullYear() + 1911); // ROC→AD
  return d;
}
// 114/8/30 → 2025-08-30, 2026/8/30 → 2026-08-30, Sheets Date obj → unchanged
```

Also: a cell typed as `114/8/30` may be stored as *text*, not a Date. Prefer
typing Western `2026/8/30` in the sheet, or use `parseDateValue` defensively.

## 6. Sheets boolean / "active" flag truthiness

`row[3] === true` FAILS when the sheet stores the value as the string `'TRUE'`
(a common result of typing TRUE in a cell) or as a checkbox boolean. Normalize:

```javascript
const activeVal = (active === true || active === 'TRUE' || active === 'true' || active === 1);
if (!date || !activeVal) continue;
```

Apply the same defensiveness to `paidSemester` and any yes/no column.

## 7. Redeploy = new VERSION of the existing deployment

Editing `Code.gs` and pressing Save does **NOT** update the live Web App. You
must create a new **version**:

- Deploy → Manage deployments → pencil (edit) → Version → **New version** → Deploy
- The Web App URL **stays the same** (it does NOT change on re-deploy — only
  "New deployment" gives a new URL). So if the frontend URL is unchanged but
  behavior is stale, the fix is "new version of the same deployment", not a new
  URL.

Symptom that bit us: code was edited to add a date fix, but the live endpoint
kept running the old version → "今天沒有開放簽到的社課" until a new version was
deployed.

## 8. Multi-worksheet read order

`getDataRange().getValues()` returns row 0 = header. Always loop from `i = 1`.
When matching today's course, compare with `today.setHours(0,0,0,0)` on BOTH
sides so time-of-day doesn't break the match.

## 9. Diagnostic payload — stop guessing on "wrote it but lookup returns nothing"

The classic dead-end: the write side clearly succeeded (the staff screen showed
the generated 6-digit code), but the read-side lookup (e.g. a `pollCode` action
that polls for that code) returns "no match" and the member's screen just spins
forever. You can burn several rounds guessing between:

- redeploy-not-done (new action → "unknown action" → swallowed by a catch)
- column-index drift (the sheet's real columns don't match your `row[i][N]`)
- type mismatch (boolean `true` vs string `'TRUE'` — see recipe 6)
- the write never landed (empty value)

**Don't guess — make the miss self-describing.** When the lookup finds nothing,
return a `debug` field carrying (a) the key you searched for, (b) the row count,
and (c) the last ~3 rows' *relevant* columns, and surface it in the frontend so a
non-technical user can paste/screenshot it:

```javascript
// In the lookup, when no match is found:
const recent = [];
for (let i = Math.max(1, rows.length - 3); i < rows.length; i++) {
  recent.push({
    last4: String(rows[i][4] != null ? rows[i][4] : ''),
    paid: String(rows[i][8] != null ? rows[i][8] : ''),
    code: String(rows[i][9] != null ? rows[i][9] : '(空)')
  });
}
return jsonResponse({
  status: 'ok', code: null,
  debug: { targetKey: last4, recordCount: Math.max(0, rows.length - 1), recent }
});
```

Frontend shows `debug` verbatim (JSON) in the polling status div. One round-trip
now tells you which of the three match conditions (`last4` / `paid` / `code`)
failed, or whether `recordCount === 0` (write never landed → redeploy or wrong
sheet). This is far faster than iterating on guesses.

**Corollary — don't silently swallow errors in a polling loop.** A poll loop that
does `catch(e) {}` to "just keep waiting" will ALSO hide a redeploy failure: the
old backend returns `{"status":"error","message":"未知動作: pollCode"}`, the
frontend silently ignores it, and the member spins forever. Surface `e.message`
in the poll status (even as a tiny grey/amber line) so the real reason — redeploy
needed, name mismatch, etc. — is visible instead of invisible.
