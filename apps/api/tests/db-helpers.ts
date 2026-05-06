import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5433/hfm_test";

export async function createTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  await db.execute(sql`
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
  `);

  await db.execute(sql`
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

  return { db, client };
}

export async function closeTestDb(client: postgres.Sql) {
  await client.end();
}
