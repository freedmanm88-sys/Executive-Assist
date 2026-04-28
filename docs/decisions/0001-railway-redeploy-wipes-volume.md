# ADR 0001 — Railway `redeploy` wipes Postgres volume; use `restart`

**Status:** Accepted
**Date:** 2026-04-27
**Phase:** 1 (initial deployment)

---

## Context

During Phase 1 deployment, after attaching a persistent volume to the `pgvector` Postgres service in Railway and writing test data, we discovered that `railway redeploy` wipes all data despite the volume showing as correctly attached and persisted.

### Reproduction (observed)
1. Deploy `pgvector/pgvector:pg16` with env vars (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `PGDATA=/var/lib/postgresql/data/pgdata`)
2. Attach volume `pgvector-volume` at `/var/lib/postgresql/data` via `railway volume add --mount-path /var/lib/postgresql/data`
3. Volume initializes, Postgres `initdb` runs into the volume — expected (empty volume on first attach)
4. Connect via `railway ssh psql`, `CREATE TABLE volume_test`, `INSERT` row
5. Run `railway redeploy`
6. Reconnect, `SELECT * FROM volume_test` — **`relation "volume_test" does not exist"`**
7. Logs from the redeployed container show `running bootstrap script ... ok` — fresh `initdb` ran again

### Same scenario with `railway restart` instead
1. Repeat steps 1–4 above
2. Run `railway restart` (not redeploy)
3. Reconnect, `SELECT * FROM volume_test` — **row returned**
4. Logs show `PostgreSQL Database directory appears to contain a database; Skipping initialization` — existing data preserved

### Confirmed mount is real
- `mount | grep postgresql` → `/dev/zd4256 on /var/lib/postgresql/data type ext4`
- `df -h /var/lib/postgresql/data` → `4.6G total, 48M used` (separate device, persistent)
- `ls /var/lib/postgresql/data/pgdata` → standard Postgres cluster files (`base`, `global`, `pg_hba.conf`, etc.)

The volume itself is genuinely persistent across operations — the issue is specifically that Railway's `redeploy` operation triggers a fresh `initdb` despite the volume being mounted with intact data.

---

## Decision

**Use `railway restart` for any service-bounce operation on the Postgres service. Do not use `railway redeploy` once the database holds data.**

Specifically:
- Env var changes auto-trigger `restart`, not `redeploy` — safe.
- Manual bouncing of pgvector → use `railway restart`.
- Image upgrades (which require `redeploy` to pick up a new image tag): require an explicit backup-and-restore plan; cannot be done in place.

---

## Consequences

### Accepted trade-offs
- **Image upgrades become a multi-step procedure**: `pg_dump` → upgrade image tag → redeploy will wipe → `pg_restore` from dump → restart. Worth documenting as a runbook before first version bump.
- **Cannot rebuild from a "stuck" state via redeploy** without losing data. If pgvector ever becomes unbootable, recovery is via fresh deploy + restore from a snapshot we maintain.
- **Backup discipline becomes mandatory before any destructive Railway operation.** Any time we touch the pgvector service, take a `pg_dump` first.

### Mitigations
- Add weekly cron job to dump Postgres to a Railway volume backup directory (or external storage) — Phase 5 work.
- Document the rule prominently in `03_DEPLOYMENT.md` for partners onboarding.
- Consider switching to a managed Postgres provider (Neon, Supabase) when Phase 5 lands and we can no longer accept this risk class for partner data.

### Open question — does this affect n8n's volume too?
Hypothesis: yes, same behavior likely for any Railway volume on `redeploy`. We'll learn when we deploy n8n. Document the result as an addendum to this ADR.

---

## Notes for future sessions

- Cause of the behavior is unconfirmed. Possibilities: Railway's redeploy reinitializes the volume bind in a way that exposes an empty overlay; or the postgres entrypoint sees a transient empty PGDATA during volume reattachment and decides to re-init. Either way, the practical rule stands.
- This may be Hobby-plan specific. Worth retesting on Pro plan if/when we upgrade for the Canadian region.
