import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const clientSnapshots = pgTable(
  "client_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotDate: text("snapshot_date").notNull(),
    clientId: integer("client_id").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("client_snapshots_snapshot_date_client_id_unique").on(
      t.snapshotDate,
      t.clientId,
    ),
    index("idx_snapshot_date").on(t.snapshotDate),
  ],
);
