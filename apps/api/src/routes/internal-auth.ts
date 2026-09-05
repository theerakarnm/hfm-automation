import { Hono } from "hono";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";

export const COOKIE_NAME = "hfm_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one shift, not forever

// The internal UI stores its CSRF token in c.var. Hono context variables are
// typed through the app's Env, but this middleware must stay mountable on any
// Hono app (including the untyped test app), so the variable is accessed
// through this narrow cast instead of a generic app type.
type AdminVariables = { Variables: { adminCsrf: string } };

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

// Exported because the machine-readable /internal routes accept a valid admin
// cookie as an alternative to ?key= (see routes/internal.ts).
export function verifySession(value: string | undefined): { csrf: string } | null {
  if (!value) return null;
  const [expiresAt, csrf, sig] = value.split(".");
  if (!expiresAt || !csrf || !sig) return null;
  const expected = createHmac("sha256", sessionSecret())
    .update(`${expiresAt}.${csrf}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // "<=" not "<": the expiry instant itself counts as expired. issueSession(0)
  // produces expiresAt == now, and the same-millisecond verification of a
  // freshly issued token must still reject it.
  if (Number(expiresAt) <= Date.now()) return null;
  return { csrf };
}

// Gate for every /internal/config* page. Redirects anonymous browsers to the
// login form instead of a bare 401 so the UI stays usable.
export async function requireAdmin(c: Context, next: Next) {
  const session = verifySession(getCookie(c, COOKIE_NAME));
  if (!session) return c.redirect("/internal/login");
  (c as unknown as Context<AdminVariables>).set("adminCsrf", session.csrf);
  await next();
}

// CSRF check for mutating admin forms. Run this after requireAdmin and answer
// 403 when it returns false:
//   if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
// The posted form field "csrf" is compared with the token embedded in the
// signed session cookie, so an attacker who cannot read the httpOnly cookie
// cannot forge a valid form. parseBody caches, so handlers can call it again.
export async function requireCsrf(c: Context): Promise<boolean> {
  const sessionCsrf = (c as unknown as Context<AdminVariables>).get("adminCsrf");
  if (typeof sessionCsrf !== "string" || sessionCsrf.length === 0) return false;
  let sent: unknown;
  try {
    sent = (await c.req.parseBody()).csrf;
  } catch {
    // Not a form body at all: never a valid CSRF submission.
    return false;
  }
  if (typeof sent !== "string" || sent.length === 0) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(sessionCsrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
