CREATE TABLE "client_request_snapshot_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	CONSTRAINT "client_request_snapshot_rows_snapshot_id_client_id_unique" UNIQUE("snapshot_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "client_request_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" text NOT NULL,
	"client_id" integer NOT NULL,
	"name" text,
	"email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "client_snapshots_snapshot_date_client_id_unique" UNIQUE("snapshot_date","client_id")
);
--> statement-breakpoint
CREATE TABLE "daily_report_notifications" (
	"snapshot_date" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_groups" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"chat_type" text NOT NULL,
	"label" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"last_event_type" text,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_users" (
	"line_uid" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"last_event_type" text
);
--> statement-breakpoint
CREATE TABLE "notify_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"line_uid" text NOT NULL,
	"label" text,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "notify_recipients_line_uid_unique" UNIQUE("line_uid")
);
--> statement-breakpoint
CREATE TABLE "report_range_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"raw_json" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "report_range_snapshots_period_from_date_to_date_unique" UNIQUE("period","from_date","to_date")
);
--> statement-breakpoint
ALTER TABLE "client_request_snapshot_rows" ADD CONSTRAINT "client_request_snapshot_rows_snapshot_id_client_request_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."client_request_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_req_snapshot_date" ON "client_request_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "idx_snapshot_date" ON "client_snapshots" USING btree ("snapshot_date");