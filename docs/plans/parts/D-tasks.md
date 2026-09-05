<!-- part: D -->

### Task 18: Admin auth: login, cookie session, CSRF

**Files:**
- Create: `apps/api/src/routes/internal-auth.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/internal-auth.test.ts`

The admin pages edit real channel tokens, so they do not accept `?key=`.
They use a signed httpOnly cookie.
The `?key=` middleware must keep working for `/internal/health`, `/internal/logs*`, and `/internal/line-uids`, because the docker healthcheck and existing tooling depend on it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/internal-auth.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { internalAuthRoutes, requireAdmin, issueSession } from "../src/routes/internal-auth";

const app = new Hono();
app.route("/internal", internalAuthRoutes);
app.use("/internal/secret-page", requireAdmin);
app.get("/internal/secret-page", (c) => c.text("secret"));

process.env.INTERNAL_API_KEY = "the-key";

beforeEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("admin auth", () => {
  test("no cookie redirects to login", async () => {
    const res = await app.request("/internal/secret-page");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/internal/login");
  });

  test("wrong key is rejected", async () => {
    const res = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("right key sets an httpOnly cookie and grants access", async () => {
    const login = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "the-key" }),
    });
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(res.status).toBe(200);
  });

  test("tampered cookie is rejected", async () => {
    const login = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "the-key" }),
    });
    const good = login.headers.get("set-cookie")!.split(";")[0];
    const forged = good.replace(/hfm_admin=[^;]+/, "hfm_admin=forged");
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: forged },
    });
    expect(res.status).toBe(302);
  });

  test("expired cookie is rejected", async () => {
    // issued with expiry in the past via the test helper
    const expired = issueSession(0);
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: `hfm_admin=${expired}` },
    });
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/internal-auth.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/api/src/routes/internal-auth.ts
import { Hono } from "hono";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";

const COOKIE_NAME = "hfm_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one shift, not forever

function sessionSecret(): string {
  // Derived from INTERNAL_API_KEY so no new env var is needed. Changing the
  // key invalidates all sessions, which is the wanted behaviour.
  return process.env.INTERNAL_API_KEY ?? "";
}

