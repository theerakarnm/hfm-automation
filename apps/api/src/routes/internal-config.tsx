/** @jsxImportSource hono/jsx */
// Server-rendered admin UI for tenant configuration. Read-only pages in this
// task; the form POST handlers arrive with the save task. Secrets are
// write-only: the page shows maskSecret(decryptSecret(...)) text, never an
// input value, so a decrypted secret cannot leak into HTML or browser
// autofill.
import { Hono } from "hono";
import type { Context } from "hono";
import type { TenantInput, TenantRow, TenantTestResult } from "../types/tenant.types";
import { decryptSecret, maskSecret } from "../utils/crypto";
import { logError } from "../utils/logger";
import { getDb } from "../db/connection";
import {
  getTenantHealthStateRow,
  getTenantRowById,
  listTenantRows,
  rotateWebhookId,
  updateTenantLineIdentity,
  updateTenantTestResult,
} from "../repositories/tenant.repository";
import { listLineUsers } from "../repositories/line-user.repository";
import { invalidateTenantCache, getTenantById, saveTenant } from "../services/tenant-config.service";
import { fetchBotInfo } from "../services/line.service";
import { fetchPerformance } from "../services/hfm.service";
import { getLastTradeCacheInfo } from "../services/last-trade.service";
import { requireCsrf } from "./internal-auth";

// requireAdmin stores the CSRF token in c.var. The route is mounted on the
// untyped internal app, so the variable is read through this narrow cast,
// mirroring routes/internal-auth.ts.
type AdminVariables = { Variables: { adminCsrf: string } };

function csrfFrom(c: Context): string {
  return (c as unknown as Context<AdminVariables>).get("adminCsrf");
}

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

// Same badge as TestBadge, but rendered from the parsed TenantConfig that
// the status page already holds (the service parses lastTestResult).
function testOutcomeBadge(result: TenantTestResult | null) {
  if (!result) return <span class="badge-warn">unknown</span>;
  return result.lineOk && result.hfmOk && result.walletOk
    ? <span class="badge-ok">tested ok</span>
    : <span class="badge-warn">test failed</span>;
}

function webhookUrl(webhookId: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "https://YOUR-HOST";
  return `${base}/webhook?oa=${webhookId}`;
}

// Display-only helper: a failed decrypt (rotated CONFIG_ENCRYPTION_KEY or a
// corrupt row) degrades to a marker instead of breaking the whole page, and
// is logged loudly so the operator knows the stored secret is unreadable.
function storedMask(enc: string): string {
  try {
    return maskSecret(decryptSecret(enc));
  } catch (error) {
    logError("internal-config", error);
    return "unreadable";
  }
}

function errorPage(errors: string[]) {
  return (
    <Layout title="Save failed - HFM internal">
      <h1>Save failed</h1>
      <p>Nothing was saved. Fix the following and try again:</p>
      <ul>
        {errors.map((error) => <li>{error}</li>)}
      </ul>
      <p><a href="/internal/config">Back to the tenant list</a></p>
    </Layout>
  );
}

// Shared POST body for create and edit. Saves through tenant-config.service
// (which encrypts and invalidates the cache), then pins the bot identity.
async function handleSave(c: Context, id?: number) {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
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

function TenantForm({ row, csrf }: { row?: TenantRow; csrf: string }) {
  const isEdit = row !== undefined;
  return (
    <form method="post" action={isEdit ? `/internal/config/${row!.id}` : "/internal/config/new"}>
      <input type="hidden" name="csrf" value={csrf} />
      <label>Label <input name="label" required value={row?.label ?? ""} /></label><br />
      <label>
        LINE channel access token{" "}
        <input type="password" autocomplete="new-password" name="lineChannelAccessToken" placeholder={isEdit ? "unchanged" : ""} />
      </label>
      {isEdit ? <> stored as <code>{storedMask(row!.lineChannelAccessTokenEnc)}</code></> : null}<br />
      <label>
        LINE channel secret{" "}
        <input type="password" autocomplete="new-password" name="lineChannelSecret" placeholder={isEdit ? "unchanged" : ""} />
      </label>
      {isEdit ? <> stored as <code>{storedMask(row!.lineChannelSecretEnc)}</code></> : null}<br />
      <label>
        HFM API key{" "}
        <input type="password" autocomplete="new-password" name="hfmApiKey" placeholder={isEdit ? "unchanged" : ""} />
      </label>
      {isEdit ? <> stored as <code>{storedMask(row!.hfmApiKeyEnc)}</code></> : null}<br />
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

const internalConfigRoutes = new Hono();

internalConfigRoutes.get("/", async (c) => {
  const rows = await listTenantRows(getDb());
  return c.html(
    <Layout title="Tenants - HFM internal">
      <h1>Tenants</h1>
      <p><a href="/internal/config/new">Add a new tenant</a></p>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Test</th>
            <th>Webhook URL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr>
              <td>{row.label}{row.active === 1 ? "" : " (inactive)"}</td>
              <td><TestBadge row={row} /></td>
              <td><code>{webhookUrl(row.webhookId)}</code></td>
              <td><a href={`/internal/config/${row.id}`}>Edit</a> · <a href={`/internal/config/${row.id}/status`}>Status</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );
});

internalConfigRoutes.get("/new", (c) => {
  return c.html(
    <Layout title="New tenant - HFM internal">
      <h1>New tenant</h1>
      <p><a href="/internal/config">Back to the tenant list</a></p>
      <TenantForm csrf={csrfFrom(c)} />
    </Layout>,
  );
});

internalConfigRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const row = await getTenantRowById(getDb(), id);
  if (!row) return c.notFound();
  const warn = c.req.query("warn");
  return c.html(
    <Layout title={`Edit ${row.label} - HFM internal`}>
      <h1>Edit tenant: {row.label}</h1>
      <p><a href="/internal/config">Back to the tenant list</a></p>
      {warn ? <p class="badge-warn">{warn}</p> : null}
      <p>
        Test status: <TestBadge row={row} /> · Webhook URL: <code>{webhookUrl(row.webhookId)}</code>
      </p>
      {/*
        The connection test is a button, never a gate (Q24): it stores the
        result and redirects back here. Activation is never blocked by a
        failed test; the badge above is how a misconfigured OA stays visible.
      */}
      <form method="post" action={`/internal/config/${row.id}/test`} class="inline">
        <input type="hidden" name="csrf" value={csrfFrom(c)} />
        <button type="submit">Test connection</button>
      </form>
      <p><a href={`/internal/config/${row.id}/status`}>View full status page</a></p>
      <TenantForm row={row} csrf={csrfFrom(c)} />
    </Layout>,
  );
});

internalConfigRoutes.post("/new", (c) => handleSave(c));

internalConfigRoutes.post("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  return handleSave(c, id);
});

