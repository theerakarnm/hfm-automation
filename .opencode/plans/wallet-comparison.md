# Wallet Comparison Tab — hfm-report

Replicates `reportday/week/month` (wallet churn: counts + change % + missing/new wallet lists) but with a **user-picked from→to date range** comparing **two historical Postgres snapshots**, rendered **inline as HTML**.

> NOTE: Source-file edits are currently blocked in this session by a permission rule
> (only `.opencode/plans/*.md` is writable). To apply this directly, re-run after enabling
> edits, or paste the snippets below into the listed files.

## Decisions
- Connect hfm-report to Postgres (read-only SELECTs on `client_snapshots`)
- Compare two historical snapshots (from-date set vs to-date set)
- Render results inline; snap missing dates to nearest prior snapshot with a notice
- Versions match api: `drizzle-orm@^0.45.2`, `postgres@^3.4.9`

---

## 1. `apps/hfm-report/package.json` — add deps

```json
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "hono": "^4.6.0",
    "postgres": "^3.4.9",
    "xlsx": "^0.18.5"
  },
```

## 2. `apps/hfm-report/.env.example` — append

```
# ── Postgres (read snapshots written by apps/api) ─────────────────────────────
DATABASE_URL=postgresql://user:password@host:port/database
```

## 3. NEW `apps/hfm-report/src/db/schema.ts`

```ts
import { pgTable, serial, text, integer, timestamp, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const clientSnapshots = pgTable(
  "client_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotDate: text("snapshot_date").notNull(),
    clientId: integer("client_id").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (t) => [
    unique("client_snapshots_snapshot_date_client_id_unique").on(t.snapshotDate, t.clientId),
    index("idx_snapshot_date").on(t.snapshotDate),
  ],
);
```

## 4. NEW `apps/hfm-report/src/db/connection.ts`

```ts
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(url?: string): DrizzleDb {
  if (_db) return _db;
  const connUrl = url ?? Bun.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");
  _client = postgres(connUrl, { max: 5 });
  _db = drizzle(_client, { schema });
  return _db;
}
```

## 5. NEW `apps/hfm-report/src/repositories/snapshot.repository.ts`

```ts
import { eq, lt, count, desc } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { clientSnapshots } from "../db/schema";

export async function countByDate(db: DrizzleDb, date: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(clientSnapshots)
    .where(eq(clientSnapshots.snapshotDate, date));
  return rows[0]?.count ?? 0;
}

export async function getWalletIdsByDate(db: DrizzleDb, date: string): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ clientId: clientSnapshots.clientId })
    .from(clientSnapshots)
    .where(eq(clientSnapshots.snapshotDate, date));
  return new Set(rows.map((r) => r.clientId));
}

/** Nearest snapshot date strictly before `date` (for snap fallback). */
export async function getNearestSnapshotDateBefore(
  db: DrizzleDb,
  date: string,
): Promise<string | null> {
  const rows = await db
    .selectDistinct({ date: clientSnapshots.snapshotDate })
    .from(clientSnapshots)
    .where(lt(clientSnapshots.snapshotDate, date))
    .orderBy(desc(clientSnapshots.snapshotDate))
    .limit(1);
  return rows[0]?.date ?? null;
}
```

## 6. NEW `apps/hfm-report/src/lib/wallet-compare.ts`

```ts
export interface CompareInput {
  fromLabel: string;
  fromDate: string;
  fromCount: number;
  toLabel: string;
  toDate: string;
  toCount: number;
  fromIds: Set<number>;
  toIds: Set<number>;
}

export interface CompareResult {
  fromLabel: string;
  fromDate: string;
  fromCount: number;
  toLabel: string;
  toDate: string;
  toCount: number;
  delta: number;
  pct: number | null;
  missingIds: number[];
  newIds: number[];
}

export function compareWalletSets(input: CompareInput): CompareResult {
  const missingIds: number[] = [];
  for (const id of input.fromIds) if (!input.toIds.has(id)) missingIds.push(id);
  missingIds.sort((a, b) => a - b);

  const newIds: number[] = [];
  for (const id of input.toIds) if (!input.fromIds.has(id)) newIds.push(id);
  newIds.sort((a, b) => a - b);

  const delta = input.toCount - input.fromCount;
  const pct = input.fromCount > 0 ? (delta / input.fromCount) * 100 : null;

  return {
    fromLabel: input.fromLabel,
    fromDate: input.fromDate,
    fromCount: input.fromCount,
    toLabel: input.toLabel,
    toDate: input.toDate,
    toCount: input.toCount,
    delta,
    pct,
    missingIds,
    newIds,
  };
}
```

