# ADR 0002 — n8n custom Dockerfile runs as root, sets WebSocket push

**Status:** Accepted
**Date:** 2026-04-29
**Phase:** 1 (initial deployment)

---

## Context

During Phase 1 deployment of the n8n service on Railway, we hit two distinct problems that both pointed to needing a custom image rather than running `n8nio/n8n:latest` directly.

### Problem 1 — EACCES on the persistent volume mount

Railway mounts persistent volumes with root ownership at the container's mount path. The official n8n image (`n8nio/n8n:latest`) runs as the unprivileged user `node` (uid 1000).

Repro:
1. Deploy `n8nio/n8n:latest` from Docker Hub on Railway
2. Attach a volume at `/home/node/.n8n` (n8n's default data dir)
3. Container starts → n8n tries to write `/home/node/.n8n/config` → `EACCES: permission denied, open '/home/node/.n8n/config'`
4. Container crash-loops

Workaround attempt 1 — change mount point to `/data` and set `N8N_USER_FOLDER=/data`:
- Same error: `EACCES: permission denied, mkdir '/data/.n8n'`
- Confirms it's not path-specific; Railway-mounted volumes are root-owned regardless of where you mount them.

Workaround attempt 2 — chown via init script:
- Doable but fragile, requires entrypoint surgery, and the n8n image's existing entrypoint already wires up some things we'd need to preserve.

### Problem 2 — Editor "lost connection" flapping every 2s

Default `N8N_PUSH_BACKEND` falls back to SSE long-poll behind some reverse-proxy configurations. Railway's edge proxy doesn't reject the WebSocket upgrade, but n8n didn't try a WS handshake until told to. The SSE 2-second poll cycle made the editor's connection indicator flap green → red → green continuously, even though delivery was working.

---

## Decision

**Build a thin custom Dockerfile** that:
1. Inherits from `n8nio/n8n:latest`
2. Switches to `USER root` so the container can write the Railway-mounted volume
3. Bakes `ENV N8N_PUSH_BACKEND=websocket` so the editor uses a single persistent WebSocket instead of SSE long-poll

Deploy via Railway's **GitHub repo source** (using the `Dockerfile` at the repo root), not Docker Hub image source.

```dockerfile
FROM n8nio/n8n:latest
USER root
ENV N8N_PUSH_BACKEND=websocket
```

That's the entire image. The base entrypoint and CMD are inherited unchanged.

---

## Consequences

### Accepted trade-offs

- **Loss of defense-in-depth inside the container.** A compromise of n8n's process now has root inside the container, not just `node`. This does NOT change host security — containers are still isolated, and Railway runs them in a sandboxed runtime. But a malicious n8n custom node, for example, could now write anywhere in the container filesystem, not just `/home/node` and `/tmp`.
- **Image upgrades require a Dockerfile bump + git commit + Railway redeploy** (vs. just changing the image tag on a Docker Hub source). Two extra clicks. Worth it.
- **Coupled to `n8nio/n8n:latest` mutability.** Each Railway redeploy pulls the current `:latest`. If n8n ships a breaking change, our deploy picks it up unannounced. Mitigation: pin to a specific version tag (e.g. `n8nio/n8n:1.78.0`) once we hit a stable Phase 1.

### What this enables

- **Editor stays connected.** The N8N_PUSH_BACKEND var alone could be set as a Railway env var, but baking it into the image means a fresh deploy can never accidentally lose it.
- **No volume permission errors on first boot, on every restart, on every redeploy.** No fragile entrypoint scripts. No race conditions between chown and n8n startup.

### What we explicitly chose NOT to do

- **chown-then-drop entrypoint pattern** — would let us run as `node` after fixing volume perms. Cleaner from a security perspective, but Railway's redeploy lifecycle made it unreliable in testing (volume mounts re-init at unpredictable times). Defer until Phase 5 when we revisit the deployment platform.
- **Switch to a managed n8n provider** (n8n Cloud, etc.) — would solve both problems but loses the self-hosted control we want for PII boundaries. Reconsider at Phase 5 partner onboarding.
- **Run n8n as a non-root user with a read-write volume via volume init container** — Railway doesn't support sidecars on Hobby plan. Pro plan only.

---

## Notes for future sessions

- The Dockerfile lives at the repo root: `Executive-Assist/Dockerfile`.
- Railway's `n8n` service is configured with **Source: GitHub repo** pointing at `freedmanm88-sys/Executive-Assist` main branch. Builds automatically pick up Dockerfile changes on push.
- If the Dockerfile is ever moved or renamed, update Railway's service settings: **Settings → Build → Dockerfile Path**.
- If WebSocket connectivity ever degrades again in production, first check `N8N_PUSH_BACKEND` is still `websocket` (env var on the running container, not just in the Dockerfile — env vars on Railway override image ENV directives).

### Related ADRs
- ADR 0001 — Railway redeploy wipes Postgres volume; use restart. Relevant here because deploying a Dockerfile change to n8n triggers a redeploy. Verified in practice that the n8n volume survives this redeploy because n8n stores its real state in external Postgres (DB_TYPE=postgresdb), not the volume — only the encryption key file lives on the volume, and that's also in the env var so it's redundant.
