# Home Base

Self-owned budgeting app on Cloudflare Workers, fed by Plaid, with a
conversational iMessage bot: ask it anything about your money in plain
English, and tell it what to change — categories, monthly targets, goals,
what a charge really was — and it writes the change. Full design in
[`docs/PLAN.md`](docs/PLAN.md).

## How the bot works

**It pulls hourly.** Every hour, `/transactions/sync` runs for every linked
Plaid item (`0 * * * *` in `wrangler.jsonc`). Plaid's webhook still fires a
sync the moment a charge lands; the hourly pass is the floor that makes a
dropped webhook cost an hour instead of a day.

**It only brings up the period it just looked at.** Two windows, and
nothing else is raised unprompted:

| What | Window | Message |
| --- | --- | --- |
| Charges it couldn't categorize | the last hour | one batched text per hour: "2 new charges I couldn't place…" (`src/messaging/hourlyCheckin.ts`) |
| Charges it filed automatically | the last 24 hours | the morning digest at 13:00 UTC (`src/messaging/dailyDigest.ts`) |

Anything older stays in the dashboard's review queue rather than becoming a
text about a charge nobody remembers. Overnight, quiet hours defer the
whole batch to the morning instead of sending at 2am.

**Every reply is a conversation, not a command.** There is no `fix
<merchant>` syntax and no separate Q&A mode. An inbound text becomes one
turn of an ongoing thread (`src/messaging/agent.ts`), answered by Claude
with tools that read and write the household's real data
(`src/messaging/agentTools.ts`):

- *"the costco run was groceries, the other one was a gift"* → both filed,
  the merchant learned, confirmation texted back
- *"how much is left on dining?"* / *"where did the money go in June?"* →
  read from the actual ledger, never estimated
- *"bump groceries to $900"*, *"move $50 from dining to gas"*, *"start a
  $4,000 vacation fund by next June"*, *"always file Maverik as gas"* →
  written, then confirmed with the number that matters now

**The whole budget is writable by text**, not a slice of it — anything the
dashboard can do, a message can:

| Say | What happens |
| --- | --- |
| *"make groceries $250 this month, nothing rolled over"* | this month's funding is set to exactly $250 and the opening balance is corrected in the prior month — the monthly target for every *other* month is left alone (`set_month_budget`) |
| *"groceries should be $250 from now on"* | the envelope's monthly target changes (`update_spending_plan`) |
| *"groceries should start fresh every month"* | the envelope switches to `rollover: reset`, and each new month's leftover is zeroed with a visible correction entry |
| *"set up October the usual way"* | every envelope with a target is funded up to it in one pass (`fund_month_from_plan`) |
| *"what have we actually been spending?"* → *"okay, use those"* | per-category monthly averages, then a bulk retarget (`suggest_budget_from_history`, `set_targets_in_bulk`) |
| *"add my $95 internet bill on the 5th"* / *"the power bill is $240 this month"* | a recurring series, or just this month's occurrence of one — the distinction is kept (`create_recurring_series`, `update_bill_occurrence`) |
| *"the Costco run was $120 groceries and $60 household"* | the charge is split across categories (`split_transaction`) |
| *"tag that reimbursable"*, *"call it Trader Joe's"*, *"that was $48.20 not $42.80"* | tags, payee, amount, date, memo, flags (`tag_transaction`, `update_transaction`) |
| *"undo that"* / *"put the grocery change from Tuesday back"* | every write is logged with a before-image and reversed by id (`list_recent_changes`, `undo_change`) |

Two guardrails sit under all of it. Anything that throws part of the plan
away — archiving, merging, ending or deleting a series — is only performed
after the person agrees in the thread, and a household member's
`access_level` decides what they can do by text: `view_only` can ask
anything and change nothing, `limited` can categorize and tag but not
re-plan, `full` does everything.

