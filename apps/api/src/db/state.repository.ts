import { and, eq, like, lt } from "drizzle-orm";
import type { DrizzleDb } from "./connection";
import { jobState } from "./schema";

/**
 * Durable key/value state for background jobs. This replaces the module-level
 * flags the Bun process used to hold, which a Worker isolate cannot keep: the
 * isolate that runs one cron tick is not the isolate that runs the next one.
 *
 * The database, not KV, is the store here. A KV read can serve a value up to
 * 60 seconds stale, and edge detection has to read back exactly what the last
 * tick wrote.
 */
export async function getJobState(
  db: DrizzleDb,
  key: string,
): Promise<string | null> {
  const rows = await db
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setJobState(
  db: DrizzleDb,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(jobState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value, updatedAt: now },
    });
}

const LINE_EVENT_PREFIX = "line_event:";

/**
 * Claims a LINE event for processing. Returns true exactly once per
 * webhookEventId. INSERT ... ON CONFLICT DO NOTHING is atomic in PostgreSQL,
 * so two consumer invocations racing on a redelivered message cannot both
 * win. Hyperdrive runs with caching disabled, so no cached read hides the row.
 */
export async function claimLineEvent(
  db: DrizzleDb,
  webhookEventId: string,
): Promise<boolean> {
  const rows = await db
    .insert(jobState)
    .values({
      key: `${LINE_EVENT_PREFIX}${webhookEventId}`,
      value: "claimed",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: jobState.key })
    .returning({ key: jobState.key });
  return rows.length === 1;
}

/**
 * Deletes event claims older than olderThanMs. A claim only has to outlive
 * queue redelivery, which is minutes, so the cron keeps two days. Other
 * job_state keys are never touched. Both sides of the comparison are
 * app-written UTC ISO strings, so the session time zone cannot skew it.
 */
export async function purgeEventClaims(
  db: DrizzleDb,
  olderThanMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .delete(jobState)
    .where(
      and(
        like(jobState.key, `${LINE_EVENT_PREFIX}%`),
        lt(jobState.updatedAt, cutoff),
      ),
    )
    .returning({ key: jobState.key });
  return rows.length;
}