## 7. NEW `apps/hfm-report/src/views/wallet-comparison.ts`

Reuses the dark theme from `report.ts`. Renders form + optional result + tab nav.

```ts
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
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

function pctStr(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function sign(n: number): string {
  return n > 0 ? "+" : "";
}

function walletList(ids: number[]): string {
  if (ids.length === 0) {
    return `<div class="wallet-empty">— ไม่มี —</div>`;
  }
  const shown = ids.slice(0, 200);
  const chips = shown
    .map((id) => `<span class="wallet-chip">${id}</span>`)
    .join("");
  const more =
    ids.length > 200 ? `<div class="wallet-more">… และอีก ${ids.length - 200} รายการ</div>` : "";
  return `<div class="wallet-chips">${chips}</div>${more}`;
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
      --bg:#0d1117; --surface:#161b22; --surface2:#1c2128; --border:#30363d;
      --accent:#f0a500; --accent-lo:rgba(240,165,0,0.10);
      --text:#e6edf3; --muted:#7d8590;
      --err-bg:rgba(248,81,73,0.08); --err-bd:rgba(248,81,73,0.35); --err-tx:#f85149;
      --pos:#3fb950; --pos-lo:rgba(63,185,80,0.10); --pos-bd:rgba(63,185,80,0.35);
      --font:'JetBrains Mono', monospace;
    }
    body { background:var(--bg); color:var(--text); font-family:var(--font); min-height:100vh; display:flex; flex-direction:column; }
    body::before { content:''; position:fixed; inset:0; background-image:radial-gradient(circle,#30363d 1px,transparent 1px); background-size:28px 28px; opacity:0.35; pointer-events:none; z-index:0; }

    .topbar { position:relative; z-index:10; background:var(--surface); border-bottom:1px solid var(--border); padding:0 24px; height:54px; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
    .topbar-left { display:flex; align-items:center; gap:12px; }
    .logo-badge { width:32px; height:32px; background:var(--accent); border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#000; letter-spacing:-0.5px; flex-shrink:0; }
    .topbar-title { font-size:14px; font-weight:700; letter-spacing:-0.2px; }
    .topbar-divider { color:var(--border); font-size:18px; margin:0 2px; }
    .topbar-page { font-size:12px; color:var(--muted); }
    .nav-tabs { display:flex; gap:4px; }
    .nav-tab { font-family:var(--font); font-size:11px; font-weight:600; color:var(--muted); background:transparent; border:1px solid transparent; border-radius:5px; padding:6px 12px; text-decoration:none; cursor:pointer; transition:all 0.15s; }
    .nav-tab:hover { color:var(--text); border-color:var(--border); }
    .nav-tab.active { color:var(--accent); background:var(--accent-lo); border-color:rgba(240,165,0,0.35); }
    .btn-logout { background:transparent; border:1px solid var(--border); border-radius:5px; color:var(--muted); font-family:var(--font); font-size:11px; padding:6px 12px; cursor:pointer; transition:border-color 0.15s, color 0.15s; margin-left:10px; }
    .btn-logout:hover { border-color:var(--err-tx); color:var(--err-tx); }

    .main { position:relative; z-index:1; flex:1; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; }
    .container { width:100%; max-width:720px; }

    .alert { border-radius:7px; padding:12px 16px; font-size:12px; margin-bottom:20px; display:flex; align-items:flex-start; gap:10px; animation:fadeIn 0.3s ease; }
    .alert-error { background:var(--err-bg); border:1px solid var(--err-bd); color:var(--err-tx); }
    .alert-warn { background:var(--accent-lo); border:1px solid rgba(240,165,0,0.35); color:var(--accent); }
    @keyframes fadeIn { from{opacity:0; transform:translateY(-6px);} to{opacity:1; transform:translateY(0);} }

    .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:16px; }
    .card-header { padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; }
    .card-header-icon { font-size:14px; width:28px; height:28px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; display:flex; align-items:center; justify-content:center; }
    .card-header-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1.2px; color:var(--muted); }
    .card-body { padding:20px; }

    .field-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .field { margin-bottom:14px; }
    .field:last-child { margin-bottom:0; }
    .field label { display:block; font-size:10px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
    .field input { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:9px 12px; font-family:var(--font); font-size:13px; color:var(--text); outline:none; transition:border-color 0.15s, box-shadow 0.15s; -webkit-appearance:none; }
    .field input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-lo); }
    .field input[type="date"]::-webkit-calendar-picker-indicator { filter:invert(0.5); cursor:pointer; }
    .field-hint { font-size:10px; color:var(--muted); margin-top:6px; line-height:1.4; }

    .btn-submit { width:100%; padding:14px; background:var(--accent); border:none; border-radius:8px; font-family:var(--font); font-size:13px; font-weight:700; color:#000; cursor:pointer; letter-spacing:0.4px; transition:opacity 0.15s, transform 0.1s; margin-top:4px; }
    .btn-submit:hover { opacity:0.88; }
    .btn-submit:active { transform:scale(0.99); }
    .btn-submit:disabled { opacity:0.55; cursor:not-allowed; }

    .kpi-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:4px; }
    .kpi { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:14px; }
    .kpi-label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
    .kpi-value { font-size:22px; font-weight:700; color:var(--text); line-height:1; }
    .kpi-sub { font-size:10px; color:var(--muted); margin-top:6px; }
    .kpi-delta-up { color:var(--pos); }
    .kpi-delta-down { color:var(--err-tx); }

    .wallet-section { margin-top:18px; }
    .wallet-section-title { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
    .wallet-count { background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:2px 8px; font-size:11px; color:var(--text); }
    .wallet-chips { display:flex; flex-wrap:wrap; gap:6px; }
    .wallet-chip { background:var(--surface2); border:1px solid var(--border); border-radius:5px; padding:4px 8px; font-size:11px; color:var(--text); }
    .wallet-chip.missing { border-color:var(--err-bd); color:var(--err-tx); background:var(--err-bg); }
    .wallet-chip.new { border-color:var(--pos-bd); color:var(--pos); background:var(--pos-lo); }
    .wallet-empty { font-size:12px; color:var(--muted); font-style:italic; }
    .wallet-more { font-size:11px; color:var(--muted); margin-top:8px; }

    .info-row { display:flex; align-items:center; justify-content:center; gap:8px; margin-top:16px; font-size:10px; color:var(--muted); letter-spacing:0.3px; }
    .info-dot { color:var(--border); }
  </style>
</head>
<body>
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
      ${error ? `<div class="alert alert-error"><span>⚠</span><span>${escapeHtml(error)}</span></div>` : ""}

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
                <input id="from_date" type="date" name="from_date" required value="${fromDefault ?? ""}">
              </div>
              <div class="field">
                <label for="to_date">To (target)</label>
                <input id="to_date" type="date" name="to_date" required value="${toDefault ?? ""}">
              </div>
            </div>
            <div class="field-hint">
              เปรียบเทียบ Wallet ที่อยู่ในระบบ ณ วันที่เริ่มต้น กับ วันที่สิ้นสุด<br>
              ถ้าไม่มี snapshot ของวันที่เลือก ระบบจะใช้ snapshot ล่าสุดก่อนหน้าอัตโนมัติ
            </div>
          </div>
        </div>
        <button class="btn-submit" type="submit" id="submit-btn">→ Compare Wallets</button>
      </form>

      ${
        result
          ? renderResult(result)
          : ""
      }

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
  const deltaClass = res.delta > 0 ? "kpi-delta-up" : res.delta < 0 ? "kpi-delta-down" : "";
  const notices: string[] = [];
  if (r.fromSnapped)
    notices.push(`From: ไม่มี snapshot ของวันที่เลือก ใช้ ${fmtTH(res.fromDate)} แทน`);
  if (r.toSnapped)
    notices.push(`To: ไม่มี snapshot ของวันที่เลือก ใช้ ${fmtTH(res.toDate)} แทน`);

  return `
      ${
        notices.length
          ? notices
              .map((n) => `<div class="alert alert-warn"><span>ℹ</span><span>${escapeHtml(n)}</span></div>`)
              .join("")
          : ""
      }

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
            ${
              res.missingIds.length
                ? `<div class="wallet-chips">${res.missingIds.slice(0, 200).map((id) => `<span class="wallet-chip missing">${id}</span>`).join("")}</div>${res.missingIds.length > 200 ? `<div class="wallet-more">… และอีก ${res.missingIds.length - 200} รายการ</div>` : ""}`
                : `<div class="wallet-empty">— ไม่มี —</div>`
            }
          </div>

          <div class="wallet-section">
            <div class="wallet-section-title">
              <span>New Wallets</span>
              <span class="wallet-count">${res.newIds.length}</span>
            </div>
            ${
              res.newIds.length
                ? `<div class="wallet-chips">${res.newIds.slice(0, 200).map((id) => `<span class="wallet-chip new">${id}</span>`).join("")}</div>${res.newIds.length > 200 ? `<div class="wallet-more">… และอีก ${res.newIds.length - 200} รายการ</div>` : ""}`
                : `<div class="wallet-empty">— ไม่มี —</div>`
            }
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
```

## 8. `apps/hfm-report/src/views/report.ts` — add tab nav in topbar

Replace the existing topbar `<header>` block (around line 413) with:

```html
  <header class="topbar">
    <div class="topbar-left">
      <div class="logo-badge">HF</div>
      <span class="topbar-title">HFM Report</span>
      <span class="topbar-divider">/</span>
      <span class="topbar-page">Client Performance Export</span>
    </div>
    <div style="display:flex; align-items:center;">
      <nav class="nav-tabs">
        <a class="nav-tab active" href="/report">Performance Export</a>
        <a class="nav-tab" href="/wallet-comparison">Wallet Comparison</a>
      </nav>
      <form method="POST" action="/logout">
        <button class="btn-logout" type="submit">Sign Out</button>
      </form>
    </div>
  </header>
