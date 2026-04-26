## FEATURE:

Build a **daily scheduled job** that runs inside the existing Bun + Hono server process. Every day at **05:00 ICT (UTC+7)**, the job fetches all client performance data from the HFAffiliates API, stores a snapshot in a local **SQLite file**, compares today's snapshot against yesterday's, and pushes a LINE text notification to one or more admin UIDs listing clients who were **added** or went **missing**.

**Comparison key:** `account_id` + `client_id` concatenated (e.g. `"78451293_10023"`)

**Core flow:**
1. Cron fires at 05:00 ICT daily (inside Hono server process using `croner`)
2. `GET /api/performance/overall_performance` — no query params, returns `{ clients: Client[], totals: Totals }`
3. Store full snapshot of all clients into SQLite (`client_snapshots` table) with `snapshot_date = TODAY`
4. Query yesterday's snapshot from SQLite
5. Compare today vs yesterday using `account_id + client_id` as composite key
6. Build notification text and push to all LINE UIDs stored in config
7. Purge snapshot rows older than 90 days

**Notification format (LINE plain text):**

```
📅 Daily Client Report — {DD/MM/YYYY}

✅ New Clients ({count})
━━━━━━━━━━━━━━━━━━━━
• {full_name}
  Client ID : {client_id}
  Account ID: {account_id}

• {full_name}
  ...

❌ Missing Clients ({count})
━━━━━━━━━━━━━━━━━━━━
• {full_name}
  Client ID : {client_id}
  Account ID: {account_id}

📊 Total Clients Today: {totals.clients}
```

If no changes: send `"✅ Daily Client Report — {DD/MM/YYYY}\nNo changes detected."` (do not skip sending — always notify so admin knows the job ran)

**LINE UIDs config:**
Store as `LINE_NOTIFY_UIDS=Uabc123,Udef456` (comma-separated) in `.env`. Parse into array at startup. Push to each UID individually.

**SQLite schema:**
```sql
-- Daily snapshot of every client row
CREATE TABLE client_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date   TEXT NOT NULL,          -- "YYYY-MM-DD" (ICT date)
  composite_key   TEXT NOT NULL,          -- "{account_id}_{client_id}"
  account_id      INTEGER NOT NULL,
  client_id       INTEGER NOT NULL,
  full_name       TEXT NOT NULL,
  raw_json        TEXT NOT NULL,          -- full Client JSON stringified
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshot_date ON client_snapshots(snapshot_date);
CREATE INDEX idx_composite_key ON client_snapshots(composite_key, snapshot_date);

-- Notify recipients
CREATE TABLE notify_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  line_uid   TEXT NOT NULL UNIQUE,
  label      TEXT,                        -- e.g. "admin", "manager"
  active     INTEGER DEFAULT 1           -- 0 = disabled
);
```

> `notify_recipients` table seeds from `LINE_NOTIFY_UIDS` env on first boot. Designed to be managed via table in Phase 2 without env change.

**Project additions:**
```
src/
├── jobs/
│   ├── index.ts                  # Register all cron jobs at server startup
│   └── daily-client-report.ts   # Main job: fetch → store → compare → notify
├── services/
│   ├── hfm.service.ts            # ADD: fetchAllClients() — no params
│   ├── line.service.ts           # ADD: pushToAll(uids, text)
│   └── sqlite.service.ts         # NEW: SQLite connection + query helpers
├── repositories/
│   ├── snapshot.repository.ts    # getByDate(), insertMany(), purgeOlderThan()
│   └── recipient.repository.ts   # getActiveUids(), seedFromEnv()
└── utils/
    └── date.ts                   # getIctDateString() → "YYYY-MM-DD"
```

**New environment variables:**
```env
LINE_NOTIFY_UIDS=Uabc123,Udef456
SQLITE_PATH=./data/clients.db
```

---

## EXAMPLES:

No `examples/` folder yet. Create the following as reference:

**`examples/hfm-all-clients-response.json`**
Mock response with 2 clients and totals:
```json
{
  "clients": [
    {
      "account_id": 78451293,
      "client_id": 10023,
      "full_name": "Somchai Jaidee",
      "activity_status": "Active Trading Account",
      "account_type": "Standard",
      "balance": 12450.80,
      "equity": 12998.35,
      "volume": 3.42,
      "trades": 24,
      "platform": "MT4",
      "status": "Approved",
      "country": "Thailand",
      "account_currency": "USD",
      "archived": null
    },
    {
      "account_id": 99001234,
      "client_id": 10024,
      "full_name": "Malee Srisuk",
      "activity_status": "No Trading Account",
      "account_type": "N/A",
      "balance": 0,
      "equity": 0,
      "volume": 0,
      "trades": 0,
      "platform": "N/A",
      "status": "Approved",
      "country": "Thailand",
      "account_currency": "N/A",
      "archived": null
    }
  ],
  "totals": {
    "clients": 2,
    "accounts": 1,
    "volume": 3.42,
    "deposits": 5000.00,
    "withdrawals": 0,
    "commission": 120.50
  }
}
```

**`examples/notify-message-added-missing.txt`**
Expected LINE push text when both added and missing exist:
```
📅 Daily Client Report — 26/04/2026

✅ New Clients (2)
━━━━━━━━━━━━━━━━━━━━
• Malee Srisuk
  Client ID : 10024
  Account ID: 99001234

• Preecha Wongsuk
  Client ID : 10031
  Account ID: 88123456

❌ Missing Clients (1)
━━━━━━━━━━━━━━━━━━━━
• Somchai Jaidee
  Client ID : 10023
  Account ID: 78451293

📊 Total Clients Today: 45
```

