import type { CompareResult } from "../lib/wallet-compare";

export interface WalletComparisonResult {
  result: CompareResult;
  fromRequested: string;
  toRequested: string;
  fromSnapped: boolean;
  toSnapped: boolean;
}

function fmtTH(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function pctStr(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function sign(n: number): string {
  return n > 0 ? "+" : "";
}

export function walletComparisonPage(options: {
  error?: string;
  result?: WalletComparisonResult;
  fromDefault?: string;
  toDefault?: string;
}): string {
  const { error, result, fromDefault, toDefault } = options;

  return /* html */ `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HFM Report — Wallet Comparison</title>
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
      --pos:       #3fb950;
      --pos-lo:    rgba(63, 185, 80, 0.10);
      --pos-bd:    rgba(63, 185, 80, 0.35);
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

    .nav-tabs {
      display: flex;
      gap: 4px;
    }
    .nav-tab {
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      padding: 6px 12px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s;
    }
    .nav-tab:hover { color: var(--text); border-color: var(--border); }
    .nav-tab.active {
      color: var(--accent);
      background: var(--accent-lo);
      border-color: rgba(240, 165, 0, 0.35);
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
      margin-left: 10px;
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
      max-width: 720px;
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
    .alert-warn {
      background: var(--accent-lo);
      border: 1px solid rgba(240, 165, 0, 0.35);
      color: var(--accent);
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

    .card-body { padding: 20px; }

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

    .field input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(0.5);
      cursor: pointer;
    }

    .field-hint {
      font-size: 10px;
      color: var(--muted);
      margin-top: 6px;
      line-height: 1.5;
    }

    /* ── Submit ── */
    .btn-submit {
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
    .btn-submit:hover  { opacity: 0.88; }
    .btn-submit:active { transform: scale(0.99); }
    .btn-submit:disabled { opacity: 0.55; cursor: not-allowed; }

    /* ── KPI ── */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 4px;
    }
    .kpi {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .kpi-label {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
      line-height: 1;
    }
    .kpi-sub {
      font-size: 10px;
      color: var(--muted);
      margin-top: 6px;
    }
    .kpi-delta-up   { color: var(--pos); }
    .kpi-delta-down { color: var(--err-tx); }

    /* ── Wallet lists ── */
    .wallet-section { margin-top: 18px; }
    .wallet-section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .wallet-count {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--text);
    }
    .wallet-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .wallet-chip {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--text);
    }
    .wallet-chip.missing {
      border-color: var(--err-bd);
      color: var(--err-tx);
      background: var(--err-bg);
    }
    .wallet-chip.new {
      border-color: var(--pos-bd);
      color: var(--pos);
      background: var(--pos-lo);
    }
    .wallet-empty {
      font-size: 12px;
      color: var(--muted);
      font-style: italic;
    }
    .wallet-more {
      font-size: 11px;
      color: var(--muted);
      margin-top: 8px;
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
      <span class="topbar-page">Wallet Comparison</span>
    </div>
    <div style="display:flex; align-items:center;">
      <nav class="nav-tabs">
        <a class="nav-tab" href="/report">Performance Export</a>
        <a class="nav-tab active" href="/wallet-comparison">Wallet Comparison</a>
      </nav>
      <form method="POST" action="/logout">
        <button class="btn-logout" type="submit">Sign Out</button>
      </form>
    </div>
  </header>

  <main class="main">
    <div class="container">

      ${error ? `
      <div class="alert alert-error">
        <span>⚠</span>
        <span>${escapeHtml(error)}</span>
      </div>` : ''}

      <form id="compare-form" method="POST" action="/wallet-comparison">
        <div class="card">
          <div class="card-header">
            <div class="card-header-icon">📅</div>
            <span class="card-header-title">Date Range (Snapshot Comparison)</span>
          </div>
          <div class="card-body">
            <div class="field-row">
              <div class="field">
                <label for="from_date">From (baseline)</label>
                <input id="from_date" type="date" name="from_date" required value="${fromDefault ?? ''}">
              </div>
              <div class="field">
                <label for="to_date">To (target)</label>
                <input id="to_date" type="date" name="to_date" required value="${toDefault ?? ''}">
              </div>
            </div>
            <div class="field-hint">
              เปรียบเทียบ Wallet ที่อยู่ในระบบ ณ วันที่เริ่มต้น กับ วันที่สิ้นสุด<br>
              ถ้าไม่มี snapshot ของวันที่เลือก ระบบจะใช้ snapshot ล่าสุดก่อนหน้าอัตโนมัติ
            </div>
          </div>
        </div>

        <button class="btn-submit" type="submit" id="submit-btn">
          → Compare Wallets
        </button>
      </form>

      ${result ? renderResult(result) : ''}

      <div class="info-row">
        <span>Source: client_snapshots (Postgres)</span>
        <span class="info-dot">·</span>
        <span>Read-only</span>
      </div>
    </div>
  </main>

  <script>
    document.getElementById('compare-form').addEventListener('submit', () => {
      const b = document.getElementById('submit-btn');
      b.disabled = true;
      b.textContent = '⏳ Comparing...';
      setTimeout(() => { b.disabled = false; b.textContent = '→ Compare Wallets'; }, 6000);
    });
  </script>
</body>
</html>`;
}

function renderResult(r: WalletComparisonResult): string {
  const res = r.result;
  const deltaClass =
    res.delta > 0 ? "kpi-delta-up" : res.delta < 0 ? "kpi-delta-down" : "";

  const notices: string[] = [];
  if (r.fromSnapped)
    notices.push(`From: ไม่มี snapshot ของวันที่เลือก ใช้ ${fmtTH(res.fromDate)} แทน`);
  if (r.toSnapped)
    notices.push(`To: ไม่มี snapshot ของวันที่เลือก ใช้ ${fmtTH(res.toDate)} แทน`);

  const noticeBlock = notices.length
    ? notices
        .map(
          (n) => `<div class="alert alert-warn"><span>ℹ</span><span>${escapeHtml(n)}</span></div>`,
        )
        .join("")
    : "";

  const missingBlock = res.missingIds.length
    ? `<div class="wallet-chips">${res.missingIds
        .slice(0, 200)
        .map((id) => `<span class="wallet-chip missing">${id}</span>`)
        .join("")}</div>${
        res.missingIds.length > 200
          ? `<div class="wallet-more">… และอีก ${res.missingIds.length - 200} รายการ</div>`
          : ""
      }`
    : `<div class="wallet-empty">— ไม่มี —</div>`;

  const newBlock = res.newIds.length
    ? `<div class="wallet-chips">${res.newIds
        .slice(0, 200)
        .map((id) => `<span class="wallet-chip new">${id}</span>`)
        .join("")}</div>${
        res.newIds.length > 200
          ? `<div class="wallet-more">… และอีก ${res.newIds.length - 200} รายการ</div>`
          : ""
      }`
    : `<div class="wallet-empty">— ไม่มี —</div>`;

  return `
      ${noticeBlock}

      <div class="card">
        <div class="card-header">
          <div class="card-header-icon">📊</div>
          <span class="card-header-title">Comparison Result</span>
        </div>
        <div class="card-body">
          <div class="kpi-grid">
            <div class="kpi">
              <div class="kpi-label">From</div>
              <div class="kpi-value">${res.fromCount}</div>
              <div class="kpi-sub">${escapeHtml(res.fromLabel)} · ${fmtTH(res.fromDate)}</div>
            </div>
            <div class="kpi">
              <div class="kpi-label">To</div>
              <div class="kpi-value">${res.toCount}</div>
              <div class="kpi-sub">${escapeHtml(res.toLabel)} · ${fmtTH(res.toDate)}</div>
            </div>
            <div class="kpi">
              <div class="kpi-label">Change</div>
              <div class="kpi-value ${deltaClass}">${sign(res.delta)}${res.delta}</div>
              <div class="kpi-sub">${pctStr(res.pct)}</div>
            </div>
          </div>

          <div class="wallet-section">
            <div class="wallet-section-title">
              <span>Missing Wallets</span>
              <span class="wallet-count">${res.missingIds.length}</span>
            </div>
            ${missingBlock}
          </div>

          <div class="wallet-section">
            <div class="wallet-section-title">
              <span>New Wallets</span>
              <span class="wallet-count">${res.newIds.length}</span>
            </div>
            ${newBlock}
          </div>
        </div>
      </div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
