import { eq } from "drizzle-orm";
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
