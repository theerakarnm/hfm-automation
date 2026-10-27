CREATE TABLE "wallet_activity" (
	"wallet_id" integer PRIMARY KEY NOT NULL,
	"name" text,
	"last_trade_at" timestamp,
	"first_funded_at" timestamp,
	"alerted_at" timestamp,
	"seen_at" timestamp NOT NULL
);
