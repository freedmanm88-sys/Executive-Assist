# Custom n8n image for Railway deployment.
#
# Why this exists: Railway mounts persistent volumes with root ownership.
# n8n's official image runs as user `node` (uid 1000), which can't write to
# a root-owned mount point. This causes EACCES on /data/.n8n at startup.
#
# Fix: run n8n as root. Loses some defense-in-depth (container compromise =
# root inside container) but doesn't change host security since containers
# are isolated. Acceptable for Phase 1 personal use.
#
# Long-term fix (Phase 5+): switch to a chown-then-drop entrypoint or a
# managed n8n provider so we don't have to think about volume permissions.

FROM n8nio/n8n:latest

USER root

# n8n image already has the right ENTRYPOINT/CMD; just inheriting them
# but as root user resolves the volume permission issue.
