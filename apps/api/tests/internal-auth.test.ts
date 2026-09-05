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
