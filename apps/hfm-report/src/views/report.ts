export function reportPage(error?: string, _success?: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HFM Report — Export</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d1117;
      --surface:   #161b22;
      --surface2:  #1c2128;
      --border:    #30363d;
      --accent:    #f0a500;
      --accent-lo: rgba(240, 165, 0, 0.10);
      --text:      #e6edf3;
      --muted:     #7d8590;
      --err-bg:    rgba(248, 81, 73, 0.08);
      --err-bd:    rgba(248, 81, 73, 0.35);
      --err-tx:    #f85149;
      --font:      'JetBrains Mono', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* dot-grid */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, #30363d 1px, transparent 1px);
      background-size: 28px 28px;
      opacity: 0.35;
      pointer-events: none;
      z-index: 0;
    }

    /* ── Topbar ── */
    .topbar {
      position: relative;
      z-index: 10;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-badge {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: #000;
      letter-spacing: -0.5px;
      flex-shrink: 0;
    }

    .topbar-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }
    .topbar-divider {
      color: var(--border);
      font-size: 18px;
      margin: 0 2px;
    }
    .topbar-page {
      font-size: 12px;
      color: var(--muted);
    }

    .btn-logout {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--muted);
      font-family: var(--font);
      font-size: 11px;
      padding: 6px 12px;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }
    .btn-logout:hover { border-color: var(--err-tx); color: var(--err-tx); }

    /* ── Main ── */
    .main {
      position: relative;
      z-index: 1;
      flex: 1;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 16px;
    }

    .container {
      width: 100%;
      max-width: 520px;
    }

    /* ── Alert ── */
    .alert {
      border-radius: 7px;
      padding: 12px 16px;
      font-size: 12px;
      margin-bottom: 20px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      animation: fadeIn 0.3s ease;
    }
    .alert-error {
      background: var(--err-bg);
      border: 1px solid var(--err-bd);
      color: var(--err-tx);
    }
    @keyframes fadeIn { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform: translateY(0); } }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 16px;
    }

    .card-header {
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .card-header-icon {
      font-size: 14px;
      width: 28px;
      height: 28px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-header-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--muted);
    }

    .card-body {
      padding: 20px;
    }

    /* ── Fields ── */
    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .field { margin-bottom: 14px; }
    .field:last-child { margin-bottom: 0; }

    .field label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }

    .field input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 12px;
      font-family: var(--font);
      font-size: 13px;
      color: var(--text);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      -webkit-appearance: none;
    }

    .field input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-lo);
    }

    .field input::placeholder { color: var(--muted); opacity: 0.5; }

    .field select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 9px 12px;
      font-family: var(--font);
      font-size: 13px;
      color: var(--text);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      -webkit-appearance: none;
      cursor: pointer;
    }

    .field select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-lo);
    }

    /* date input color fix */
    .field input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(0.5);
      cursor: pointer;
    }

    /* ── Week shortcuts ── */
    .week-shortcuts {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .btn-week {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--text);
      font-family: var(--font);
      font-size: 11px;
      font-weight: 500;
      padding: 6px 14px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .btn-week:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-lo);
    }

    /* ── Week badge ── */
    .week-badge {
      margin-top: 14px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 40px;
    }

    .week-badge-label {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      flex-shrink: 0;
    }

    .week-badge-value {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
    }

    /* ── Export button ── */
    .btn-export {
      width: 100%;
      padding: 14px;
      background: var(--accent);
      border: none;
      border-radius: 8px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 700;
      color: #000;
      cursor: pointer;
      letter-spacing: 0.4px;
      transition: opacity 0.15s, transform 0.1s;
      margin-top: 4px;
    }
    .btn-export:hover  { opacity: 0.88; }
    .btn-export:active { transform: scale(0.99); }
    .btn-export:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

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

    /* ── Info footer ── */
    .info-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 16px;
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 0.3px;
    }
    .info-dot { color: var(--border); }
  </style>
