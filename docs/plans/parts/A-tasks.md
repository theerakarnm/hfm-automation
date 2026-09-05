<!-- part: A -->

### Task 1: Secret encryption helpers

**Files:**
- Create: `apps/api/src/utils/crypto.ts`
- Test: `apps/api/tests/crypto.test.ts`

Secrets that move from `.env` into PostgreSQL must not sit in the database as plaintext.
AES-256-GCM gives authenticated encryption: a tampered or wrongly keyed ciphertext fails loudly instead of returning garbage.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/crypto.test.ts
import { test, describe, expect, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  loadEncryptionKey,
  CURRENT_KEY_VERSION,
} from "../src/utils/crypto";

const KEY_32 = Buffer.alloc(32, 7).toString("base64");

describe("crypto", () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_32;
  });

  test("loadEncryptionKey returns the 32 byte key", () => {
    expect(loadEncryptionKey().length).toBe(32);
  });

  test("encryptSecret then decryptSecret round trips", () => {
    const enc = encryptSecret("my-secret-token");
    expect(enc).not.toContain("my-secret-token");
    expect(enc.split(".")).toHaveLength(3);
    expect(decryptSecret(enc)).toBe("my-secret-token");
  });

  test("same plaintext encrypts differently every time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("tampered ciphertext throws", () => {
    const enc = encryptSecret("my-secret-token");
    const [iv, tag, ct] = enc.split(".");
    const flipped = ct!.slice(0, -2) + (ct!.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(`${iv}.${tag}.${flipped}`)).toThrow();
  });

  test("wrong key throws instead of returning garbage", () => {
    const enc = encryptSecret("my-secret-token");
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptSecret(enc)).toThrow();
  });

  test("maskSecret never reveals the middle", () => {
    const masked = maskSecret("abcdefghijklmnop");
    expect(masked).toBe("abcd...mnop");
    expect(masked).not.toContain("efgh");
  });

  test("maskSecret handles short values", () => {
    expect(maskSecret("abc")).toBe("a**");
  });

  test("CURRENT_KEY_VERSION is 1", () => {
    expect(CURRENT_KEY_VERSION).toBe(1);
  });

  test("missing env throws a clear error", () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => loadEncryptionKey()).toThrow(/CONFIG_ENCRYPTION_KEY/);
  });

  test("short env value throws a clear error", () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEncryptionKey()).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/api`:

```bash
bun test tests/crypto.test.ts
```

Expected: FAIL with `Cannot find module '../src/utils/crypto'` (module resolution error).

- [ ] **Step 3: Implement `crypto.ts`**

```ts
// apps/api/src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Key rotation: bump this when a new CONFIG_ENCRYPTION_KEY is introduced,
// keep decrypt support for old versions in decryptSecret.
export const CURRENT_KEY_VERSION = 1;

// AES-256-GCM needs exactly a 32 byte key and a 12 byte IV.
// Ciphertext format: "<ivB64>.<authTagB64>.<cipherB64>".
const IV_BYTES = 12;

export function loadEncryptionKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is not set. Generate one with: " +
        "bun -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`,
    );
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected iv.tag.ct");
  }
  const [iv, tag, ct] = parts as [string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadEncryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Auth failure means tampering or the wrong CONFIG_ENCRYPTION_KEY.
    // Never return partial plaintext.
    throw new Error(
      "Decryption failed: ciphertext is tampered or CONFIG_ENCRYPTION_KEY changed",
    );
  }
}

// The UI shows this instead of a secret. First 4 and last 4 characters only.
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return plain.slice(0, 1) + "**";
  if (plain.length <= 8) return plain.slice(0, 4) + "...";
  return `${plain.slice(0, 4)}...${plain.slice(-4)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/crypto.test.ts
```

Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/utils/crypto.ts tests/crypto.test.ts
git commit -m "feat: add AES-256-GCM secret encryption helpers"
```

---

### Task 2: `tenants` tables in schema and `initDb`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/connection.ts`
- Modify: `apps/api/tests/db-helpers.ts`

