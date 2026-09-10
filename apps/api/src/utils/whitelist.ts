// apps/api/src/utils/whitelist.ts
import type { TenantConfig } from "../types/tenant.types";

export function isWhitelisted(ctx: TenantConfig, userId: string): boolean {
  if (!ctx.whitelistEnabled) return true;
  // Empty list means "no restriction", same as the old env behaviour.
  if (ctx.whitelistUids.length === 0) return true;
  return ctx.whitelistUids.includes(userId);
}
