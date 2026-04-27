import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date   TEXT NOT NULL,
  composite_key   TEXT NOT NULL,
  account_id      INTEGER NOT NULL,
  client_id       INTEGER NOT NULL,
  full_name       TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, composite_key)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_date
  ON client_snapshots(snapshot_date);

CREATE INDEX IF NOT EXISTS idx_composite_key
  ON client_snapshots(composite_key, snapshot_date);

CREATE TABLE IF NOT EXISTS notify_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  line_uid   TEXT NOT NULL UNIQUE,
  label      TEXT,
  active     INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS daily_report_notifications (
  snapshot_date TEXT PRIMARY KEY,
  sent_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_users (
  line_uid        TEXT PRIMARY KEY,
  first_seen_at   TEXT DEFAULT (datetime('now')),
  last_seen_at    TEXT DEFAULT (datetime('now')),
  request_count   INTEGER DEFAULT 1,
  last_event_type TEXT
);
`;

let _db: Database | null = null;
let _initializedDb: Database | null = null;

export function getDatabase(path?: string): Database {
  if (_db) return _db;
  const dbPath = path ?? process.env.SQLITE_PATH ?? "./data/clients.db";
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  _db = new Database(dbPath, { strict: true });
  _db.run("PRAGMA journal_mode = WAL;");
  _db.run("PRAGMA busy_timeout = 5000;");
  _db.run("PRAGMA wal_autocheckpoint = 1000;");
  if (_initializedDb !== _db) {
    _db.run(SCHEMA);
    _initializedDb = _db;
  }
  return _db;
}

export function initSqlite(db?: Database): void {
  const target = db ?? getDatabase();
  if (_initializedDb === target) return;
  target.run(SCHEMA);
  _initializedDb = target;
}

export function checkpointDatabase(): void {
  if (!_db) return;
  _db.run("PRAGMA wal_checkpoint(TRUNCATE);");
}

export function closeDatabase(): void {
  if (_db) {
    try {
      _db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}
    _db.close();
    _db = null;
    _initializedDb = null;
  }
}

export function resetDatabaseForTests(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _initializedDb = null;
}
