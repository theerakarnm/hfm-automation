import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guard for the deploy surface: a tenant that has a wrangler config but no
// deploy script is a tenant nobody can ship, and a script pointing at the
// wrong -c file silently deploys the wrong tenant.

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

const PER_TENANT_PREFIXES = [
  "deploy",
  "dev",
  "tail",
  "secrets",
  "migrate",
  "check:bundle",
] as const;

function tenantNames(): string[] {
  const glob = new Glob("wrangler.*.jsonc");
  return [...glob.scanSync({ cwd: APP_DIR, onlyFiles: true })]
    .map((file) => file.replace(/^wrangler\./, "").replace(/\.jsonc$/, ""))
    .sort();
}

function scripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(`${APP_DIR}package.json`, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("package.json deploy surface", () => {
  test("every tenant has every per-tenant script", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      for (const prefix of PER_TENANT_PREFIXES) {
        const key = `${prefix}:${tenant}`;
        expect(`${key} defined=${typeof all[key] === "string"}`).toBe(
          `${key} defined=true`,
        );
      }
    }
  });

  test("every per-tenant script points at that tenant config file", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      for (const prefix of ["deploy", "dev", "tail", "secrets", "check:bundle"]) {
        const key = `${prefix}:${tenant}`;
        const command = all[key] ?? "";
        expect(`${key}: ${command.includes(`-c wrangler.${tenant}.jsonc`)}`).toBe(
          `${key}: true`,
        );
      }
    }
  });

  test("every migrate script targets its own tenant database", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      const command = all[`migrate:${tenant}`] ?? "";
      const ok =
        command.includes(`--env-file=.env.${tenant}.admin`) &&
        command.includes(`scripts/migrate-tenant.ts ${tenant}`);
      expect(`migrate:${tenant}: ${ok}`).toBe(`migrate:${tenant}: true`);
    }
  });

  test("deploy:all runs every tenant deploy", () => {
    const all = scripts();
    const command = all["deploy:all"] ?? "";
    for (const tenant of tenantNames()) {
      expect(`deploy:all covers ${tenant}: ${command.includes(`deploy:${tenant}`)}`).toBe(
        `deploy:all covers ${tenant}: true`,
      );
    }
  });

  test("the Bun server scripts are gone", () => {
    const all = scripts();
    expect(`dev=${all.dev} start=${all.start}`).toBe("dev=undefined start=undefined");
  });

  test("test and typecheck stay Bun commands", () => {
    const all = scripts();
    expect(all.test).toBe("bun test");
    expect(all.typecheck).toBe("bunx tsc --noEmit");
  });
});
