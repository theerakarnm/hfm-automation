import { desc, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { lineUsers } from "../db/schema";

export interface LineUserRow {
  line_uid: string;
  first_seen_at: string;
  last_seen_at: string;
  request_count: number;
  last_event_type: string | null;
}

export async function recordLineUserRequest(
  db: DrizzleDb,
  lineUid: string,
  eventType: string,
): Promise<void> {
  await db
    .insert(lineUsers)
    .values({
      lineUid,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      requestCount: 1,
      lastEventType: eventType,
    })
    .onConflictDoUpdate({
      target: lineUsers.lineUid,
      set: {
        lastSeenAt: new Date().toISOString(),
        requestCount: sql`${lineUsers.requestCount} + 1`,
        lastEventType: eventType,
      },
    });
}

export async function listLineUsers(db: DrizzleDb): Promise<LineUserRow[]> {
  const rows = await db
    .select()
    .from(lineUsers)
    .orderBy(desc(lineUsers.lastSeenAt));
  return rows.map((r) => ({
    line_uid: r.lineUid,
    first_seen_at: r.firstSeenAt,
    last_seen_at: r.lastSeenAt,
    request_count: r.requestCount,
    last_event_type: r.lastEventType,
  }));
}
