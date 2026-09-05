// apps/api/tests/whitelist.test.ts
import { describe, test, expect } from "bun:test";
import { isWhitelisted } from "../src/utils/whitelist";
import type { TenantConfig } from "../src/types/tenant.types";

function ctx(over: Partial<TenantConfig> = {}): TenantConfig {
  return {
    whitelistEnabled: true,
    whitelistUids: ["U1", "U2"],
    ...over,
  } as TenantConfig;
}

describe("whitelist", () => {
  test("uid in the tenant list passes", () => {
    expect(isWhitelisted(ctx(), "U1")).toBe(true);
  });
  test("uid not in the list is rejected", () => {
    expect(isWhitelisted(ctx(), "U9")).toBe(false);
  });
  test("disabled whitelist lets everyone through", () => {
    expect(isWhitelisted(ctx({ whitelistEnabled: false }), "U9")).toBe(true);
  });
  test("enabled with empty list lets everyone through (unchanged semantics)", () => {
    expect(isWhitelisted(ctx({ whitelistUids: [] }), "U9")).toBe(true);
  });
  test("another tenant's uid list is not consulted", () => {
    const a = ctx({ whitelistUids: ["U1"] });
    const b = ctx({ whitelistUids: ["U2"] });
    expect(isWhitelisted(a, "U2")).toBe(false);
    expect(isWhitelisted(b, "U2")).toBe(true);
  });
});
