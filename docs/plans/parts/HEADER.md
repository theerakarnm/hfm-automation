# Multi-tenant LINE OA Implementation Plan

> **For agentic workers:** implement this plan task by task, in order.
> Steps use checkbox (`- [ ]`) syntax for tracking.
> Read the "Shared contracts" section before any task, and never change a name defined there without updating every other task that uses it.

**Goal:** Move every per-OA setting (LINE channel access token, LINE channel secret, HFM API key, target wallet, whitelist uids, notify uids) out of `.env` and into PostgreSQL, so one server can host many LINE Official Accounts, each with its own configuration, edited through an internal web UI.

**Architecture:** Each OA becomes a `tenants` row with a random `webhook_id`.
LINE calls `POST /webhook?oa=<webhook_id>`, and that id selects which tenant config to load from an in-memory cache backed by PostgreSQL.
The loaded `TenantConfig` is then passed explicitly as the first argument (`ctx`) into every service that used to read `process.env`, so the compiler, not a code review, is what guarantees the right key and the right wallet are used.
Secrets are encrypted at rest with AES-256-GCM.
Every existing table gains a `tenant_id`, and every unique key that could collide across tenants is rebuilt to include it.

**Tech Stack:** Bun, TypeScript (ESM, strict), Hono 4 with `hono/jsx` for the admin UI, Drizzle ORM, PostgreSQL 16, croner, pino, `node:crypto` for AES-256-GCM.

**Branch:** `feat/multi-tenant-line-oa`

---

## Why each decision was made

The full decision table, the LINE platform facts that constrain the design, the environment variable split, the exact DDL, and every type and function signature live in the next section.
Read it once, completely, before starting Task 1.

Three findings from the current codebase shaped the plan and are worth stating up front.

The last-trade cache in `apps/api/src/services/last-trade.service.ts` is a module-level singleton.
Left as it is, OA number two would be served OA number one's customer data, which is a data leak and not merely a wrong value.

`daily_report_notifications` uses `snapshot_date` as its primary key and `line_users` uses `line_uid` as its primary key.
Left as they are, the second OA would silently skip its daily report because the first OA already "sent" that date, and two customers with the same LINE uid across two OAs would overwrite each other.

The 05:00 ICT daily report described in `INITIAL.md` is not scheduled anywhere in this repository.
`apps/api/src/jobs/index.ts` registers only the healthcheck.
Task 16 adds the real schedule, which is new production behaviour and must be announced to the operator before deploy.

---

## File structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `apps/api/src/utils/crypto.ts` | create | AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/api/src/types/tenant.types.ts` | create | `TenantConfig`, `TenantRow`, `TenantInput`, `TenantTestResult` |
| `apps/api/src/repositories/tenant.repository.ts` | create | All SQL for `tenants`, `tenant_whitelist_uids`, `tenant_health_state`. Never encrypts or decrypts |
| `apps/api/src/services/tenant-config.service.ts` | create | Decrypt, cache, invalidate, save. The only module that touches crypto |
| `apps/api/src/db/bootstrap.ts` | create | One-time seed of the first tenant from the old env vars |
| `apps/api/src/routes/internal-auth.ts` | create | Login, cookie session, CSRF for the admin UI |
| `apps/api/src/routes/internal-config.tsx` | create | Tenant list, edit form, test button, status page |
| `apps/api/scripts/lib/resolve-tenant.ts` | create | Shared `--tenant` / `--all` argument parsing for the repair scripts |
| `apps/api/tests/multi-tenant-isolation.test.ts` | create | The proof that no data or credential crosses tenants |
| `apps/api/src/db/schema.ts` | modify | New tables, `tenant_id` columns, rebuilt unique keys |
| `apps/api/src/db/connection.ts` | modify | `initDb` creates new tables, seeds, then migrates existing tables |
| `apps/api/src/services/hfm.service.ts` | modify | `ctx` first parameter, no env reads |
| `apps/api/src/services/line.service.ts` | modify | `ctx` first parameter, plus `fetchBotInfo` |
| `apps/api/src/services/last-trade.service.ts` | modify | Cache and single-flight keyed by tenant id |
| `apps/api/src/utils/whitelist.ts` | modify | Reads the whitelist from `ctx`, not from env |
| `apps/api/src/repositories/*.ts` | modify | `tenantId` second parameter everywhere |
| `apps/api/src/routes/webhook.ts` | modify | Tenant resolution, signature per tenant, destination cross-check |
| `apps/api/src/routes/internal.ts` | modify | Liveness-only health, per-tenant status, mounts the new routes |
| `apps/api/src/jobs/daily-client-report.ts` | modify | Per tenant, no env target wallet |
| `apps/api/src/jobs/hfm-healthcheck.ts` | modify | Per tenant, state in the database |
| `apps/api/src/jobs/index.ts` | modify | Healthcheck loop plus the new 05:00 ICT daily report cron |
| `apps/api/src/index.ts` | modify | Encryption key check, sequential per-tenant cache warm |
| `apps/api/scripts/*.ts` | modify | Explicit tenant selection, no guessing |
| `apps/api/tests/db-helpers.ts` | modify | New tables in the drop and create blocks |
| `apps/api/Dockerfile` | modify | Ship `scripts/` in the image |
| `docker-compose.yml` | modify | Build context that actually exists, higher memory limit, new env |
| `apps/api/.env.example` | modify | System-only variables, old ones marked first-boot only |
| `AGENTS.md` | modify | Multi-tenant section and updated security notes |

---

