# HFM API Authentication Button

**Date:** 2026-05-15
**Product:** hfm-report
**Scope:** Add an Authenticate button to cache HFM API key in localStorage

---

## Problem

Currently, the HFM API credentials (Wallet ID + Password) are sent on every export. The server authenticates with HFM, gets an `api_key`, fetches data, and returns XLSX. This means re-authentication on every export — slow and redundant.

## Solution

Add an "Authenticate" button in the HFM API Credentials card. When clicked:
1. Browser calls a new `POST /api/authenticate` endpoint
2. Server proxies the request to HFM's auth API
3. On success, the `api_key` is saved to `localStorage`
4. The export flow uses the cached `api_key` instead of re-authenticating

---

## Files to Modify

### 1. `apps/hfm-report/src/index.ts`

**Add endpoint: `POST /api/authenticate`**
- Accepts JSON `{ wallet_id: string, password: string }`
- Proxies to `POST ${HFM_BASE}/api/auth/key` with `{ wallet_id: Number(wallet_id), password }`
- Returns JSON `{ api_key: string }` on success
- Returns JSON `{ error: string }` on failure (401, network error, etc.)
- No auth guard (this is the credential-entry step)

**Modify endpoint: `POST /report/export`**
- Change accepted body from `{ wallet_id, password, from_date, to_date }` to `{ api_key, from_date, to_date }`
- Remove the auth step (Step 1) — use `api_key` directly from the request body
- If `api_key` is missing, redirect with error "กรุณา Authenticate ก่อน"
- Keep Steps 2 (fetch performance) and 3 (build XLSX) unchanged

### 2. `apps/hfm-report/src/views/report.ts`

**UI changes in the HFM API Credentials card:**
- Add an "Authenticate" button below the Wallet ID / Password row
- Add a status badge area (hidden by default) to show auth state

**JavaScript additions:**
- `handleAuthenticate()` function:
  - Reads Wallet ID and Password from inputs
  - `fetch('/api/authenticate', { method: 'POST', body: JSON.stringify({ wallet_id, password }) })`
  - On success: saves `api_key` to `localStorage.setItem('hfm_api_key', api_key)`
  - Shows green "Authenticated" badge with truncated key (last 4 chars)
  - Makes Wallet ID / Password inputs read-only
  - Changes button text to "Re-authenticate"
  - On failure: shows red error alert (reuse existing `.alert-error` pattern)

- On page load:
  - Check `localStorage.getItem('hfm_api_key')`
  - If present, show authenticated badge, set inputs to read-only, change button to "Re-authenticate"

- On form submit (export):
  - Populate hidden `<input name="api_key">` from localStorage
  - If no api_key in localStorage, prevent submit and show error

**Hidden field:**
- Add `<input type="hidden" name="api_key" id="api_key_field">` inside the form

---

## Data Flow

```
Browser                          Server                         HFM API
  |                                |                               |
  |-- POST /api/authenticate ----->|                               |
  |   { wallet_id, password }      |-- POST /api/auth/key -------->|
  |                                |   { wallet_id, password }      |
  |                                |<-- { api_key } ----------------|
  |<-- { api_key } ----------------|                               |
  |                                |                               |
  | [save api_key to localStorage] |                               |
  |                                |                               |
  |-- POST /report/export -------->|                               |
  |   { api_key, from_date,        |-- GET /api/performance ------>|
  |     to_date }                  |   Authorization: Bearer <key>  |
  |                                |<-- { clients: [...] } ---------|
  |<-- XLSX file ------------------|                               |
```

---

## Error Handling

| Scenario | UI Behavior |
|----------|-------------|
| HFM 401 | Red alert: "Wallet ID หรือรหัสผ่านไม่ถูกต้อง" |
| HFM other error | Red alert: "HFM Authentication Error: {status}" |
| Network error | Red alert: "เกิดข้อผิดพลาดในการเชื่อมต่อ" |
| Export without auth | Red alert: "กรุณา Authenticate ก่อน" |
| api_key expired on export | Server returns error, user re-authenticates |

---

## Validation Gates

1. `bun run dev` starts without errors
2. Authenticate button calls `/api/authenticate` and shows success/error
3. `api_key` is saved to localStorage after successful auth
4. Export uses the saved `api_key` (verify no auth call in network tab)
5. Re-authenticate clears old key and saves new one
6. Page reload shows authenticated state from localStorage