Both sides of every exchange are stored, so follow-ups work ("what about
last month?"). The same agent and the same thread are available in the
dashboard under **Ask the bot**, and over the API at
`POST /api/households/:householdId/chat`.

Thank you for using! Please email nathan14curtis@gmail.com with suggestions for UX changes and improvements.

## Setup

```
npm install
```

### Local development

```
npx wrangler d1 migrations apply curtisclan --local   # creates the local SQLite DB
npm run dev                                             # wrangler dev, http://localhost:8787
```

`npm run dev` builds `dashboard/dist` for you automatically (via
`wrangler.jsonc`'s `build.command`) before starting the dev server.
`GET /health` confirms the Worker is up; `/` serves the dashboard. From
the terminal instead:

```
curl -X POST localhost:8787/api/households -H 'content-type: application/json' \
  -d '{"name":"Curtis Clan"}'
# → seeds the default category taxonomy + one envelope per expense/savings category
```

Webhook/queue/LLM code paths need their secrets (below) to do anything —
without them they fail cleanly with a "missing required secret" error
rather than doing nothing silently.

**Working on the dashboard itself**: `npm --prefix dashboard run dev`
starts Vite's dev server with hot reload, proxying `/api/*` to a
`wrangler dev` you run separately on port 8787 (see `dashboard/vite.config.ts`).
`npm run build:dashboard` from the repo root rebuilds `dashboard/dist` for
`wrangler dev`/`deploy` to pick up — Vite doesn't watch it for you there.

### Tests / typecheck

```
npm test          # vitest run — pure logic + D1-backed tests via miniflare
npm run typecheck # tsc --noEmit
```

## Getting your API credentials

You need four things before this app can do anything real: a Cloudflare
account (to run the Worker), a Plaid developer account (to pull bank
transactions), a Sendblue account (to text you), and an Anthropic API key
(to categorize). Sandbox/trial tiers exist for the first two and cost
nothing until you flip to production.

### 1. Cloudflare account + Wrangler login

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   (a free account is enough — Workers has a generous free tier, though
   the two queues below need **Workers Paid**, $5/mo, per PLAN.md §11).
2. Log Wrangler (already installed as a dev dependency — no separate
   install needed) into that account from the repo root:
   ```
   npx wrangler login
   ```
   This opens a browser tab to authorize the CLI; approve it and the
   terminal picks up the session automatically. Confirm it worked with:
   ```
   npx wrangler whoami
   ```
   If you manage multiple Cloudflare accounts, `wrangler login` will ask
   which one to use, or set `CLOUDFLARE_ACCOUNT_ID` in your shell first.

### 2. Plaid trial API keys

1. Sign up at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup).
   Every new account starts with free, unlimited **Sandbox** access — no
   sales call or approval needed for that tier.
2. In the Plaid dashboard, go to **Team Settings → Keys**. Copy the
   `client_id` and the **Sandbox** `secret` — these are `PLAID_CLIENT_ID`
   and `PLAID_SECRET` below.
3. Leave `PLAID_ENV` set to `sandbox` and use Plaid's fake test
   institution/credentials (`user_good` / `pass_good` at "Platypus Bank"
   in Link) to exercise the whole flow end to end before touching a real
   account — see PLAN.md §4.0 for why: the 10-Item cap on real
   (production) accounts doesn't refund when you remove one.
4. When you're ready for real accounts, Plaid requires a short
   **Production access** application (a form describing your use case) —
   submit it from the same dashboard under **Compliance/Production
   Access**. Approval is typically same-day for a personal-use app like
   this one. Once approved, generate a **Development** or **Production**
   `secret` from the same Keys page and swap `PLAID_SECRET`/`PLAID_ENV`.

### 3. Sendblue trial API keys

1. Sign up at [sendblue.com](https://sendblue.com) and create a workspace.
   New accounts get a trial/sandbox number and a small free message
   allowance before you need to add a card.
2. In the Sendblue dashboard, open **API Keys** (sometimes listed under
   **Settings → Developers**) and copy the **API Key ID** and **API
   Secret Key** — these are `SENDBLUE_API_KEY_ID` and
   `SENDBLUE_API_SECRET_KEY` below.
3. Note the phone number Sendblue assigned your account (dashboard
   **Numbers**) — that's `SENDBLUE_FROM_NUMBER`.
4. You'll set `SENDBLUE_SIGNING_SECRET` in step 5 of "Deploying for real"
   below, once you create the webhook and Sendblue gives you a secret for
   it.
5. **Contact verification** (PLAN.md §5.0): on Sendblue's free/shared-line
   plan, each phone number you want to text must first text *your*
   Sendblue number once, or the API can't message it first. Do that for
   every household member before calling `verify-phone` (README
   "Register webhooks" below covers the rest of that flow).

### 4. Anthropic API key

Sign up at [console.anthropic.com](https://console.anthropic.com), create
an API key under **Settings → API Keys**, and add a small amount of
credit — that's `ANTHROPIC_API_KEY` below. Usage here is tiny (one Haiku
call per uncategorized transaction, occasionally escalating to Sonnet).

## Deploying for real

1. **Create the D1 database and apply migrations:**
   ```
   npx wrangler d1 create curtisclan   # paste the returned database_id into wrangler.jsonc
   npx wrangler d1 migrations apply curtisclan --remote
   ```
2. **Create the two queues**
   ```
   npx wrangler queues create curtisclan-transactions
   npx wrangler queues create curtisclan-messages
   ```
3. **Set secrets**, from the repo root, using the credentials gathered
   above. `wrangler secret put <NAME>` prompts for the value interactively
   (it isn't echoed and isn't saved in shell history) and stores it
   encrypted server-side — never in `wrangler.jsonc` or source (PLAN.md
   §10):
   ```
   # 32 random bytes, base64-encoded — encrypts Plaid access tokens at rest
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY

   npx wrangler secret put PLAID_CLIENT_ID
   npx wrangler secret put PLAID_SECRET
   npx wrangler secret put PLAID_ENV        # "sandbox" while testing Link end to end (PLAN.md §4.0),
                                             # "production" once you switch to real Chase/Discover/Amex accounts

   npx wrangler secret put SENDBLUE_API_KEY_ID
   npx wrangler secret put SENDBLUE_API_SECRET_KEY
   npx wrangler secret put SENDBLUE_FROM_NUMBER      # your Sendblue-assigned number — required by their API on every send
   npx wrangler secret put SENDBLUE_SIGNING_SECRET   # set when you create the Sendblue webhook, step 5 below

   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   List what's set (names only, never values) at any point with
   `npx wrangler secret list`; overwrite one later by running
   `secret put` again with the same name.
4. **Deploy:**
   ```
   npm run deploy
   ```
   `wrangler.jsonc`'s `build.command` (`npm run build:dashboard`) runs
   automatically as part of `wrangler dev`/`wrangler deploy` — including
   inside Cloudflare's **Workers Builds** Git integration, since that also
   just runs `wrangler deploy` under the hood. No separate "Build command"
   setting needed in the Cloudflare dashboard.
5. **Register webhooks** against your deployed Worker URL:
   - **Plaid**: nothing to register up front — `POST /:householdId/plaid/link-token`
     sets the webhook URL per-item automatically to
     `https://<your-worker>.workers.dev/webhooks/plaid/<householdId>`, scoped
     to the household that started the Link flow.
   - **Sendblue**: in the Sendblue dashboard (or via their webhooks API),
     point your webhook at `https://<your-worker>.workers.dev/webhooks/sendblue`
     and set its signing secret to the same value you put in
     `SENDBLUE_SIGNING_SECRET` above.
   - **Sendblue contact verification** (PLAN.md §5.0): on the free
     shared-line plan, each phone number must text your Sendblue number
     once before the app can message it first. Do that, then call
     `POST /:householdId/users/:userId/verify-phone` with `{"phoneE164": "+1..."}`
     to bind the number — this is the only thing authenticating an
     inbound reply (§10), so nothing sends to or trusts a number that
     hasn't gone through this. **Verify both spouses before the first
     clarification fires**: the group chat is created once, from whoever
     is verified at that moment (`src/messaging/groupChat.ts`) — someone
     verified later isn't automatically added to an already-created group
     (Sendblue has a `/modify-group` endpoint for this; not wired up yet,
     see below).
6. **Build and link accounts against Plaid Sandbox first** (PLAN.md §4.0):
   the 10-Item cap on real accounts doesn't refund on `/item/remove` — get
   the Link flow working end to end in Sandbox, then switch
   `PLAID_ENV` to `production` and link your real Chase/Discover/Amex
   accounts deliberately.

### When the texting bot doesn't respond

Every way the inbound loop can break is silent from the phone's side — the
text just does nothing. Start here rather than guessing:

```
GET /api/households/<householdId>/messaging/diagnostics
```

It reports, from stored state, which secrets the deployed Worker actually
has, who is verified, and the last 20 texts Sendblue delivered. Read it
top-down:

- **`config.sendblueSigningSecretSet` is false** — the webhook rejects
  every delivery with a 503. Run
  `npx wrangler secret put SENDBLUE_SIGNING_SECRET` and set the same value
  on the Sendblue webhook.
- **`inbound` is empty** — Sendblue never reached the Worker at all.
  Nothing downstream can be at fault. Check the webhook URL in the
  Sendblue dashboard against `config.webhookUrlToConfigureInSendblue`,
  and check that its signing secret matches the deployed one (a mismatch
  logs `[sendblueWebhook] rejected` and returns 401).
- **`unmatchedNumbers` lists the number you texted from** — the webhook
  fired and the text was recorded, but no *verified* user owns that
  number, so it was deliberately never processed (§10: an unverified
  number must not elicit a response). Bind it with
  `POST /api/households/<householdId>/users/<userId>/verify-phone`.
- **`unprocessed` is non-zero** — the text was queued but never finished.
  Check the Worker logs for `[queue] resolve_reply`.
- **`config.anthropicApiKeySet` is false** — replies are received but
  nothing can answer them; the bot texts back saying so. The conversational
  agent is the whole inbound path, so without this key the bot can only
  acknowledge texts.

Worker logs (Cloudflare dashboard → Workers → curtisclan → Logs) carry a
`[sendblueWebhook]` line naming the reason for every single drop, and a
`[inboundReply]` / `[queue] resolve_reply` line for everything after it.
Each turn also logs one `[agent]` line per tool it ran (and what failed),
which is the fastest way to see why the bot answered the way it did.
Outbound asks log `[hourly_checkin]`.

### If you put the Worker behind Cloudflare Access

The app's own session auth (`src/lib/authMiddleware.ts`) already only
guards `/api/households/:householdId/*` — `/webhooks/plaid/*` and
`/webhooks/sendblue` are top-level routes that skip it entirely (see
`src/index.ts`), since Plaid and Sendblue can't complete a login. That's
enough on its own; you do **not** need Cloudflare Access for the app to
work.

The one time this matters is if you additionally put the whole
`*.workers.dev` URL (or a custom domain routed to it) behind **Cloudflare
Zero Trust / Access** — e.g. to require Google/GitHub SSO before anyone
can even reach the dashboard's login page. In that case Access intercepts
every request *before* it reaches the Worker, including Plaid's and
Sendblue's webhook calls, and they'll fail (Plaid retries and eventually
disables the webhook; Sendblue just drops the delivery). Give the webhook
paths a bypass policy so Access lets them straight through:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications**
   and open the application covering your Worker's domain (or create one
   if you haven't yet — **Add an application → Self-hosted**, pointing at
   your Worker's hostname).
2. Add a second application (or a second policy on the existing one)
   scoped to the path `/webhooks/*` under that same hostname.
3. Set that policy's action to **Bypass** (not Allow — Bypass skips the
   Access authentication check entirely, which is what an unauthenticated
   webhook call needs) with an "Everyone" include rule, since Plaid/Sendblue
   can't present any Access identity.
4. Make sure this `/webhooks/*` policy is evaluated *before* (i.e. is more
   specific than) whatever broader policy protects the rest of the site —
   Access applies the most specific matching path.
5. From the terminal, confirm the bypass actually works once deployed:
   ```
   curl -i https://<your-domain>/webhooks/sendblue
   ```
   This should reach the Worker (a 4xx from `sendblueWebhookRoute` itself,
   e.g. "missing signature") rather than an Access login redirect/HTML
   page. If you see an Access login page instead, the bypass policy isn't
   matching yet.

## Project layout

```
migrations/             D1 schema (wrangler d1 migrations)
dashboard/               Vite/React SPA, built to dashboard/dist and served as Workers Assets (see wrangler.jsonc)
  src/calendar.ts          Pure date + cash-projection math behind the Bills & Income calendar
  src/useRecurring.ts      The household's recurring series, held once for the pages that share them
  src/components/          One file per page, plus the dialog, schedule fields and row primitives they share
src/
  types.ts              Domain types mirroring the schema
  lib/                  Framework-free helpers: money, ids, crypto, CSV, merchant normalization, secrets
  db/                   Household-scoped D1 access — the only code that writes SQL
  import/               Pure CSV-row parsing (no DB)
  envelopes/             Pure envelope-balance arithmetic
  categorization/        Rules engine, merchant-memory matcher, confidence gate, cascade, Claude classifier
  plaid/                 Plaid REST client, webhook JWT verification, /transactions/sync orchestration
  sendblue/               Sendblue REST client + webhook payload types
  messaging/              The conversational agent + its read/write tools, household group chat,
                          quiet hours, the hourly ask, and the daily digest
  queue/                  The one queue() consumer, branching on which queue a batch came from
  routes/                 Hono route handlers, one file per resource, plus the two webhook routes
  index.ts                Worker entrypoint: fetch + queue + scheduled
test/                    Mirrors src/ — pure-logic tests, D1-integration tests against real migrated D1,
                          and LLM-calling code tested against a fake Anthropic client
docs/PLAN.md             The full design document this build implements
```
