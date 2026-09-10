# Multi-tenant LINE OA rollout runbook

Date: 2026-09-05.
This runbook deploys the multi-tenant LINE OA change from `docs/plans/2026-09-05-multi-tenant-line-oa.md`.
It assumes one existing OA running on the pre-migration code.
Read the whole sequence once before starting; steps 1 and 2 are prerequisites for every later step.

## Sequence

1. Back up the database: `pg_dump` the whole database and store it off-host.
   The migration drops unique constraints and changes primary keys, which is irreversible without the backup.
2. Generate and set `CONFIG_ENCRYPTION_KEY` in the deployment environment.
   Generate it with `bun -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and store it in your secret manager.
   It must decode to exactly 32 bytes, and a missing or invalid value kills the process at boot.
3. Keep the eight per-OA env vars in place for this deploy only; the seed needs them once.
   The eight vars are `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `HFM_API_KEY`, `HFM_API_BASE_URL`, `TARGET_WALLET`, `LINE_WHITELIST_ENABLED`, `LINE_WHITELIST_UIDS`, and `LINE_NOTIFY_UIDS`.
4. Deploy the new image.
5. Read the boot log and confirm: `[bootstrap] seeded default tenant from env` with the printed webhook id, and one `last-trade cache warmed` line per active tenant.
   The full boot message also prints the webhook path to set in the LINE console, `/webhook?oa=<webhook id>`.
6. In the LINE console of the existing OA, replace the webhook URL with `https://<host>/webhook?oa=<printed webhook id>` and press Verify.
   Verify sends a real webhook request, so a green result means the tenant resolved and the signature check passed.
7. Send a test message to the existing OA and confirm the card still replies with the right wallet.
8. Remove the eight per-OA env vars from the deployment environment and restart once, confirming the tenant still resolves from the database.
   After this restart nothing outside the first-boot seed reads those vars.
9. Add the second OA through `/internal/config`, press Test, review the badges, then paste its webhook URL into that OA's LINE console.
   The list and detail pages show each tenant's webhook URL and a test badge (`never tested`, `tested ok`, or `test failed`).
10. Watch `/internal/health/tenants` for one healthcheck cycle.
    The healthcheck cron runs every 5 minutes and the endpoint accepts `?key=INTERNAL_API_KEY` or an admin cookie session.

## Rollback

Rollback means restoring the code and the `pg_dump` from step 1.
The database changes (composite keys, backfilled `tenant_id`, dropped constraints) cannot be reverted in place, which is why the backup is mandatory.
Rolling back code without restoring the database is not supported.