</head>
<body>
  <!-- Topbar -->
  <header class="topbar">
    <div class="topbar-left">
      <div class="logo-badge">HF</div>
      <span class="topbar-title">HFM Report</span>
      <span class="topbar-divider">/</span>
      <span class="topbar-page">Client Performance Export</span>
    </div>
    <form method="POST" action="/logout">
      <button class="btn-logout" type="submit">Sign Out</button>
    </form>
  </header>

  <main class="main">
    <div class="container">

      <!-- Error alert -->
      ${error ? `
      <div class="alert alert-error">
        <span>⚠</span>
        <span>${escapeHtml(error)}</span>
      </div>` : ''}

      <form id="export-form" method="POST" action="/report/export">
        <input type="hidden" name="api_key" id="api_key_field">

        <!-- API Credentials -->
        <div class="card">
          <div class="card-header">
            <div class="card-header-icon">🔑</div>
            <span class="card-header-title">HFM API Credentials</span>
          </div>
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
        </div>

        <!-- Date Range -->
        <div class="card">
          <div class="card-header">
            <div class="card-header-icon">📅</div>
            <span class="card-header-title">Date Range (Weekly)</span>
          </div>
          <div class="card-body">
            <!-- Quick shortcuts -->
            <div class="week-shortcuts">
              <button class="btn-week" type="button" id="btn-this-week">สัปดาห์นี้</button>
              <button class="btn-week" type="button" id="btn-last-week">สัปดาห์ที่แล้ว</button>
            </div>

            <div class="field-row">
              <div class="field">
                <label for="from_date">From (จันทร์)</label>
                <input
                  id="from_date"
                  type="date"
                  name="from_date"
                  required
                >
              </div>
              <div class="field">
                <label for="to_date">To (อาทิตย์)</label>
                <input
                  id="to_date"
                  type="date"
                  name="to_date"
                  required
                >
              </div>
            </div>

            <!-- Week info badge -->
            <div class="week-badge">
              <span class="week-badge-label">Selected</span>
              <span class="week-badge-value" id="week-info">—</span>
            </div>
          </div>
        </div>

        <!-- Sort By -->
        <div class="card">
          <div class="card-header">
            <div class="card-header-icon">↕️</div>
            <span class="card-header-title">Sort By</span>
          </div>
          <div class="card-body">
            <div class="field-row">
              <div class="field">
                <label for="sort_by">Column</label>
                <select id="sort_by" name="sort_by">
                  <option value="">No Sort</option>
                  <option value="wallet_id">Wallet ID</option>
                  <option value="account_id">Account ID</option>
                  <option value="account_type">Account Type</option>
                  <option value="trading_lots">Trading Lots</option>
                </select>
              </div>
              <div class="field">
                <label for="sort_dir">Direction</label>
                <select id="sort_dir" name="sort_dir">
                  <option value="desc">High to Low (Z → A)</option>
                  <option value="asc">Low to High (A → Z)</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- Export -->
        <button class="btn-export" type="submit" id="export-btn">
          ↓ Export to Excel (.xlsx)
        </button>

      </form>

      <div class="info-row">
        <span>Columns: Wallet ID, Account ID, Account Type, Trading Lots</span>
        <span class="info-dot">·</span>
        <span>Max session 8 hrs</span>
      </div>
    </div>
  </main>

  <script>
    // ─── Date helpers ────────────────────────────────────────────────

    /** Returns YYYY-MM-DD string for the Monday of the week containing dateStr */
    function toMonday(dateStr) {
      const d = new Date(dateStr + 'T12:00:00')
      const day = d.getDay() || 7       // treat Sunday (0) as 7
      if (day !== 1) d.setDate(d.getDate() - (day - 1))
      return d.toISOString().split('T')[0]
    }

    /** Returns YYYY-MM-DD string for the Sunday of the week containing dateStr */
    function toSunday(dateStr) {
      const d = new Date(dateStr + 'T12:00:00')
      const day = d.getDay()
      if (day !== 0) d.setDate(d.getDate() + (7 - day))
      return d.toISOString().split('T')[0]
    }

    /** ISO week number */
    function isoWeek(dateStr) {
      const d = new Date(dateStr + 'T12:00:00')
      d.setDate(d.getDate() + 4 - (d.getDay() || 7))
      const yearStart = new Date(d.getFullYear(), 0, 1)
      return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
    }

    /** Thai-locale date display */
    function fmtTH(dateStr) {
      return new Date(dateStr + 'T12:00:00').toLocaleDateString('th-TH', {
        day: 'numeric', month: 'short', year: 'numeric'
      })
    }

    // ─── Elements ────────────────────────────────────────────────────

    const fromInput = document.getElementById('from_date')
    const toInput   = document.getElementById('to_date')
    const weekInfo  = document.getElementById('week-info')
    const exportBtn = document.getElementById('export-btn')

    // ─── Update badge ────────────────────────────────────────────────

    function updateBadge() {
      const f = fromInput.value
      const t = toInput.value
      if (f && t) {
        const wk = isoWeek(f)
        weekInfo.textContent = 'Week ' + wk + ' · ' + fmtTH(f) + ' — ' + fmtTH(t)
      } else {
        weekInfo.textContent = '—'
      }
    }

    // ─── Snap logic ──────────────────────────────────────────────────

    fromInput.addEventListener('change', () => {
      if (!fromInput.value) return
      fromInput.value = toMonday(fromInput.value)
      toInput.value   = toSunday(fromInput.value)
      updateBadge()
    })

    toInput.addEventListener('change', () => {
      if (!toInput.value) return
      toInput.value = toSunday(toInput.value)
      // if to < from, move from back to same week's Monday
      if (fromInput.value && toInput.value < fromInput.value) {
        fromInput.value = toMonday(toInput.value)
      }
      updateBadge()
    })

    // ─── Shortcuts ───────────────────────────────────────────────────

    document.getElementById('btn-this-week').addEventListener('click', () => {
      const today = new Date().toISOString().split('T')[0]
      fromInput.value = toMonday(today)
      toInput.value   = toSunday(today)
      updateBadge()
    })

    document.getElementById('btn-last-week').addEventListener('click', () => {
      const d = new Date()
      d.setDate(d.getDate() - 7)
      const last = d.toISOString().split('T')[0]
      fromInput.value = toMonday(last)
      toInput.value   = toSunday(last)
      updateBadge()
    })

    // ─── Loading state on submit ─────────────────────────────────────

    document.getElementById('export-form').addEventListener('submit', () => {
      exportBtn.disabled    = true
      exportBtn.textContent = '⏳ Fetching & Generating...'
      setTimeout(() => {
        exportBtn.disabled    = false
        exportBtn.textContent = 'Export Excel'
      }, 5000)
    })

    // ─── Init with current week ──────────────────────────────────────

    ;(function init() {
      const today = new Date().toISOString().split('T')[0]
      fromInput.value = toMonday(today)
      toInput.value   = toSunday(today)
      updateBadge()
    })()

    // ─── HFM Authentication ───────────────────────────────────────────

    const authBtn    = document.getElementById('auth-btn')
    const authStatus = document.getElementById('auth-status')
    const authIcon   = document.getElementById('auth-status-icon')
    const authText   = document.getElementById('auth-status-text')
    const walletInput = document.getElementById('wallet_id')
    const passInput   = document.getElementById('api_password')
    const apiKeyField = document.getElementById('api_key_field')

    function showAuthSuccess(key, walletId) {
      authStatus.classList.remove('hidden', 'auth-error')
      authStatus.classList.add('auth-success')
      authIcon.textContent = '✓'
      authText.textContent = 'Authenticated (key: ****' + key.slice(-4) + ')'
      if (walletId) walletInput.value = walletId
      walletInput.readOnly = true
      passInput.readOnly   = true
      authBtn.textContent  = 'Clear credentials'
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
      localStorage.removeItem('hfm_wallet_id')
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: walletId, password }),
        })

        const data = await res.json()

        if (res.ok && data.api_key) {
          localStorage.setItem('hfm_api_key', data.api_key)
          localStorage.setItem('hfm_wallet_id', walletId)
          apiKeyField.value = data.api_key
          showAuthSuccess(data.api_key, walletId)
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
      const savedWallet = localStorage.getItem('hfm_wallet_id')
      if (saved) {
        apiKeyField.value = saved
        showAuthSuccess(saved, savedWallet)
      }
    })()

    // Populate api_key on form submit
    document.getElementById('export-form').addEventListener('submit', (e) => {
      const key = localStorage.getItem('hfm_api_key')
      if (!key) {
        e.preventDefault()
        exportBtn.disabled    = false
        exportBtn.textContent = 'Export Excel'
        showAuthError('กรุณา Authenticate ก่อน Export')
        return
      }
      apiKeyField.value = key
    })
  </script>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
