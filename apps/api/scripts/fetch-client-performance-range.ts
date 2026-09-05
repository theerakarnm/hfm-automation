import { resolveTenants, parseArgs } from "./lib/resolve-tenant";
import { fetchClientsByRange } from "../src/services/hfm.service";
import { getIctDateString } from "../src/utils/date";
import { initDb, getDb } from "../src/db/connection";
import { loadEncryptionKey } from "../src/utils/crypto";
import type { TenantConfig } from "../src/types/tenant.types";

const FROM_DATE = process.env.FROM_DATE ?? "2026-01-01";
const TO_DATE = process.env.TO_DATE ?? "2026-01-31";
const OUTPUT = process.env.OUTPUT ?? `./output/client-performance_${FROM_DATE}_${TO_DATE}.json`;

function outputForTenant(base: string, tenantId: number): string {
  return base.endsWith(".json")
    ? `${base.slice(0, -".json".length)}_tenant-${tenantId}.json`
    : `${base}_tenant-${tenantId}`;
}

async function fetchForTenant(ctx: TenantConfig): Promise<boolean> {
  const output = outputForTenant(OUTPUT, ctx.id);
  console.log(
    `[fetch] client performance for "${ctx.label}" (tenant ${ctx.id}), ${FROM_DATE} to ${TO_DATE}`,
  );

  const result = await fetchClientsByRange(ctx, FROM_DATE, TO_DATE);

  if (!result.ok) {
    console.error(`[fetch] tenant ${ctx.id} failed: ${result.reason}`);
    return false;
  }

  const { clients, totals } = result.data;
  console.log(`[fetch] got ${clients.length} client(s)`);

  const payload = {
    fetched_at: getIctDateString(new Date()),
    tenant_id: ctx.id,
    from_date: FROM_DATE,
    to_date: TO_DATE,
    totals,
    clients,
  };

  await Bun.write(output, JSON.stringify(payload, null, 2));
  const file = Bun.file(output);
  console.log(`[fetch] saved to ${output} (${(file.size / 1024).toFixed(1)} KB)`);
  return true;
}

loadEncryptionKey(); // fail fast
await initDb(getDb());
let ok = true;
for (const ctx of await resolveTenants(parseArgs(process.argv))) {
  ok = (await fetchForTenant(ctx)) && ok;
}
process.exit(ok ? 0 : 1);
