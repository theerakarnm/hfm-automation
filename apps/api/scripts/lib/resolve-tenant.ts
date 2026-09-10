// apps/api/scripts/lib/resolve-tenant.ts
import { getTenantById, listActiveTenants } from "../../src/services/tenant-config.service";
import { listTenantRows } from "../../src/repositories/tenant.repository";
import { getDb } from "../../src/db/connection";
import type { TenantConfig } from "../../src/types/tenant.types";

export interface TenantSelector { tenant?: string; all?: boolean }

export function parseArgs(argv: string[]): TenantSelector {
  const out: TenantSelector = {};
  for (const arg of argv.slice(2)) {
    if (arg === "--all") out.all = true;
    else if (arg.startsWith("--tenant=")) out.tenant = arg.slice("--tenant=".length);
  }
  if (!out.all && out.tenant === undefined && process.env.TENANT) {
    out.tenant = process.env.TENANT;
  }
  return out;
}

async function findByLabelOrWebhookId(value: string): Promise<TenantConfig | null> {
  // id first, then webhook id, then label; label is unique by convention only
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber > 0) return getTenantById(asNumber);
  const rows = await listTenantRows(getDb());
  const row = rows.find((r) => r.webhookId === value || r.label === value);
  return row ? getTenantById(row.id) : null;
}

// Refuses to guess: no selector means stop and explain.
export async function resolveTenants(selector: TenantSelector): Promise<TenantConfig[]> {
  if (selector.all) return listActiveTenants();
  if (selector.tenant) {
    const ctx = await findByLabelOrWebhookId(selector.tenant);
    if (!ctx) {
      console.error(`No tenant matched "${selector.tenant}". Use --all, --tenant=<id|webhookId|label>, or TENANT=.`);
      process.exit(2);
    }
    return [ctx];
  }
  console.error("Refusing to guess a tenant. Use --all, --tenant=<id|webhookId|label>, or TENANT=.");
  process.exit(2);
}
