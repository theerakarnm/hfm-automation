import type { Database } from "bun:sqlite";

export function parseNotifyUids(envValue: string): string[] {
  return [...new Set(envValue.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

export function seedFromEnv(db: Database, envValue: string): void {
  const uids = parseNotifyUids(envValue);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO notify_recipients (line_uid) VALUES ($uid)"
  );
  const tx = db.transaction(() => {
    for (const uid of uids) {
      insert.run({ uid });
    }
  });
  tx();
}

export function getActiveUids(db: Database): string[] {
  const rows = db
    .query("SELECT line_uid FROM notify_recipients WHERE active = 1")
    .all() as Array<{ line_uid: string }>;
  return rows.map((r) => r.line_uid);
}
