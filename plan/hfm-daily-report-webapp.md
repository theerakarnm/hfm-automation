# HFM Daily Report Web App - Implementation Plan

## Overview

Build a daily snapshot collection system + web report to show:

1. Wallet ปัจจุบัน (current wallets)
2. Missing wallet (wallets that disappeared)
3. บัญชี Pro / Zero / Bonus / Premium มีกี่ account
4. TOTAL ACCOUNT
5. คนที่สมัครมาแล้ว เติมเงินแล้ว แต่ไม่เทรด (ตั้งแต่วันที่เริ่มเก็บข้อมูล)

## Requirements

- รวม wallet ที่ยังไม่มี trading account ด้วย
- "สมัครมาแล้ว" = account registration
- เก็บข้อมูลตั้งแต่วันนี้เป็นต้นไป (daily snapshot)
- Web app สำหรับดู report

## API Sources

### `/api/performance/client-performance`

Primary source สำหรับ wallet-level + account-level data.

Fields:
- `client_id` (= wallet_id)
- `account_id`
- `account_type` (Pro, Zero, Bonus, Premium, etc.)
- `client_registration`
- `account_regdate`
- `activity_status` (active, active_no_trading_account, inactive)
- `trades`, `volume`
- `deposits`, `withdrawals`
- `balance`, `equity`, `margin`, `free_margin`
- `first_trade`, `last_trade`
- `subaffiliate`
- `campaign`
- `country`
- `platform`
- `archived`
- `tier`

Supports filters:
- `subaffiliates` - filter by wallet
- `activity_status` - `active`, `active_no_trading_account`, `inactive`
- `account_registration_from_date` / `account_registration_to_date`

### `/api/clients/`

Supplementary source สำหรับ field ที่ `client-performance` อาจไม่มี:
- `first_funding` - วันที่เติมเงินครั้งแรก
- `deposits` / `withdrawals` (สำรอง)
- `type` (= account_type ในอีกชื่อ)
- `balance`, `equity`

### `/api/campaigns/wallets` (fallback)

ถ้า `client-performance` ไม่คืน wallet ที่ไม่มี trading account:
- `id` (= wallet_id)
- `registration_date`
- `country`
- `campaign`

## Database Schema

### Table: `wallet_snapshots`

```sql
CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date       TEXT NOT NULL,
  wallet_id           INTEGER NOT NULL,
  wallet_registration TEXT,
  country             TEXT,
  campaign            TEXT,
  subaffiliate        INTEGER,
  activity_status     TEXT,
  has_trading_account INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_ws_snapshot_date ON wallet_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ws_wallet_id ON wallet_snapshots(wallet_id);
```

### Table: `account_snapshots`

```sql
CREATE TABLE IF NOT EXISTS account_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date         TEXT NOT NULL,
  wallet_id             INTEGER NOT NULL,
  account_id            INTEGER NOT NULL,
  account_type_raw      TEXT,
  account_type_group    TEXT,
  account_registration  TEXT,
  first_funding         TEXT,
  deposits              REAL DEFAULT 0,
  first_trade           TEXT,
  last_trade            TEXT,
  trades                INTEGER DEFAULT 0,
  volume                REAL DEFAULT 0,
  balance               REAL DEFAULT 0,
  equity                REAL DEFAULT 0,
  platform              TEXT,
  country               TEXT,
  campaign              TEXT,
  activity_status       TEXT,
  archived              INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, wallet_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_as_snapshot_date ON account_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_as_wallet_id ON account_snapshots(wallet_id);
CREATE INDEX IF NOT EXISTS idx_as_account_type_group ON account_snapshots(account_type_group);
CREATE INDEX IF NOT EXISTS idx_as_account_id ON account_snapshots(account_id);
```

### Table: `daily_report_snapshots`

```sql
CREATE TABLE IF NOT EXISTS daily_report_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date   TEXT NOT NULL UNIQUE,
  total_wallets   INTEGER DEFAULT 0,
  total_accounts  INTEGER DEFAULT 0,
  pro_count       INTEGER DEFAULT 0,
  zero_count      INTEGER DEFAULT 0,
  bonus_count     INTEGER DEFAULT 0,
  premium_count   INTEGER DEFAULT 0,
  funded_no_trade INTEGER DEFAULT 0,
  missing_wallets TEXT DEFAULT '[]',
  raw_json        TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drs_snapshot_date ON daily_report_snapshots(snapshot_date);
```

## Report Calculation Logic

### 1. Current Wallets

```sql
SELECT COUNT(DISTINCT wallet_id)
FROM wallet_snapshots
WHERE snapshot_date = $today;
```

### 2. Missing Wallets

```sql
-- Wallets in previous snapshot but not in today's snapshot
SELECT DISTINCT prev.wallet_id
FROM wallet_snapshots prev
LEFT JOIN wallet_snapshots curr
  ON prev.wallet_id = curr.wallet_id
  AND curr.snapshot_date = $today
WHERE prev.snapshot_date = $previousDate
  AND curr.wallet_id IS NULL;
```

### 3. Account Type Counts

```sql
SELECT account_type_group, COUNT(DISTINCT account_id) as count
FROM account_snapshots
WHERE snapshot_date = $today
GROUP BY account_type_group;
```

### 4. Total Account

```sql
SELECT COUNT(DISTINCT account_id)
FROM account_snapshots
WHERE snapshot_date = $today;
```

### 5. Funded No Trade (ตั้งแต่ tracking_start_date)

```sql
SELECT COUNT(DISTINCT account_id)
FROM account_snapshots
WHERE snapshot_date = $today
  AND account_registration >= $trackingStartDate
  AND (deposits > 0 OR first_funding IS NOT NULL)
  AND (trades = 0 OR first_trade IS NULL);
```