Three new tables: `tenants` (one row per LINE OA), `tenant_whitelist_uids` (per OA whitelist), and `tenant_health_state` (healthcheck edge state, replacing the module variable).

- [ ] **Step 1: Add drizzle table definitions to `schema.ts`**

Append to `apps/api/src/db/schema.ts`:

```ts
export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  webhookId: text("webhook_id").notNull().unique(),
  label: text("label").notNull(),
  active: integer("active").notNull().default(0),
  lineChannelAccessTokenEnc: text("line_channel_access_token_enc").notNull(),
  lineChannelSecretEnc: text("line_channel_secret_enc").notNull(),
  lineBotUserId: text("line_bot_user_id"),
  lineBasicId: text("line_basic_id"),
  lineDisplayName: text("line_display_name"),
  hfmApiKeyEnc: text("hfm_api_key_enc").notNull(),
  hfmApiBaseUrl: text("hfm_api_base_url")
    .notNull()
    .default("https://api.hfaffiliates.com"),
  targetWallet: integer("target_wallet").notNull(),
  whitelistEnabled: integer("whitelist_enabled").notNull().default(1),
  keyVersion: integer("key_version").notNull().default(1),
  lastTestedAt: timestamp("last_tested_at", { mode: "string" }),
  lastTestResult: text("last_test_result"),
  createdAt: timestamp("created_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export const tenantWhitelistUids = pgTable(
  "tenant_whitelist_uids",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lineUid: text("line_uid").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique("tenant_whitelist_uids_tenant_line_uid_unique").on(t.tenantId, t.lineUid)],
);

export const tenantHealthState = pgTable("tenant_health_state", {
  tenantId: integer("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  healthy: integer("healthy").notNull(),
  changedAt: timestamp("changed_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});
```

- [ ] **Step 2: Add the same DDL to `initDb()` in `connection.ts`**

Inside the existing `db.execute(sql\`...\`)` call in `initDb`, before the existing `CREATE TABLE IF NOT EXISTS client_snapshots` block, add:

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id                            SERIAL PRIMARY KEY,
  webhook_id                    TEXT NOT NULL UNIQUE,
  label                         TEXT NOT NULL,
  active                        INTEGER NOT NULL DEFAULT 0,
  line_channel_access_token_enc TEXT NOT NULL,
  line_channel_secret_enc       TEXT NOT NULL,
  line_bot_user_id              TEXT,
  line_basic_id                 TEXT,
  line_display_name             TEXT,
  hfm_api_key_enc               TEXT NOT NULL,
  hfm_api_base_url              TEXT NOT NULL DEFAULT 'https://api.hfaffiliates.com',
  target_wallet                 INTEGER NOT NULL,
  whitelist_enabled             INTEGER NOT NULL DEFAULT 1,
  key_version                   INTEGER NOT NULL DEFAULT 1,
  last_tested_at                TIMESTAMP,
  last_test_result              TEXT,
  created_at                    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_whitelist_uids (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  line_uid   TEXT NOT NULL,
  label      TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, line_uid)
);

CREATE TABLE IF NOT EXISTS tenant_health_state (
  tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  healthy    INTEGER NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT now()
);
```

- [ ] **Step 3: Update `tests/db-helpers.ts`**

Add to the front of the DROP block (children before parents):

```sql
DROP TABLE IF EXISTS tenant_health_state CASCADE;
DROP TABLE IF EXISTS tenant_whitelist_uids CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
```

Add the same three `CREATE TABLE IF NOT EXISTS` statements from Step 2 to the create block.

- [ ] **Step 4: Verify with a repository smoke test run**

```bash
bun test tests/line-user.repository.test.ts
```

Expected: PASS (existing tests still green against the new schema shape).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/connection.ts tests/db-helpers.ts
git commit -m "feat: add tenants, whitelist, health-state tables"
```

---
