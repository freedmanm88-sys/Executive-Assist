# AI Personal Assistant — Architecture & Design

> **Product positioning:** AI personal assistant for solopreneurs and small business owners. Solo first, partners next, public SaaS later. Canada first, other regions later.

This document explains *why* the system is built this way. Read this first. The schema and workflow files are the *how*.

## The core insight

You're not building a chatbot. You're building a system that takes actions on your behalf across email, calendar, accounting, and your phone — and gets smarter every week from your feedback. The user-facing surface is just Telegram messages. Underneath, every decision the assistant makes is logged, justified, and correctable.

## The stack

```
┌─────────────────────────────────────────────────────────────────┐
│  USER SURFACE                                                   │
│  Telegram (mobile + desktop) — single chat thread per user      │
└────────────────┬────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────────┐
│  n8n (orchestration layer)                                      │
│  • Routing: which user, which workflow                          │
│  • Credentials: per-user OAuth tokens, encrypted                │
│  • Workflows: email triage, receipts, reminders, calendar, etc. │
│  • Heartbeat: hourly autonomous check-in                        │
└────────────────┬────────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
┌───────▼──────┐  ┌───────▼─────────┐
│  Claude API  │  │  Postgres       │
│  (the brain) │  │  (multi-tenant) │
│  Tool use,   │  │  Row-level      │
│  vision,     │  │  security       │
│  reasoning   │  │  per user       │
└──────────────┘  └─────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
┌───────▼──────┐  ┌───────▼─────┐  ┌───────▼──────┐
│  Gmail API   │  │  Google     │  │  QuickBooks  │
│  (×3 per     │  │  Calendar   │  │  Online      │
│  user)       │  │  + Maps     │  │  (×N per     │
└──────────────┘  └─────────────┘  │  user)       │
                                    └──────────────┘
```

**Why this stack:**
- **n8n** for prototyping speed. We can iterate on workflows in minutes vs. hours of code. We migrate to a custom Node/Python backend in Phase 5+ when SaaS demands it.
- **Postgres** because we need real relational data, RLS for tenant isolation, and JSON columns for flexibility. Hosted on a Canadian VPS for PIPEDA compliance.
- **Telegram** as the interface because it's free, instant, works everywhere, and has the best bot API in the industry. Each user creates their own bot for now (Phase 1–4); we centralize to one bot when we go public.
- **Claude** as the LLM because tool use is mature, vision works for receipts, and the API is reliable. Direct Anthropic API, not OpenRouter — one less middleman.

## Multi-tenancy from day one

Every domain table has `user_id UUID NOT NULL` and a Postgres row-level security policy. Phase 1 hardcodes `user_id` in workflows since it's just you. When partners onboard (within a month), each gets their own UUID and the same workflows route by it without code changes.

**Why this matters:** retrofitting multi-tenancy onto a single-user system is a nightmare. Every query, every workflow, every test breaks. Building it in now costs ~15% extra and saves rewriting everything.

**Free vs paid tier seam:** a `user_plan` column on `users` and a `usage_meters` table that tracks AI calls per user per month. Workflows check the plan before running expensive operations. Day 1 you set yourself to 'unlimited'; partners go on 'beta'; future customers go on 'free' or 'paid'.

## Workspaces (shared resources between trusted users)

Distinct from multi-tenancy. A `workspace` is an opt-in sharing layer where you and your partners can share specific things without leaking personal data:
- Shared Google Drive folder for company receipts
- Shared client list
- Shared expense categories (everyone agrees Tim Hortons = Meals)
- Shared knowledge base (templates, vendor info)

**Default state:** every user has a personal workspace and can be a member of one or more shared workspaces. Personal data (email, calendar, learned preferences, habits) NEVER moves to a workspace. Only explicitly-shared resources do.

## The decision-and-feedback loop (the heart of the product)

Every Claude judgment call follows this pattern:

```
1. Inputs are gathered (email content, sender history, user prefs)
2. Hard rules checked first (triage_rules table)
3. Soft preferences injected into prompt (learned_preferences)
4. Claude makes decision + writes one-sentence reasoning
5. Decision logged to ai_decisions with all inputs
6. Decision surfaces in Telegram with ✅/❌/✏️ buttons
7. User feedback updates rules (immediate) or preferences (weekly distill)
8. Next decision in same domain uses the updated rules/prefs
```