## Account Type Grouping

Raw values from API need to be mapped to groups:

```typescript
function groupAccountType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("zero")) return "Zero";
  if (lower.includes("bonus")) return "Bonus";
  if (lower.includes("premium")) return "Premium";
  return "Other";
}
```

This must be validated against actual API response data.

## Implementation Steps

### Phase 1: Data Collection (Backend)

**Step 1.1: Add schema migrations**
- File: `src/services/sqlite.service.ts`
- Add `wallet_snapshots`, `account_snapshots`, `daily_report_snapshots` tables
- Add migration function

**Step 1.2: Create repository for wallet snapshots**
- File: `src/repositories/wallet-snapshot.repository.ts`
- Functions: `insertWalletSnapshot`, `getWalletIdsByDate`, `countDistinctWallets`

**Step 1.3: Create repository for account snapshots**
- File: `src/repositories/account-snapshot.repository.ts`
- Functions: `insertAccountSnapshot`, `getAccountsByDate`, `countByAccountTypeGroup`, `countFundedNoTrade`

**Step 1.4: Create repository for daily report**
- File: `src/repositories/daily-report.repository.ts`
- Functions: `upsertDailyReport`, `getDailyReport`, `getDailyReportRange`

**Step 1.5: Create collector service**
- File: `src/services/collector.service.ts`
- Fetch from `/api/performance/client-performance`
- Fetch from `/api/clients/`
- Merge data by `wallet_id + account_id`
- Group account_type into Pro/Zero/Bonus/Premium/Other
- Persist to `wallet_snapshots` and `account_snapshots`

**Step 1.6: Create report service**
- File: `src/services/report.service.ts`
- `generateDailyReport(date)` - returns all 7 metrics
- Handles missing wallet detection

**Step 1.7: Register cron job**
- File: `src/jobs/index.ts`
- Add daily snapshot collection job (runs at 00:05 ICT)

### Phase 2: API Endpoints

**Step 2.1: Add report API routes**
- File: `src/routes/report.ts`
- `GET /internal/report/today` - today's summary
- `GET /internal/report/history?from=&to=` - historical range
- `GET /internal/report/detail/:date` - full detail for a date
- Protected by `INTERNAL_API_KEY`

**Step 2.2: Register routes**
- File: `src/index.ts`
- Add `app.route("/internal", internal)` already exists, extend with report routes

### Phase 3: Web Report Dashboard

**Step 3.1: Create HTML report page**
- File: `src/routes/report-page.ts` or `src/index.html`
- Single-page dashboard
- Shows current report summary
- Table for historical reports
- Detail modal for funded-no-trade accounts

**Step 3.2: Add static route or HTML import**
- Serve report page via Bun HTML imports or inline HTML route

### Phase 4: Tests

**Step 4.1: Unit tests**
- `tests/wallet-snapshot.repository.test.ts`
- `tests/account-snapshot.repository.test.ts`
- `tests/report.service.test.ts`
- `tests/collector.service.test.ts`

**Step 4.2: Integration tests**
- `tests/report-api.test.ts` - API endpoint tests

## File Structure

```
src/
├── index.ts                              # existing - add report routes
├── services/
│   ├── sqlite.service.ts                 # existing - add new tables
│   ├── hfm.service.ts                    # existing - add fetchAllClientsForWallet
│   ├── collector.service.ts              # NEW - daily data collection
│   └── report.service.ts                 # NEW - report calculation
├── repositories/
│   ├── snapshot.repository.ts            # existing
│   ├── wallet-snapshot.repository.ts     # NEW
│   ├── account-snapshot.repository.ts    # NEW
│   └── daily-report.repository.ts        # NEW
├── jobs/
│   ├── index.ts                          # existing - add collector job
│   └── daily-client-report.ts            # existing
├── routes/
│   ├── webhook.ts                        # existing
│   ├── internal.ts                       # existing - add report endpoints
│   └── report.ts                         # NEW - report API + page
├── types/
│   ├── hfm.types.ts                      # existing - extend if needed
│   └── report.types.ts                   # NEW
├── utils/
│   ├── date.ts                           # existing
│   └── account-type.ts                   # NEW - account type grouping
tests/
├── wallet-snapshot.repository.test.ts    # NEW
├── account-snapshot.repository.test.ts   # NEW
├── report.service.test.ts                # NEW
├── collector.service.test.ts             # NEW
└── report-api.test.ts                    # NEW
```

## Validation Gates

After each phase:

```bash
bun test
bun run typecheck
```

## Open Questions (validate before Phase 1)

1. [ ] ยิง `GET /api/performance/client-performance?activity_status=active_no_trading_account` เพื่อดูว่า wallet ที่ไม่มี trading account อยู่ใน response ไหม
2. [ ] ตรวจค่า `account_type` จริงจาก API ว่ามีค่าอะไรบ้าง (Pro, Zero, Bonus, Premium, Standard, etc.)
3. [ ] ยืนยันว่า `subaffiliate` ใน `client-performance` = wallet id ที่เราสนใจ (เช่น 30506525)
4. [ ] ถ้า wallet ที่ไม่มี trading account ไม่อยู่ใน `client-performance` ต้องใช้ `/api/campaigns/wallets` เพิ่ม

## Estimate

| Phase | Description | Days |
|-------|-------------|------|
| 1 | Data collection backend (schema + collector + report service + cron) | 1.5 - 2 |
| 2 | API endpoints | 0.5 |
| 3 | Web report dashboard | 1 - 1.5 |
| 4 | Tests + validation | 0.5 - 1 |
| **Total** | | **3.5 - 5 วัน** |
