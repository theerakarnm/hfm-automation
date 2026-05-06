import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(url?: string): DrizzleDb {
  if (_db) return _db;
  const connUrl = url ?? process.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");
  _client = postgres(connUrl, { max: 10 });
  _db = drizzle(_client, { schema });
  return _db;
}

export async function initDb(db?: DrizzleDb): Promise<void> {
  const target = db ?? getDb();
  await target.execute(sql`
    CREATE TABLE IF NOT EXISTS client_snapshots (
      id              SERIAL PRIMARY KEY,
      snapshot_date   TEXT NOT NULL,
      client_id       INTEGER NOT NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(snapshot_date, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_date
      ON client_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS notify_recipients (
      id         SERIAL PRIMARY KEY,
      line_uid   TEXT NOT NULL UNIQUE,
      label      TEXT,
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_report_notifications (
      snapshot_date TEXT PRIMARY KEY,
      sent_at       TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS line_users (
      line_uid        TEXT PRIMARY KEY,
      first_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      request_count   INTEGER NOT NULL DEFAULT 1,
      last_event_type TEXT
    );

    CREATE TABLE IF NOT EXISTS report_range_snapshots (
      id         SERIAL PRIMARY KEY,
      period     TEXT NOT NULL,
      from_date  TEXT NOT NULL,
      to_date    TEXT NOT NULL,
      raw_json   TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(period, from_date, to_date)
    );

    CREATE TABLE IF NOT EXISTS client_request_snapshots (
      id            SERIAL PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_req_snapshot_date
      ON client_request_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS client_request_snapshot_rows (
      id          SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES client_request_snapshots(id),
      client_id   INTEGER NOT NULL,
      UNIQUE(snapshot_id, client_id)
    );
  `);
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export function resetDbForTests(): void {
  _client = null;
  _db = null;
}