// Rotating the webhook id kills the old URL instantly: the webhook resolver
// finds no tenant for it and answers 404. The operator must paste the new
// URL into the LINE Developers Console right away, so the response is a
// page that shows both URLs instead of a silent redirect.
internalConfigRoutes.post("/:id/rotate", async (c) => {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const row = await getTenantRowById(getDb(), id);
  if (!row) return c.notFound();
  const newWebhookId = await rotateWebhookId(getDb(), id);
  invalidateTenantCache(id);
  return c.html(
    <Layout title="Webhook URL rotated - HFM internal">
      <h1>Webhook URL rotated</h1>
      <p>Update the webhook URL in the LINE Developers Console immediately. The old URL stops working right now.</p>
      <p>Old URL: <code>{webhookUrl(row.webhookId)}</code></p>
      <p>New URL: <code>{webhookUrl(newWebhookId)}</code></p>
      <p><a href={`/internal/config/${id}`}>Back to the tenant</a></p>
    </Layout>,
  );
});

// Connection test button (Q24: a button, never a gate). Three independent
// checks run against the tenant's OWN stored credentials, the result is
// persisted for the list/detail badges, and the operator is redirected back
// to the edit page regardless of the outcome.
internalConfigRoutes.post("/:id/test", async (c) => {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const ctx = await getTenantById(id);
  if (!ctx) return c.notFound();

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

// Read-only per-tenant status page: everything an operator needs to decide
// whether this OA is wired correctly, without a single upstream call.
internalConfigRoutes.get("/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const ctx = await getTenantById(id);
  if (!ctx) return c.notFound();

  const db = getDb();
  const health = await getTenantHealthStateRow(db, ctx.id);
  const users = await listLineUsers(db, ctx.id);
  const cache = getLastTradeCacheInfo(ctx.id);

  return c.html(
    <Layout title={`Status ${ctx.label} - HFM internal`}>
      <h1>Tenant status: {ctx.label}</h1>
      <p><a href="/internal/config">Back to the tenant list</a> · <a href={`/internal/config/${ctx.id}`}>Edit this tenant</a></p>
      <table>
        <tbody>
          <tr><th>Active</th><td>{ctx.active ? "active" : "inactive"}</td></tr>
          <tr><th>Webhook URL</th><td><code>{webhookUrl(ctx.webhookId)}</code></td></tr>
          <tr><th>LINE display name</th><td>{ctx.lineDisplayName ?? "not set"}</td></tr>
          <tr><th>LINE basic id</th><td>{ctx.lineBasicId ?? "not set"}</td></tr>
          <tr><th>LINE bot user id</th><td>{ctx.lineBotUserId ?? "not set"}</td></tr>
          <tr><th>Target wallet</th><td>{ctx.targetWallet}</td></tr>
          <tr>
            <th>Last test</th>
            <td>
              {testOutcomeBadge(ctx.lastTestResult)} {ctx.lastTestedAt ?? "never tested"}
              {ctx.lastTestResult ? <> - {ctx.lastTestResult.message}</> : null}
            </td>
          </tr>
          <tr>
            <th>HFM health (cron)</th>
            <td>
              {health
                ? <>
                    {health.healthy ? "healthy" : "unhealthy"} since {health.changedAt}
                  </>
                : "no state yet (assumed healthy)"}
            </td>
          </tr>
          <tr>
            <th>Last-trade cache</th>
            <td>
              {cache.warm
                ? <>warm, {cache.entries} entries, fetched {new Date(cache.fetchedAt!).toISOString()}</>
                : "cold"}
            </td>
          </tr>
        </tbody>
      </table>
      <h2>LINE users</h2>
      {users.length === 0
        ? <p>No LINE user has talked to this OA yet.</p>
        : (
          <table>
            <thead>
              <tr><th>Line uid</th><th>Requests</th><th>Last seen</th><th>First seen</th><th>Last event</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr>
                  <td>{u.line_uid}</td>
                  <td>{u.request_count}</td>
                  <td>{u.last_seen_at}</td>
                  <td>{u.first_seen_at}</td>
                  <td>{u.last_event_type ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Layout>,
  );
});

export default internalConfigRoutes;
