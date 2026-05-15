export function loginPage(error?: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HFM Report — Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:         #0d1117;
      --surface:    #161b22;
      --border:     #30363d;
      --accent:     #f0a500;
      --text:       #e6edf3;
      --muted:      #7d8590;
      --error-bg:   rgba(248, 81, 73, 0.08);
      --error-bd:   rgba(248, 81, 73, 0.35);
      --error-tx:   #f85149;
      --font:       'JetBrains Mono', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    /* dot-grid background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, #30363d 1px, transparent 1px);
      background-size: 28px 28px;
      opacity: 0.45;
      pointer-events: none;
    }

    /* vignette */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background: radial-gradient(ellipse at center, transparent 40%, var(--bg) 100%);
      pointer-events: none;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 40px 36px;
      width: 100%;
      max-width: 380px;
      position: relative;
      z-index: 1;
      animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(24px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0)   scale(1); }
    }

    /* amber top-bar accent */
    .card::before {
      content: '';
      position: absolute;
      top: -1px; left: 24px; right: 24px;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      border-radius: 0 0 4px 4px;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 34px;
    }

    .logo-badge {
      width: 42px;
      height: 42px;
      background: var(--accent);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 700;
      color: #000;
      flex-shrink: 0;
      letter-spacing: -1px;
    }

    .header-copy {}
    .header-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.3px;
      color: var(--text);
    }
    .header-sub {
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 1.2px;
      text-transform: uppercase;
      margin-top: 2px;
    }

    /* ── Form heading ── */
    .section-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1.4px;
      margin-bottom: 20px;
    }

    /* ── Error ── */
    .alert-error {
      background: var(--error-bg);
      border: 1px solid var(--error-bd);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 12px;
      color: var(--error-tx);
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Inputs ── */
    .field { margin-bottom: 14px; }

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
      padding: 10px 13px;
      font-family: var(--font);
      font-size: 13px;
      color: var(--text);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .field input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(240, 165, 0, 0.12);
    }

    .field input::placeholder { color: var(--muted); opacity: 0.6; }

    /* ── Submit ── */
    .btn-submit {
      width: 100%;
      margin-top: 8px;
      padding: 12px;
      background: var(--accent);
      border: none;
      border-radius: 6px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 700;
      color: #000;
      cursor: pointer;
      letter-spacing: 0.4px;
      transition: opacity 0.15s, transform 0.1s;
    }
    .btn-submit:hover  { opacity: 0.88; }
    .btn-submit:active { transform: scale(0.98); }

    /* ── Footer ── */
    .card-footer {
      margin-top: 24px;
      text-align: center;
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo-badge">HF</div>
      <div class="header-copy">
        <div class="header-title">HFM Report</div>
        <div class="header-sub">Internal Tool</div>
      </div>
    </div>

    <div class="section-label">Sign In</div>

    ${error ? `
    <div class="alert-error">
      <span>⚠</span>
      <span>${escapeHtml(error)}</span>
    </div>` : ''}

    <form method="POST" action="/login">
      <div class="field">
        <label for="username">Username</label>
        <input
          id="username"
          type="text"
          name="username"
          placeholder="username"
          required
          autocomplete="username"
          autofocus
        >
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          type="password"
          name="password"
          placeholder="••••••••"
          required
          autocomplete="current-password"
        >
      </div>
      <button class="btn-submit" type="submit">Sign In →</button>
    </form>

    <div class="card-footer">HFM Affiliates · Internal Use Only</div>
  </div>
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
