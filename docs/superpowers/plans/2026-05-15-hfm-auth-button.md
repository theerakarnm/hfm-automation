# HFM API Authentication Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Authenticate button that caches the HFM API key in localStorage, so exports skip re-authentication.

**Architecture:** Browser-side JS calls a new `/api/authenticate` proxy endpoint, saves the returned `api_key` to localStorage, and sends it on export. The server no longer authenticates on every export.

**Tech Stack:** Hono (Bun), vanilla JS in HTML template, localStorage

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/hfm-report/src/index.ts` | Modify | Add `/api/authenticate` endpoint; change `/report/export` to accept `api_key` |
| `apps/hfm-report/src/views/report.ts` | Modify | Add auth button, JS logic, localStorage handling, hidden field |

---

## Task 1: Add `POST /api/authenticate` endpoint

**Files:**
- Modify: `apps/hfm-report/src/index.ts:112-113` (after logout route, before report route)

- [ ] **Step 1: Add the authenticate endpoint**

Add this route between the `/logout` route and the `/report` route:

```typescript
/** Authenticate with HFM API — returns api_key */
app.post('/api/authenticate', async (c) => {
  const body = await c.req.parseBody<{ wallet_id: string; password: string }>()
  const { wallet_id, password } = body

  if (!wallet_id || !password) {
    return c.json({ error: 'กรุณากรอก Wallet ID และ Password' }, 400)
  }

  try {
    const authRes = await fetch(`${HFM_BASE}/api/auth/key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet_id: Number(wallet_id), password }),
    })

    if (!authRes.ok) {
      const msg = authRes.status === 401
        ? 'Wallet ID หรือรหัสผ่านไม่ถูกต้อง'
        : `HFM Authentication Error: ${authRes.status}`
      return c.json({ error: msg }, authRes.status)
    }

    const { api_key } = await authRes.json() as { api_key: string }
    if (!api_key) {
      return c.json({ error: 'HFM API ไม่ส่ง api_key กลับมา' }, 502)
    }

    return c.json({ api_key })
  } catch (err) {
    console.error('[authenticate] error:', err)
    return c.json({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ' }, 500)
  }
})
```

- [ ] **Step 2: Verify server starts**

Run: `cd apps/hfm-report && bun run dev`
Expected: Server starts on port 3000 without errors

- [ ] **Step 3: Commit**

```bash
git add apps/hfm-report/src/index.ts
git commit -m "feat: add POST /api/authenticate endpoint"
```

---

## Task 2: Modify `POST /report/export` to accept `api_key`

**Files:**
- Modify: `apps/hfm-report/src/index.ts:120-211` (the export handler)

- [ ] **Step 1: Rewrite the export handler**

Replace the entire `/report/export` handler with this version that accepts `api_key` instead of `wallet_id`/`password`:

```typescript
/** Export handler (protected) */
app.post('/report/export', guard, async (c) => {
  const body = await c.req.parseBody<{
    api_key:   string
    from_date: string
    to_date:   string
  }>()

  const { api_key, from_date, to_date } = body

  if (!api_key) {
    return c.redirect(`/report?error=${encode('กรุณา Authenticate ก่อน')}`)
  }

  if (!from_date || !to_date) {
    return c.redirect(`/report?error=${encode('กรุณาเลือกช่วงวันที่')}`)
  }

  try {
    // ── Step 1: Fetch client performance ──
    const qs = new URLSearchParams({
      from_date: `${from_date}T00:00:00`,
      to_date:   `${to_date}T23:59:59`,
    })

    const perfRes = await fetch(
      `${HFM_BASE}/api/performance/client-performance?${qs}`,
      { headers: { Authorization: `Bearer ${api_key}` } },
    )

    if (!perfRes.ok) {
      const msg = perfRes.status === 401
        ? 'API Key หมดอายุหรือไม่ถูกต้อง กรุณา Authenticate ใหม่'
        : `ดึงข้อมูล client performance ไม่สำเร็จ (${perfRes.status})`
      return c.redirect(`/report?error=${encode(msg)}`)
    }

    const data = await perfRes.json() as { clients: Record<string, unknown>[] }
    const clients = data.clients ?? []

    if (clients.length === 0) {
      return c.redirect(
        `/report?error=${encode('ไม่พบข้อมูล Trading Lots ในช่วงวันที่ที่เลือก')}`,
      )
    }

    // ── Step 2: Build XLSX ──
    const rows = clients.map((cl) => ({
      'Wallet ID':    cl.client_id,
      'Account ID':   cl.account_id,
      'Account Type': cl.account_type,
      'Trading Lots': cl.volume,
    }))

    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 16 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Performance')

    const buf      = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const filename = `hfm_performance_${from_date}_to_${to_date}.xlsx`

    console.log(`[export] api_key=***${api_key.slice(-4)} from=${from_date} to=${to_date} rows=${rows.length}`)

    return new Response(buf, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(buf.byteLength),
      },
    })

  } catch (err) {
    console.error('[export] unexpected error:', err)
    return c.redirect(`/report?error=${encode('เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง')}`)
  }
})
```

- [ ] **Step 2: Verify server starts**

Run: `cd apps/hfm-report && bun run dev`
Expected: Server starts on port 3000 without errors

- [ ] **Step 3: Commit**

```bash
git add apps/hfm-report/src/index.ts
git commit -m "feat: change export to accept api_key instead of wallet_id/password"
```

---

## Task 3: Add auth button UI and localStorage logic to report.ts

**Files:**
- Modify: `apps/hfm-report/src/views/report.ts` (entire file — UI + JS)

- [ ] **Step 1: Add CSS for auth button and status badge**

Add these styles after the existing `.btn-export:disabled` block (around line 307):

```css
/* ── Auth button ── */
.btn-auth {
  width: 100%;
  margin-top: 14px;
  padding: 10px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  letter-spacing: 0.3px;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn-auth:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-lo);
}
.btn-auth:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ── Auth status badge ── */
.auth-status {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: fadeIn 0.3s ease;
}
.auth-success {
  background: rgba(63, 185, 80, 0.08);
  border: 1px solid rgba(63, 185, 80, 0.35);
  color: #3fb950;
}
.auth-error {
  background: var(--err-bg);
  border: 1px solid var(--err-bd);
  color: var(--err-tx);
}
.hidden { display: none; }

/* read-only inputs */
.field input[readonly] {
  opacity: 0.6;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Add auth button and status badge to the credentials card HTML**

Replace the credentials card body (lines 355-381) with:

```html
<div class="card-body">
  <div class="field-row">
    <div class="field">
      <label for="wallet_id">Wallet ID</label>
      <input
        id="wallet_id"
        type="number"
        name="wallet_id"
        placeholder="123456"
        required
        autocomplete="off"
        min="1"
      >
    </div>
    <div class="field">
      <label for="api_password">Password</label>
      <input
        id="api_password"
        type="password"
        name="password"
        placeholder="••••••••"
        required
        autocomplete="off"
      >
    </div>
  </div>

  <button class="btn-auth" type="button" id="auth-btn">Authenticate</button>

  <div class="auth-status hidden" id="auth-status">
    <span id="auth-status-icon"></span>
    <span id="auth-status-text"></span>
  </div>
</div>
```

- [ ] **Step 3: Add hidden api_key field inside the form**

Add right after the opening `<form id="export-form" ...>` tag (line 347):

```html
<input type="hidden" name="api_key" id="api_key_field">
```

- [ ] **Step 4: Add JavaScript for authentication logic**

Add this script block inside the existing `<script>` tag, after the `init()` IIFE (before `</script>`):

```javascript
// ─── HFM Authentication ───────────────────────────────────────────

const authBtn    = document.getElementById('auth-btn')
const authStatus = document.getElementById('auth-status')
const authIcon   = document.getElementById('auth-status-icon')
const authText   = document.getElementById('auth-status-text')
const walletInput = document.getElementById('wallet_id')
const passInput   = document.getElementById('api_password')
const apiKeyField = document.getElementById('api_key_field')

function showAuthSuccess(key) {
  authStatus.classList.remove('hidden', 'auth-error')
  authStatus.classList.add('auth-success')
  authIcon.textContent = '✓'
  authText.textContent = 'Authenticated (key: ****' + key.slice(-4) + ')'
  walletInput.readOnly = true
  passInput.readOnly   = true
  authBtn.textContent  = 'Re-authenticate'
}

function showAuthError(msg) {
  authStatus.classList.remove('hidden', 'auth-success')
  authStatus.classList.add('auth-error')
  authIcon.textContent = '⚠'
  authText.textContent = msg
}

function clearAuthState() {
  authStatus.classList.add('hidden')
  walletInput.readOnly = false
  passInput.readOnly   = false
  passInput.value      = ''
  authBtn.textContent  = 'Authenticate'
  localStorage.removeItem('hfm_api_key')
  apiKeyField.value = ''
}

async function handleAuthenticate() {
  const walletId = walletInput.value.trim()
  const password = passInput.value

  if (!walletId || !password) {
    showAuthError('กรุณากรอก Wallet ID และ Password')
    return
  }

  authBtn.disabled    = true
  authBtn.textContent = '⏳ Authenticating...'

  try {
    const res = await fetch('/api/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ wallet_id: walletId, password }).toString(),
    })

    const data = await res.json()

    if (res.ok && data.api_key) {
      localStorage.setItem('hfm_api_key', data.api_key)
      apiKeyField.value = data.api_key
      showAuthSuccess(data.api_key)
    } else {
      showAuthError(data.error || 'Authentication failed')
    }
  } catch (err) {
    showAuthError('เกิดข้อผิดพลาดในการเชื่อมต่อ')
  } finally {
    authBtn.disabled = false
  }
}

// Toggle between Authenticate and Re-authenticate
authBtn.addEventListener('click', () => {
  if (localStorage.getItem('hfm_api_key')) {
    clearAuthState()
    walletInput.focus()
  } else {
    handleAuthenticate()
  }
})

// On page load — restore authenticated state
;(function checkSavedAuth() {
  const saved = localStorage.getItem('hfm_api_key')
  if (saved) {
    apiKeyField.value = saved
    showAuthSuccess(saved)
  }
})()

// Populate api_key on form submit
document.getElementById('export-form').addEventListener('submit', (e) => {
  const key = localStorage.getItem('hfm_api_key')
  if (!key) {
    e.preventDefault()
    showAuthError('กรุณา Authenticate ก่อน Export')
    return
  }
  apiKeyField.value = key
})
```

- [ ] **Step 5: Verify server starts and page renders**

Run: `cd apps/hfm-report && bun run dev`
Expected: Server starts, `http://localhost:3000/report` shows the auth button below credentials

- [ ] **Step 6: Commit**

```bash
git add apps/hfm-report/src/views/report.ts
git commit -m "feat: add auth button UI with localStorage caching"
```

---

## Task 4: End-to-end verification

- [ ] **Step 1: Start the dev server**

Run: `cd apps/hfm-report && bun run dev`
Expected: Server running on http://localhost:3000

- [ ] **Step 2: Manual test — Authenticate flow**

1. Open `http://localhost:3000/login`, sign in
2. On report page, enter a Wallet ID and Password
3. Click "Authenticate"
4. Expected: Green badge "Authenticated (key: ****xxxx)" appears
5. Expected: `localStorage.getItem('hfm_api_key')` returns a value in browser console
6. Expected: Wallet ID and Password fields become read-only
7. Expected: Button changes to "Re-authenticate"

- [ ] **Step 3: Manual test — Re-authenticate flow**

1. Click "Re-authenticate"
2. Expected: Badge disappears, fields become editable, password cleared
3. Expected: `localStorage.getItem('hfm_api_key')` returns null
4. Enter new credentials, click "Authenticate" again
5. Expected: New key saved

- [ ] **Step 4: Manual test — Export with cached key**

1. With authenticated state, select a date range
2. Click "Export to Excel"
3. Expected: Export succeeds (or shows meaningful error if key expired)
4. Expected: No `/api/authenticate` call in network tab during export

- [ ] **Step 5: Manual test — Page reload persistence**

1. Reload the page
2. Expected: Green badge still shows, fields still read-only
3. Expected: Export still works without re-authenticating

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: HFM API auth button with localStorage caching"
```
