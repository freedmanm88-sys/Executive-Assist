# n8n Workflow Exports

Phase 1 workflow JSON exports live here. Each workflow is exported from n8n's UI (⋯ menu → Download) and committed to version control so we can:
- Rebuild the entire system from scratch if the n8n volume is ever lost
- Diff workflow changes across iterations
- Share workflows when partners onboard in Phase 5

## File naming convention

```
01-telegram-inbound-router.json
02-chat-agent.json
03a-email-triage-personal.json
03b-email-triage-business1.json
03c-email-triage-business2.json
04-urgent-nag-loop.json
05-daily-digest.json
06-feedback-handler.json
07-weekly-preference-distillation.json
08-admin-dashboard.json
```

## Build order (per `03_DEPLOYMENT.md` Step 4)

1. Workflow 1 (Telegram Inbound Router) — receives messages, routes by command
2. Workflow 2 (Chat Agent) — first with **only 2 tools**: `create_habit`, `log_habit`. Verify round trip before adding more.
3. Expand Chat Agent tools incrementally (one at a time, test each)
4. Workflow 3a (Email Triage for Gmail #1 only) — verify before duplicating
5. Workflows 4–8
6. Duplicate Workflow 3 for Gmails #2 and #3

## Testing checkpoints

Before promoting any workflow to production-ready, it must:
- Set RLS context via `SELECT set_user_context($1::uuid)` as the first DB action
- Log every Claude decision to `ai_decisions` with reasoning
- Surface decisions in Telegram with ✅/❌/✏️ feedback buttons (where applicable)