**Why three levels (rules / preferences / distillation):**
- **Hard rules** apply instantly and override Claude. Used for unambiguous facts ("Sarah is wife", "vendor X = category Y").
- **Soft preferences** are nuance Claude reads in the prompt. Used for tendencies that need judgment ("user prefers concise replies").
- **Weekly distillation** prevents preference bloat. Cron job summarizes the week's corrections into ≤20 clean preferences instead of 200 individual notes.

**Domains that learn from feedback:** email triage, receipt categorization, urgency classification, calendar event extraction, sender profiling.

**Domains that DON'T learn:** reply draft style (one-shot edits, no rules), conversational tone (you change your mind too often), receipt vendor extraction (factual, not preferential).

## Urgency: contextual, not rule-based

Claude reads each email and decides urgency from content + context. No hardcoded "urgent if subject contains ASAP" rules — those misfire constantly. Instead:

1. Pull learned preferences for this user's urgency patterns
2. Pull sender profile (relationship, response time history)
3. Send full email + context to Claude with urgency taxonomy
4. Claude returns classification + one-sentence justification
5. Justification is shown in Telegram so user understands the call
6. Wrong calls get corrected → goes to feedback loop

## Urgent nag schedule (clock-based, grouped)

Email-time-based pinging creates chaos when 4 urgent emails arrive throughout the day. Clock-based, grouped pinging is much better:

- Email arrives → immediate Telegram ping
- Every even hour on the hour (8am, 10am, 12pm, 2pm, 4pm, 6pm, 8pm) → check `urgent_queue`, send ONE consolidated ping listing everything still pending
- Silent 10pm–7am, resumes at 7am with morning digest
- Acknowledged when: button tap, bot reply, original email replied to, original email archived in Gmail manually

## Email organization

Standard `AI/*` label hierarchy applied to all 3 Gmail accounts:
- `AI/Urgent` — claude-judged urgent
- `AI/Action` — task embedded
- `AI/Reply-Needed` — they're waiting on you
- `AI/FYI` — informational
- `AI/Newsletter` — promotional/subscription
- `AI/Receipt` — extracted to receipts pipeline (Phase 4+)
- `AI/Calendar` — event proposal
- `AI/Spam-AI` — separate from Gmail's spam, soft-classified

**Auto-archiving in dry-run mode for Phase 1.** Workflow logs what it *would* archive into `archive_decisions`. Daily 7am digest shows you the list. You decide later when to flip the switch to actually archive.

**Reply drafts:** Telegram preview first. Bot shows draft with edit/approve/discard buttons. Approval moves it to Gmail Drafts folder. Nothing is ever auto-sent.

## Receipt and statement flow

**Receipts:**
- Photo to Telegram → Claude vision extracts vendor/date/amount/tax
- Bot asks "Personal, [Business1 name], or [Business2 name]?" via inline buttons
- Routes to correct table + correct QBO company file (for business)
- Stores photo in Google Drive structured path

**Statements:**
- User uploads statement (PDF/photo) to Telegram
- Claude parses transactions
- Cross-references with logged receipts → flags missing ones
- Categorizes uncategorized items
- Produces budget summary + flags potential business expenses on personal cards

**Mileage:**
- When a calendar event is created and tagged business, automatically computes distance via Google Maps Distance Matrix from `home_address` (configurable per user) to event location
- Logged to `mileage_log` keyed to the event and the business
- Monthly CSV export per business for accountant

## Wife (or other "always inform") notification logic

A `away_invitees` table per user. When a calendar event is created during configured "away-trigger" hours (default: evenings + weekends + any business event that crosses dinner) AND `mark_away` is true:
- Adds the configured email(s) as invitees on the event
- They see the full event details (title, location, time)

User can override per-event ("don't add Sarah to this one") via Telegram button when event is being created.

## Admin observability — clustered, not individual

You see usage and decision quality across all users you manage (yourself + partners during beta).