```

And append these nav styles to the `<style>` block (e.g. right before `/* ── Topbar ── */`):

```css
    .nav-tabs { display:flex; gap:4px; }
    .nav-tab { font-family:var(--font); font-size:11px; font-weight:600; color:var(--muted); background:transparent; border:1px solid transparent; border-radius:5px; padding:6px 12px; text-decoration:none; cursor:pointer; transition:all 0.15s; }
    .nav-tab:hover { color:var(--text); border-color:var(--border); }
    .nav-tab.active { color:var(--accent); background:var(--accent-lo); border-color:rgba(240,165,0,0.35); }
```

## 9. `apps/hfm-report/src/index.ts` — add routes + imports

Add imports near the top:

```ts
import { reportPage } from "./views/report";
import { walletComparisonPage, type WalletComparisonResult } from "./views/wallet-comparison";
import { getDb } from "./db/connection";
import { countByDate, getWalletIdsByDate, getNearestSnapshotDateBefore } from "./repositories/snapshot.repository";
import { compareWalletSets } from "./lib/wallet-compare";
```

Add routes (after the existing `/report` GET, before `/report/export`):

```ts
/** Wallet comparison page (protected) */
app.get("/wallet-comparison", guard, (c) =>
  c.html(walletComparisonPage({ error: c.req.query("error") })),
);