**`examples/notify-message-no-change.txt`**
```
📅 Daily Client Report — 26/04/2026
✅ No changes detected.
📊 Total Clients Today: 45
```

**`examples/cron-registration.ts`**
How to register the job inside Hono startup:
```typescript
import { Cron } from "croner";
import { runDailyClientReport } from "./jobs/daily-client-report";

// 05:00 ICT = 22:00 UTC (previous day)
export function registerJobs() {
  new Cron("0 22 * * *", { timezone: "UTC" }, async () => {
    console.log("[cron] daily-client-report started");
    await runDailyClientReport();
  });
}
```

---

## DOCUMENTATION:

- **HFAffiliates API — Overall Performance (no params):** https://api.hfaffiliates.com/docs#/performance%20reports%20(new)/get_overall_performance_api_performance_overall_performance_get
- **croner — Cron for Bun/Node:** https://croner.56k.guru/
- **Bun SQLite built-in driver:** https://bun.sh/docs/api/sqlite
- **LINE Push Message API:** https://developers.line.biz/en/docs/messaging-api/sending-messages/#sending-push-messages
- **LINE message character limit:** https://developers.line.biz/en/docs/messaging-api/text-message/ (max 5000 chars per message)

---

## OTHER CONSIDERATIONS:

**1. Use Bun's built-in SQLite — no external ORM needed**
Bun ships `bun:sqlite` natively. Do not install `better-sqlite3` or `drizzle-orm` for this feature. Keep it simple:
```typescript
import { Database } from "bun:sqlite";
const db = new Database(process.env.SQLITE_PATH ?? "./data/clients.db");
db.run("PRAGMA journal_mode = WAL;"); // enable WAL for concurrent reads
```
WAL mode is important because Hono handles HTTP requests concurrently while the cron job writes — without WAL, SQLite will throw `SQLITE_BUSY` errors.

**2. ICT date — never use `new Date()` raw**
The server may run in UTC. Always derive the ICT snapshot date explicitly:
```typescript
export function getIctDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  // → "2026-04-26" (YYYY-MM-DD)
}
```
If you use `new Date().toISOString().slice(0, 10)` you will get the UTC date — which at 05:00 ICT is still the previous UTC day. This will corrupt the snapshot_date and break comparisons.

**3. Idempotency — guard against double-run**
If the server restarts at exactly 05:00, croner may fire twice. Before inserting today's snapshot, check if rows for today already exist and skip:
```typescript
const existing = db.query(
  "SELECT COUNT(*) as count FROM client_snapshots WHERE snapshot_date = ?"
).get(todayStr) as { count: number };
if (existing.count > 0) {
  console.warn("[cron] snapshot already exists for today, skipping insert");
  return;
}
```

**4. Comparison logic — use Set for O(n) diff**
Do not loop nested arrays. Build Sets from composite keys:
```typescript
const todayKeys = new Set(todayClients.map(c => `${c.account_id}_${c.client_id}`));
const yesterdayKeys = new Set(yesterdayClients.map(c => `${c.account_id}_${c.client_id}`));

const added = todayClients.filter(c => !yesterdayKeys.has(`${c.account_id}_${c.client_id}`));
const missing = yesterdayClients.filter(c => !todayKeys.has(`${c.account_id}_${c.client_id}`));
```

**5. No yesterday snapshot on first run**
On the very first run, there is no previous day's data. Handle this gracefully — do NOT throw or crash. Log a warning and send a special notify:
```
📅 Daily Client Report — 26/04/2026
🔔 First run — baseline snapshot saved.
📊 Total Clients Today: 45
```

**6. LINE message length limit is 5,000 characters**
If the client list is very large, the notify message may exceed the LINE text limit. Guard against this:
- If total characters > 4,500, truncate the list and append `"... and {n} more. Check full report."`
- In Phase 2, consider splitting into multiple messages or sending a summary only

**7. LINE Push to multiple UIDs — send sequentially, not Promise.all**
LINE's Messaging API has per-second rate limits. Fire pushes one by one with a small delay to avoid `429 Too Many Requests`:
```typescript
for (const uid of activeUids) {
  await pushMessage(uid, text);
  await Bun.sleep(200); // 200ms gap between pushes
}
```

**8. Purge runs after insert, not before**
Always purge old rows AFTER successfully inserting today's snapshot, never before. If purge runs first and the API call fails afterward, you lose historical data permanently:
```typescript
await insertSnapshot(todayClients, todayStr);   // 1. insert first
await purgeOlderThan(90);                        // 2. purge after
```

**9. SQLite file must persist across Docker restarts**
Mount the SQLite file as a Docker volume:
```yaml
# docker-compose.yml
volumes:
  - ./data:/app/data
```
If not mounted, every container restart wipes the database and the job loses all history.

**10. `raw_json` column enables schema-free future queries**
Storing the full Client JSON as a string in `raw_json` means you can add new comparison fields (e.g. balance change, status change) in Phase 2 without migrating the schema — just parse the stored JSON. Do not rely on individual indexed columns for anything other than the composite key and snapshot_date.