// value = "<expiresAtMs>.<csrfToken>.<hmac(expiresAtMs + "." + csrfToken)>"
export function issueSession(ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const csrf = randomUUID();
  const payload = `${expiresAt}.${csrf}`;
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(value: string | undefined): { csrf: string } | null {
  if (!value) return null;
  const [expiresAt, csrf, sig] = value.split(".");
  if (!expiresAt || !csrf || !sig) return null;
  const expected = createHmac("sha256", sessionSecret())
    .update(`${expiresAt}.${csrf}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return { csrf };
}

export async function requireAdmin(c: Context, next: Next) {
  const session = verifySession(getCookie(c, COOKIE_NAME));
  if (!session) return c.redirect("/internal/login");
  c.set("adminCsrf" as never, session.csrf as never);
  await next();
}

export function requireCsrf(c: Context): boolean {
  const sent = (c.req.bodyCache ? undefined : undefined) ?? undefined;
  return sent !== null;
}
```

Note for the implementer: `requireCsrf` above is intentionally minimal in this plan text.
Implement it for real: read the posted form field `csrf` and compare it with `c.get("adminCsrf")` using a timing-safe compare.
Reject with 403 when missing or wrong.

```ts
export const internalAuthRoutes = new Hono();

internalAuthRoutes.get("/login", (c) => {
  return c.html(`<!doctype html>
<html><head><title>Login</title></head>
<body>
  <form method="post" action="/internal/login">
    <input type="password" name="key" placeholder="Internal API key" autofocus>
    <button type="submit">Sign in</button>
  </form>
</body></html>`);
});

internalAuthRoutes.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const key = String(form.key ?? "");
  const expected = process.env.INTERNAL_API_KEY ?? "";
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && expected.length > 0 && timingSafeEqual(a, b);
  if (!ok) return c.text("Unauthorized", 401);
  c.header(
    "set-cookie",
    `${COOKIE_NAME}=${issueSession()}; HttpOnly; SameSite=Strict; Path=/internal; Max-Age=${SESSION_TTL_MS / 1000}${process.env.PUBLIC_BASE_URL?.startsWith("https") ? "; Secure" : ""}`,
  );
  return c.redirect("/internal/config");
});

internalAuthRoutes.post("/logout", (c) => {
  c.header("set-cookie", `${COOKIE_NAME}=; HttpOnly; Path=/internal; Max-Age=0`);
  return c.redirect("/internal/login");
});
```

In `internal.ts`, mount `internalAuthRoutes` and protect the config routes with `requireAdmin`, while keeping the `?key=` middleware only on the machine-readable routes listed in the contracts.

- [ ] **Step 4: Run**

```bash
bun test tests/internal-auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/internal-auth.ts src/routes/internal.ts tests/internal-auth.test.ts
git commit -m "feat: cookie session and CSRF for admin UI"
```

---

### Task 19: Tenant list and edit form

**Files:**
- Create: `apps/api/src/routes/internal-config.tsx`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/internal-config.test.ts`

Server-rendered with `hono/jsx`.
No client framework, no build step.
Inline CSS in the layout is enough for an internal tool.

- [ ] **Step 1: Layout and list page**

```tsx
// apps/api/src/routes/internal-config.tsx
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { TenantConfig, TenantRow, TenantTestResult } from "../types/tenant.types";
import { maskSecret } from "../utils/crypto";
import { decryptSecret } from "../utils/crypto";

const Layout = (props: { title: string; children: any }) => (
  <html>
    <head>
      <title>{props.title}</title>
      <style>{`
        body { font-family: system-ui, sans-serif; margin: 2rem; }
        table { border-collapse: collapse; }
        td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
        .badge-ok { background: #d4f7d4; padding: 2px 6px; }
        .badge-warn { background: #ffe9c7; padding: 2px 6px; }
        .badge-err { background: #ffd7d7; padding: 2px 6px; }
        form.inline { display: inline; }
      `}</style>
    </head>
    <body>{props.children}</body>
  </html>
);

function TestBadge({ row }: { row: TenantRow }) {
  if (!row.lastTestedAt) return <span class="badge-err">never tested</span>;
  try {
    const r = JSON.parse(row.lastTestResult!) as TenantTestResult;
    return r.lineOk && r.hfmOk && r.walletOk
      ? <span class="badge-ok">tested ok</span>
      : <span class="badge-warn">test failed</span>;
  } catch {
    return <span class="badge-warn">unknown</span>;
  }
}

function webhookUrl(webhookId: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "https://YOUR-HOST";
  return `${base}/webhook?oa=${webhookId}`;
}
```

The list route renders every tenant with its badge, webhook URL, and links.
The create and edit routes render the same `TenantForm`:

```tsx
function TenantForm({ row }: { row?: TenantRow }) {
  const isEdit = row !== undefined;
  return (
    <form method="post" action={isEdit ? `/internal/config/${row!.id}` : "/internal/config/new"}>
      <input type="hidden" name="csrf" value={"CSRF_FROM_CONTEXT"} />
      <label>Label <input name="label" required value={row?.label ?? ""} /></label><br />
      <label>
        LINE channel access token{" "}
        <input name="lineChannelAccessToken" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        LINE channel secret{" "}
        <input name="lineChannelSecret" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        HFM API key{" "}
        <input name="hfmApiKey" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        HFM base URL{" "}
        <input name="hfmApiBaseUrl" value={row?.hfmApiBaseUrl ?? "https://api.hfaffiliates.com"} />
      </label><br />
      <label>
        Target wallet{" "}
        <input name="targetWallet" type="number" min="1" required value={row?.targetWallet ?? ""} />
      </label><br />
      <label>
        <input type="checkbox" name="whitelistEnabled" checked={(row?.whitelistEnabled ?? 1) === 1} />
        whitelist enabled
      </label><br />
      <label>
        <input type="checkbox" name="active" checked={(row?.active ?? 0) === 1} />
        active
      </label><br />
      <button type="submit">Save</button>
    </form>
  );
}
```

The implementer replaces `CSRF_FROM_CONTEXT` by passing the CSRF token down as a prop from `requireAdmin` (available as `c.get("adminCsrf")`).
Secrets are never echoed back: the edit form shows only a placeholder.
If you need to show what is stored, show `maskSecret(decryptSecret(row.lineChannelAccessTokenEnc))` as a separate read-only line, never as an input value.

- [ ] **Step 2: Add tests for rendering**

```ts
test("list shows never-tested badge for a fresh tenant", async () => {
  const res = await app.request("/internal/config", { headers: { cookie: adminCookie() } });
  const html = await res.text();
  expect(html).toContain("never tested");
  expect(html).not.toContain(decryptedAnySecret);
});

test("unauthenticated list redirects to login", async () => {
  const res = await app.request("/internal/config");
  expect(res.status).toBe(302);
});
```

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx src/routes/internal.ts tests/internal-config.test.ts
git commit -m "feat: tenant list and edit form UI"
```

---

### Task 20: Save handler with bot identity fetch

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

- [ ] **Step 1: Tests**

```ts
test("save with empty secret fields keeps stored values", async () => {
  const before = await getTenantRowById(db, id);
  await app.request(`/internal/config/${id}`, {
    method: "POST",
    headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf, label: "New label", lineChannelAccessToken: "", lineChannelSecret: "", hfmApiKey: "", hfmApiBaseUrl: "https://api.hfaffiliates.com", targetWallet: "42", whitelistEnabled: "on", active: "on" }),
  });
  const after = await getTenantRowById(db, id);
  expect(after!.label).toBe("New label");
  expect(after!.lineChannelAccessTokenEnc).toBe(before!.lineChannelAccessTokenEnc);
});

test("save invalidates the tenant cache immediately", async () => {
  await getTenantById(id); // prime cache
  await app.request(`/internal/config/${id}`, { ...saveWithLabel("Cache check") });
  expect((await getTenantById(id))!.label).toBe("Cache check");
});

test("save fetches bot info and stores identity", async () => {
  globalThis.fetch = stubBotInfo({ userId: "U777", displayName: "My OA" }) as typeof fetch;
  await app.request(`/internal/config/${id}`, { ...saveWithLabel("Identity") });
  const row = await getTenantRowById(db, id);
  expect(row!.lineBotUserId).toBe("U777");
  expect(row!.lineDisplayName).toBe("My OA");
});

test("bot info failure still saves and shows a warning", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const res = await app.request(`/internal/config/${id}`, { ...saveWithLabel("Warn me") });
  const html = await res.text();
  expect(html).toContain("LINE token could not be verified");
});
```

- [ ] **Step 2: Implement the handlers**

The save handler:

```ts
async function handleSave(c: Context, id?: number) {
  if (!requireCsrf(c)) return c.text("Forbidden", 403);
  const form = await c.req.parseBody();
  const input: TenantInput = {
    label: String(form.label ?? "").trim(),
    active: form.active === "on",
    lineChannelAccessToken: String(form.lineChannelAccessToken ?? ""),
    lineChannelSecret: String(form.lineChannelSecret ?? ""),
    hfmApiKey: String(form.hfmApiKey ?? ""),
    hfmApiBaseUrl: String(form.hfmApiBaseUrl ?? "").trim() || "https://api.hfaffiliates.com",
    targetWallet: Number(form.targetWallet),
    whitelistEnabled: form.whitelistEnabled === "on",
  };

  // Validation: fail loudly, never half-save a tenant.
  const errors: string[] = [];
  if (!input.label) errors.push("label is required");
  if (!Number.isInteger(input.targetWallet) || input.targetWallet <= 0) {
    errors.push("target wallet must be a positive integer");
  }
  if (!input.hfmApiBaseUrl.startsWith("https://")) errors.push("base URL must be https");
  if (id === undefined) {
    if (!input.lineChannelAccessToken) errors.push("access token is required");
    if (!input.lineChannelSecret) errors.push("channel secret is required");
    if (!input.hfmApiKey) errors.push("HFM API key is required");
  }
  if (errors.length > 0) return c.html(errorPage(errors), 400);

  const tenantId = await saveTenant(input, id);

  // Verify the token and pin the bot identity. A failure is a warning, not
  // an error: the user explicitly chose that tests never block saving.
  let warning: string | null = null;
  const token = input.lineChannelAccessToken ||
    decryptSecret((await getTenantRowById(getDb(), tenantId))!.lineChannelAccessTokenEnc);
  const identity = await fetchBotInfo(token);
  if (identity) {
    await updateTenantLineIdentity(getDb(), tenantId, identity);
  } else {
    warning = "LINE token could not be verified. Check it before going live.";
  }

  return c.redirect(`/internal/config/${tenantId}${warning ? `?warn=${encodeURIComponent(warning)}` : ""}`);
}
```

Add `POST /internal/config/:id/rotate` that calls `rotateWebhookId(db, id)` and `invalidateTenantCache(id)`, and renders a page telling the operator to update the URL in the LINE console immediately.

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: save tenant with bot identity check"
```

---

### Task 21: Test connection button and status page

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

The test is a button, never a gate (decision Q24).
Activation is never blocked by a failed test.
But the list page shows a red badge for never-tested or failed, so a misconfigured OA cannot look healthy at a glance.

- [ ] **Step 1: Tests**

```ts
test("test stores a failing result and the list shows the badge", async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const auth = String((init!.headers as Record<string, string>).Authorization);
    if (auth.startsWith("Bearer line_ok")) {
      return new Response(JSON.stringify({ userId: "U1" }), { status: 200 });
    }
    return new Response("nope", { status: 401 }); // HFM down
  }) as typeof fetch;

  await app.request(`/internal/config/${id}/test`, {
    method: "POST", headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf }),
  });

  const row = await getTenantRowById(db, id);
  const result = JSON.parse(row!.lastTestResult!) as TenantTestResult;
  expect(result.lineOk).toBe(true);
  expect(result.hfmOk).toBe(false);
  expect(result.walletOk).toBe(false);
  const list = await (await app.request("/internal/config", { headers: { cookie: adminCookie() } })).text();
  expect(list).toContain("test failed");
});

