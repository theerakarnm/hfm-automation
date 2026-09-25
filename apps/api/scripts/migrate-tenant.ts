// Applies apps/api/drizzle/*.sql to one tenant database.
//
// This talks to the tenant Postgres DIRECTLY, never through Hyperdrive.
// Hyperdrive is a Workers binding with no CLI surface, its query cache does not
// invalidate on write, and DDL behind a shared pool is the wrong place to take
// a migration lock. Point DATABASE_URL_<TENANT> at the origin database.
//
// Usage: bun run scripts/migrate-tenant.ts maow
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const tenant = process.argv[2];
if (!tenant) {
  console.error("usage: bun run scripts/migrate-tenant.ts <tenant>");
  process.exit(1);
}

const envName = `DATABASE_URL_${tenant.toUpperCase().replace(/-/g, "_")}`;
const url = process.env[envName];
if (!url) {
  console.error(`[migrate] ${envName} is not set`);
  process.exit(1);
}

// max 1: a migration is strictly serial and drizzle takes its own lock.
const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log(`[migrate] migrations applied to ${tenant}`);
} catch (error) {
  console.error(`[migrate] failed for ${tenant}:`, error);
  process.exitCode = 1;
} finally {
  await client.end();
}