`/admin` Telegram command (only works for users with `is_admin = true`):
- Cluster-wide AI decision quality (correct/wrong/no feedback ratios)
- Cluster-wide most-corrected domains (where the prompts need tuning)
- Cluster-wide feature usage (which workflows fire most)
- Cluster-wide error rates by workflow
- Cluster-wide cost (Claude tokens, Maps API calls, etc.)
- Top 10 worst-performing prompts (lowest correct%) so you know what to fix

**Crucially:** admin sees *aggregate patterns*, not individual users' actual emails or receipts. Privacy preserved by aggregation. The admin dashboard answers "is the email triage prompt working well across my 3 beta users" not "what did Bob get emailed about."

Per-user data is accessible only to that user. Even as cluster admin, you can't read partner emails. You CAN see "Bob marked 8 of last week's urgency calls as wrong" — but not which emails.

## Future scope, designed-around now

Things we're not building yet, but the schema accommodates:

- **Meeting transcription** — `meetings` table exists, empty. Voice flow already in place via Whisper.
- **Call recording** — same.
- **MCP-style skills** — workflows are modular, can become MCP servers later.
- **Mobile app** — webhook contract is stable, app talks to same endpoints Telegram does.
- **Public SaaS** — multi-tenancy + plans + usage_meters already there.
- **Other countries** — `tax_region` field on users, `holidays` partitioned by region, currency on receipts.

## What we're NOT doing (and why)

- **No WhatsApp/SMS reading.** Personal WhatsApp has no API; SMS requires platform-level access. Forward-to-bot is the workaround.
- **No automatic bank/credit card pulling.** Open banking in Canada is too patchy. Statement upload to Telegram is the manual but reliable path.
- **No phone call recording** in Phase 1. Jurisdictional and platform issues. Manual record + send to bot is the path when needed.
- **No general-purpose autonomous agent** (a la OpenClaw). Bounded tools, predictable behavior, debuggable. The boundedness is the product.
- **No shell access for the agent.** Hard architectural boundary. Nothing the agent can do that bypasses n8n's credentialed workflows. This matters for sellable software.

## Phase plan

**Phase 1 (week 1–2): Foundation + email triage**
- Multi-tenant schema + RLS policies
- Telegram bot wiring (your bot, hardcoded user_id)
- Chat agent workflow with first tool set
- Email triage for 3 Gmail accounts
- Urgent nag (clock-based, grouped)
- Daily digest at 7am
- Feedback loop (✅/❌/✏️ buttons + `/rules` command)
- Dry-run archiving (logs only)

**Phase 2 (week 3): Reminders + habits + birthdays**
- Reminder dispatcher
- Habit tracker
- Birthday tracker (build over time)
- Ontario stat holidays seeded

**Phase 3 (week 4): Calendar + mileage + wife logic**
- Google Calendar tools
- Mileage computation + logging
- Away-invitee logic
- Event extraction from emails

**Phase 4 (week 5–6): Receipts + QBO + statements**
- Receipt photo flow
- 2 QBO company integrations
- Statement parsing + reconciliation
- Budget analysis

**Phase 5 (week 7–8): Multi-user + admin observability**
- Onboarding flow for partners
- Per-user credential storage
- Admin dashboard via `/admin` Telegram command
- Workspace shared resources

**Phase 6 (later): Voice journal, weekly review, smart unsubscribe, follow-up tracking, meeting transcription**

**Phase 7 (later, when validated): Custom backend service replacing n8n for hot paths, mobile app, public SaaS launch.**

## What success looks like

- Week 2: you wake up, your phone has a digest in Telegram with 3 urgent items pre-drafted. You tap approve on 2, edit 1. Inbox stays clean.
- Week 4: you snap a receipt at lunch. Bot logs it, asks one clarifying question, done. End of month, your QBO has every business expense categorized.
- Week 8: your partners are using it. You can see in `/admin` that email triage has 94% correct rate cluster-wide. You ship a prompt tweak and watch the rate climb.
- Month 6: you've got 10 paying customers on the free tier and 2 on paid. The product is stable enough that you're not the bottleneck on anyone's day.

That's the bet.
