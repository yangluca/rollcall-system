# Rollcall Receipt Code Delivery Log

Session context: 師大影像藝術創作社 rollcall + receipt system. Goal was to let staff collect cash and then surface a one-time 6-digit receipt code to the member automatically, instead of reading it aloud.

## What was tried

- Added a new GAS action `pollCode` that the member's check-in page calls every 3 seconds.
- After staff confirmed payment, the backend generated a code and the poll loop auto-displayed it plus a "領取收據" link.
- Frontend also supported `receipt.html?code=XXXXXX` auto-fill so the member did not have to type the code.

## Why it failed in practice

1. **Deployment gap.** GAS does not auto-update when `backend.gs` changes. If a member loaded `checkin.html` before the new `pollCode` action was deployed, the old backend returned "unknown action" and the frontend's silent `catch` just kept polling.
2. **Silent errors in poll loops.** The first implementation swallowed errors to keep retrying. That made the member stare at "繳費完成後，畫面會自動出現領取密碼…" forever while the real error was hidden.
3. **Sheets truthiness mismatch.** The read-side check used `rows[i][8] === true`, but Sheets sometimes returns the string `'TRUE'` for a checkbox cell. The record existed but the lookup missed it.
4. **Not a code bug.** After adding diagnostics to `pollCode`, the GAS side worked, but the user experience of requiring a redeploy before members could open the page was deemed too fragile for a club operator.

## Resolution

User explicitly asked to roll back to manual flow:

- Staff reads the 6-digit code aloud after confirming cash payment.
- Member types the 6-digit code into `checkin.html` and clicks "前往領取收據".
- `receipt.html?code=XXXXXX` still auto-fills and redeems, so a QR or link from staff works too.

## Lessons

- For field/club tools with non-technical operators, prefer a manual-but-stable flow over automation that depends on perfect deployment timing.
- If you must poll, surface every error visibly; never `catch(e){}` silently.
- When a read lookup misses but writes look correct, return a `debug` payload (`targetKey`, `recordCount`, recent rows) instead of guessing.
- Normalize Sheet booleans with `(v === true || v === 'TRUE' || v === 'true' || v === 1)`.
- After editing `backend.gs`, create a **New version** of the existing deployment; do not rely on the old deployment picking up code changes.
