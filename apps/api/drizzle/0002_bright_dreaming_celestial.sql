CREATE TABLE "account_match_state" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"matched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_idle_alerts" (
	"wallet_id" integer PRIMARY KEY NOT NULL,
	"alerted_at" timestamp DEFAULT now() NOT NULL
);
