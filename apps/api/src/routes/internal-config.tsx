/** @jsxImportSource hono/jsx */
// Server-rendered admin UI for tenant configuration. Read-only pages in this
// task; the form POST handlers arrive with the save task. Secrets are
// write-only: the page shows maskSecret(decryptSecret(...)) text, never an
// input value, so a decrypted secret cannot leak into HTML or browser
// autofill.
import { Hono } from "hono";
import type { Context } from "hono";
import type { TenantRow, TenantTestResult } from "../types/tenant.types";
import { decryptSecret, maskSecret } from "../utils/crypto";
import { logError } from "../utils/logger";
import { getDb } from "../db/connection";
import { getTenantRowById, listTenantRows } from "../repositories/tenant.repository";

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
              <td><a href={`/internal/config/${row.id}`}>Edit</a></td>
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
  return c.html(
    <Layout title={`Edit ${row.label} - HFM internal`}>
      <h1>Edit tenant: {row.label}</h1>
      <p><a href="/internal/config">Back to the tenant list</a></p>
      <p>
        Test status: <TestBadge row={row} /> · Webhook URL: <code>{webhookUrl(row.webhookId)}</code>
      </p>
      <TenantForm row={row} csrf={csrfFrom(c)} />
    </Layout>,
  );
});

export default internalConfigRoutes;