test("wallet check uses the tenant's own HFM key", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (String(init!.headers ? (init!.headers as any).Authorization : "").includes("hfm")) {
      seen.push(String((init!.headers as Record<string, string>).Authorization));
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await app.request(`/internal/config/${id}/test`, { method: "POST", ...withCsrf() });
  expect(seen).toEqual([`Bearer ${ctxA.hfmApiKey}`]);
});
```

- [ ] **Step 2: Implement `POST /internal/config/:id/test`**

```ts
internalConfigRoutes.post("/:id/test", requireAdmin, async (c) => {
  const ctx = await getTenantById(Number(c.req.param("id")));
  if (!ctx) return c.text("Not Found", 404);

  // Three independent checks. LINE token via /v2/bot/info, HFM key via the
  // wallet balance probe, and the wallet itself must exist under that key.
  const identity = await fetchBotInfo(ctx.lineChannelAccessToken);
  const lineOk = identity !== null;

  let hfmOk = false;
  try {
    const res = await fetch(`${ctx.hfmApiBaseUrl}/api/wallet/balance`, {
      headers: { Authorization: `Bearer ${ctx.hfmApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    hfmOk = res.ok;
  } catch {
    hfmOk = false;
  }

  // The wallet check is the one that catches "wrong wallet copied from
  // another OA": a wrong-but-existing wallet would otherwise report happily
  // forever. It runs only when the key itself works.
  let walletOk = false;
  if (hfmOk) {
    const result = await fetchPerformance(ctx, {
      kind: "wallet", id: ctx.targetWallet, label: String(ctx.targetWallet),
    });
    walletOk = result.ok;
  }

  const message = [lineOk && "LINE ok", hfmOk && "HFM ok", walletOk && "wallet ok"]
    .filter(Boolean).join(", ") || "all checks failed";
  await updateTenantTestResult(getDb(), ctx.id, { lineOk, hfmOk, walletOk, message });
  invalidateTenantCache(ctx.id);
  return c.redirect(`/internal/config/${ctx.id}`);
});
```

- [ ] **Step 3: Status page `GET /internal/config/:id/status`**

Show: LINE identity (displayName, basicId, botUserId), active flag, target wallet, last test result and time, `tenant_health_state` row, webhook URL, last webhook activity and request counts from `listLineUsers(db, ctx.id)`, and last-trade cache freshness if the map is warm.

- [ ] **Step 4: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: tenant connection test and status page"
```

---

### Task 22: Whitelist and notify recipient management

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

- [ ] **Step 1: Tests**

```ts
test("adding a whitelist uid takes effect on the next webhook without restart", async () => {
  await app.request(`/internal/config/${id}/whitelist`, {
    method: "POST", headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf, lineUid: "Unew", label: "new guy", action: "add" }),
  });
  const ctx = await getTenantById(id); // fresh read after invalidate
  expect(ctx!.whitelistUids).toContain("Unew");
  // then POST a webhook from Unew and expect it not to be rejected
});

test("notify recipients are per tenant", async () => {
  await app.request(`/internal/config/${idA}/recipients`, { method: "POST", ...addUid("Ur1") });
  await app.request(`/internal/config/${idB}/recipients`, { method: "POST", ...addUid("Ur2") });
  expect(await getActiveUids(db, idA)).toEqual(["Ur1"]);
  expect(await getActiveUids(db, idB)).toEqual(["Ur2"]);
});
```

- [ ] **Step 2: Implement two form endpoints**

`POST /internal/config/:id/whitelist` with `action=add|remove`, `lineUid`, `label`:
calls `addWhitelistUid` or `removeWhitelistUid`, then `invalidateTenantCache(id)`.
The cache invalidation is mandatory because `whitelistUids` lives inside the cached `TenantConfig`.

`POST /internal/config/:id/recipients` with the same shape for notify uids via `addRecipient` / `removeRecipient`.

Render both lists with remove buttons inside the tenant detail page.

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: manage whitelist and recipients per tenant"
```

---
