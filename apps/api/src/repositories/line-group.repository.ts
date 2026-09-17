import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { lineGroups } from "../db/schema";

export interface LineGroupRow {
  chat_id: string;
  chat_type: string;
  label: string | null;
  first_seen_at: string;
  last_seen_at: string;
  request_count: number;
  last_event_type: string | null;
  active: number;
}

export interface RecordLineGroupEventParams {
  chatId: string;
  chatType: "group" | "room";
  eventType: string;
  // Only join (1) and leave (0) touch this. Message traffic leaves it alone,
  // so a stale message event cannot resurrect a group the bot has left.
  active?: number;
}

export async function recordLineGroupEvent(
  db: DrizzleDb,
  params: RecordLineGroupEventParams,
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .insert(lineGroups)
    .values({
      chatId: params.chatId,
      chatType: params.chatType,
      label: null,
      firstSeenAt: now,
      lastSeenAt: now,
      requestCount: 1,
      lastEventType: params.eventType,
      active: params.active ?? 1,
    })
    .onConflictDoUpdate({
      target: lineGroups.chatId,
      set: {
        lastSeenAt: now,
        requestCount: sql`${lineGroups.requestCount} + 1`,
        lastEventType: params.eventType,
        ...(params.active != null ? { active: params.active } : {}),
      },
    });
}

// Separate from recordLineGroupEvent so the group name, which arrives later
// and from a different API, never bumps the request counter and is never
// wiped by a message event.
export async function updateLineGroupLabel(
  db: DrizzleDb,
  chatId: string,
  label: string,
): Promise<void> {
  await db
    .update(lineGroups)
    .set({ label })
    .where(eq(lineGroups.chatId, chatId));
}

export async function listLineGroups(db: DrizzleDb): Promise<LineGroupRow[]> {
  const rows = await db
    .select()
    .from(lineGroups)
    .orderBy(desc(lineGroups.lastSeenAt));

  return rows.map((r) => ({
    chat_id: r.chatId,
    chat_type: r.chatType,
    label: r.label,
    first_seen_at: r.firstSeenAt,
    last_seen_at: r.lastSeenAt,
    request_count: r.requestCount,
    last_event_type: r.lastEventType,
    active: r.active,
  }));
}