/** Wallet comparison handler (protected) */
app.post("/wallet-comparison", guard, async (c) => {
  const body = await c.req.parseBody<{ from_date: string; to_date: string }>();
  const { from_date, to_date } = body;

  if (!from_date || !to_date) {
    return c.html(walletComparisonPage({ error: "กรุณาเลือกช่วงวันที่" }));
  }
  if (from_date > to_date) {
    return c.html(
      walletComparisonPage({ error: "วันที่เริ่มต้นต้องมาก่อนวันที่สิ้นสุด", fromDefault: from_date, toDefault: to_date }),
    );
  }

  try {
    const db = getDb();

    // From side — snap to nearest prior snapshot if exact missing
    let fromDate = from_date;
    let fromSnapped = false;
    if ((await countByDate(db, from_date)) === 0) {
      const nearest = await getNearestSnapshotDateBefore(db, from_date);
      if (!nearest) {
        return c.html(
          walletComparisonPage({
            error: `ไม่พบ snapshot ก่อนหรือในวันที่ ${from_date}`,
            fromDefault: from_date,
            toDefault: to_date,
          }),
        );
      }
      fromDate = nearest;
      fromSnapped = true;
    }

    // To side — snap to nearest prior snapshot if exact missing
    let toDate = to_date;
    let toSnapped = false;
    if ((await countByDate(db, to_date)) === 0) {
      const nearest = await getNearestSnapshotDateBefore(db, to_date);
      if (!nearest) {
        return c.html(
          walletComparisonPage({
            error: `ไม่พบ snapshot ก่อนหรือในวันที่ ${to_date}`,
            fromDefault: from_date,
            toDefault: to_date,
          }),
        );
      }
      toDate = nearest;
      toSnapped = true;
    }

    if (fromDate > toDate) {
      return c.html(
        walletComparisonPage({
          error: "หลัง snap วันที่แล้ว from อยู่หลัง to กรุณาเลือกช่วงใหม่",
          fromDefault: from_date,
          toDefault: to_date,
        }),
      );
    }

    const fromIds = await getWalletIdsByDate(db, fromDate);
    const toIds = await getWalletIdsByDate(db, toDate);

    if (fromIds.size === 0 || toIds.size === 0) {
      return c.html(
        walletComparisonPage({
          error: `snapshot ว่าง (from=${fromIds.size}, to=${toIds.size})`,
          fromDefault: from_date,
          toDefault: to_date,
        }),
      );
    }

    const result = compareWalletSets({
      fromLabel: "From",
      fromDate,
      fromCount: fromIds.size,
      toLabel: "To",
      toDate,
      toCount: toIds.size,
      fromIds,
      toIds,
    });

    const payload: WalletComparisonResult = {
      result,
      fromRequested: from_date,
      toRequested: to_date,
      fromSnapped,
      toSnapped,
    };

    console.log(
      `[wallet-compare] from=${fromDate}${fromSnapped ? "(snapped)" : ""} to=${toDate}${toSnapped ? "(snapped)" : ""} fromCount=${fromIds.size} toCount=${toIds.size} missing=${result.missingIds.length} new=${result.newIds.length}`,
    );

    return c.html(
      walletComparisonPage({ result: payload, fromDefault: from_date, toDefault: to_date }),
    );
  } catch (err) {
    console.error("[wallet-compare] error:", err);
    return c.html(
      walletComparisonPage({
        error: "เกิดข้อผิดพลาดในการดึง snapshot — ตรวจ DATABASE_URL และการเชื่อมต่อ Postgres",
        fromDefault: from_date,
        toDefault: to_date,
      }),
    );
  }
});
```

---

## Verification
1. `cd apps/hfm-report && bun install`
2. Set `DATABASE_URL` in `.env` (same Postgres as apps/api)
3. `bun dev` → login → click **Wallet Comparison** tab
4. Pick two snapshot dates → counts + change % + missing/new lists render
5. Pick a date with no snapshot → notice shows snapped date
6. Pick a date with no prior snapshot at all → error shows
7. `/report` tab still works (export untouched)

## Gotchas
- Prod hfm-report container must reach api's Postgres (`DATABASE_URL`). Read-only SELECTs only.
- Only dates the api cron snapshotted are comparable.
- `getDb` is lazy (connects on first query) — server still boots if `DATABASE_URL` unset; it errors only when the comparison route runs.
