import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(url?: string): DrizzleDb {
  if (_db) return _db;
  const connUrl = url ?? Bun.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");

  let client: postgres.Sql;
  try {
    client = postgres(connUrl, { max: 5 });
  } catch (err) {
    throw new Error(
      "DATABASE_URL ไม่สามารถ parse ได้ — ถ้า password มีอักขระพิเศษ " +
        "(@ : / # ? ว่าง) ให้ URL-encode ก่อน " +
        "(@ → %40, : → %3A, / → %2F, # → %23, ? → %3F, space → %20). " +
        "ตัวอย่าง: postgresql://postgres:p%40ss@db.host:5432/postgres | " +
        `${err instanceof Error ? err.message : err}`,
    );
  }
  _client = client;
  _db = drizzle(_client, { schema });
  return _db;
}
