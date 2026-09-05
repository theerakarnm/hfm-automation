import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const clientSnapshots = pgTable(
  "client_snapshots",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    snapshotDate: text("snapshot_date").notNull(),
    clientId: integer("client_id").notNull(),
    name: text("name"),
    email: text("email"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("client_snapshots_tenant_date_client_unique").on(
      t.tenantId,
      t.snapshotDate,
      t.clientId,
    ),
    index("idx_snapshot_tenant_date").on(t.tenantId, t.snapshotDate),
  ],
);

export const notifyRecipients = pgTable(
  "notify_recipients",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    lineUid: text("line_uid").notNull(),
    label: text("label"),
    active: integer("active").notNull().default(1),
  },
  (t) => [unique("notify_recipients_tenant_uid_unique").on(t.tenantId, t.lineUid)],
);

export const dailyReportNotifications = pgTable(
  "daily_report_notifications",
  {
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    snapshotDate: text("snapshot_date").notNull(),
    sentAt: timestamp("sent_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({
      name: "daily_report_notifications_tenant_date_pkey",
      columns: [t.tenantId, t.snapshotDate],
    }),
  ],
);

export const lineUsers = pgTable(
  "line_users",
  {
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    lineUid: text("line_uid").notNull(),
    firstSeenAt: timestamp("first_seen_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
    requestCount: integer("request_count").notNull().default(1),
    lastEventType: text("last_event_type"),
  },
  (t) => [
    primaryKey({
      name: "line_users_tenant_uid_pkey",
      columns: [t.tenantId, t.lineUid],
    }),
  ],
);

export const reportRangeSnapshots = pgTable(
  "report_range_snapshots",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    period: text("period").notNull(),
    fromDate: text("from_date").notNull(),
    toDate: text("to_date").notNull(),
    rawJson: text("raw_json").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("report_range_snapshots_tenant_period_unique").on(
      t.tenantId,
      t.period,
      t.fromDate,
      t.toDate,
    ),
  ],
);

export const clientRequestSnapshots = pgTable(
  "client_request_snapshots",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    snapshotDate: text("snapshot_date").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("idx_req_snapshot_tenant_date").on(t.tenantId, t.snapshotDate)],
);

export const clientRequestSnapshotRows = pgTable(
  "client_request_snapshot_rows",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => clientRequestSnapshots.id),
    clientId: integer("client_id").notNull(),
  },
  (t) => [
    unique("client_request_snapshot_rows_snapshot_id_client_id_unique").on(
      t.snapshotId,
      t.clientId,
    ),
  ],
);

export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  webhookId: text("webhook_id").notNull().unique(),
  label: text("label").notNull(),
  active: integer("active").notNull().default(0),
  lineChannelAccessTokenEnc: text("line_channel_access_token_enc").notNull(),
  lineChannelSecretEnc: text("line_channel_secret_enc").notNull(),
  lineBotUserId: text("line_bot_user_id"),
  lineBasicId: text("line_basic_id"),
  lineDisplayName: text("line_display_name"),
  hfmApiKeyEnc: text("hfm_api_key_enc").notNull(),
  hfmApiBaseUrl: text("hfm_api_base_url")
    .notNull()
    .default("https://api.hfaffiliates.com"),
  targetWallet: integer("target_wallet").notNull(),
  whitelistEnabled: integer("whitelist_enabled").notNull().default(1),
  keyVersion: integer("key_version").notNull().default(1),
  lastTestedAt: timestamp("last_tested_at", { mode: "string" }),
  lastTestResult: text("last_test_result"),
  createdAt: timestamp("created_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export const tenantWhitelistUids = pgTable(
  "tenant_whitelist_uids",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lineUid: text("line_uid").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique("tenant_whitelist_uids_tenant_line_uid_unique").on(t.tenantId, t.lineUid)],
);

export const tenantHealthState = pgTable("tenant_health_state", {
  tenantId: integer("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  healthy: integer("healthy").notNull(),
  changedAt: timestamp("changed_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});
