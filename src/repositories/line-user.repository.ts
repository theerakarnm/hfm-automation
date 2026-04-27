import type { Database } from "bun:sqlite";

export interface LineUserRow {
  line_uid: string;
  first_seen_at: string;
  last_seen_at: string;
  request_count: number;
  last_event_type: string | null;
}

export function recordLineUserRequest(
  db: Database,
  lineUid: string,
  eventType: string
): void {
  db.prepare(
    `INSERT INTO line_users (line_uid, first_seen_at, last_seen_at, request_count, last_event_type)
     VALUES ($uid, datetime('now'), datetime('now'), 1, $eventType)
     ON CONFLICT(line_uid) DO UPDATE SET
       last_seen_at = datetime('now'),
       request_count = request_count + 1,
       last_event_type = $eventType`
  ).run({ uid: lineUid, eventType });
}

export function listLineUsers(db: Database): LineUserRow[] {
  return db
    .query(
      "SELECT line_uid, first_seen_at, last_seen_at, request_count, last_event_type FROM line_users ORDER BY last_seen_at DESC"
    )
    .all() as LineUserRow[];
}
