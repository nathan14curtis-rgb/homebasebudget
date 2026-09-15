# Spending Plan editing — parity with Quicken Simplifi

> **Superseded in part.** This plan assumed one page holding all four
> sections — income, bills, planned and other spend. The Spending Plan is
> now everyday, non-recurring spending only; income and bills moved to the
> Bills & Income calendar (`dashboard/src/components/BillsIncomePage.tsx`),
> where a series is a tile on the day it is due rather than a row in a
> list. What the two pages share still holds and is still worth reading
> here: series and their projected occurrences, the one-month override, the
> included/excluded split, and the single transaction detail modal. What
> does not: anything below describing Income or Bills *sections* of the
> Spending Plan, and the per-row `⋮` menu's series actions, which are now
> the calendar tile's dialog.

Living plan for expanding what can be edited from the Spending Plan page
(`dashboard/src/components/EnvelopesPage.tsx`). Written so the work can be
picked up mid-flight: each phase is independently shippable, lands as its
own commit, and the checkboxes below are the source of truth for what is
already done. **Update the checkboxes in the same commit as the work.**

## Target behavior (from Simplifi)

Every row in the Spending Plan — income deposits, bills, planned and other
spend — is a first-class, editable object, not a read-only line:

- A `⋮` row menu: unlink from series, edit transaction, exclude from the
  Spending Plan, view series.
- Each section splits into **Included this month** and a collapsible
  **Excluded this month (N)**; excluding a row moves it between the two
  and re-runs the section total immediately.
- Rows carry a **date chip**, a **status badge** (Received / Upcoming /
  Pending / Paid), the category name, and a **linked-to-series** icon.
- **Upcoming occurrences are projected**: a paycheck due on the 20th shows
  as an `Upcoming` row on the 4th, before any transaction exists, and
  converts to `Received` when the real transaction posts.
- Clicking a row opens a **transaction detail modal**: payee, date, amount,
  account, status, category, tags, split, note, flag, reviewed, the linked
  series card, exclude-from-plan, create rule, delete.

## What already exists (do not rebuild)

| Capability | Where |
| --- | --- |
| Exclude / flag / verify / split / edit-amount / recategorize / delete | `src/routes/transactions.ts`, `src/db/transactions.ts` |
| `memo`, `pending`, `flag_color`, `verified_by_user_id`, `excluded_from_budget`, `split_parent_id` columns | `migrations/0001`, `0007` |
| Recurring series (merchant + schedule + category) with monthly / semimonthly / weekly shapes | `recurring_pattern`, `src/db/recurringPatterns.ts` |
| Series edit modal (merchant re-link + schedule) | `EditEnvelopeModal` in `EnvelopesPage.tsx` |
| Envelope `⋮` menu (release rollover, edit target, change rollover, rename, archive) | `EnvelopeRow` in `EnvelopesPage.tsx` |
| Inline row editing (category + amount) | `TransactionsPage.tsx` |

Gaps: income and other-spend rows are read-only; nothing is grouped
included/excluded; there is no status badge, no projection of future
occurrences, no tags, no per-occurrence override, and no shared detail
modal.

## Phases

### Phase 1 — Data model (migration `0010`)

- [x] `tag` table: `id`, `household_id`, `name`, `color`, `created_at`;
      unique on `(household_id, name)`.
- [x] `transaction_tag` join table: `transaction_id`, `tag_id`, PK on both.
- [x] `series_occurrence` table — one row per projected occurrence of a
      confirmed `recurring_pattern`, materialized so a single occurrence can
      be edited or skipped without touching the series:
      `id`, `household_id`, `pattern_id`, `month` (`YYYY-MM`),
      `scheduled_date` (what the schedule produced, never edited — what
      regeneration keys off, so a moved occurrence isn't refilled with a
      duplicate), `due_date`,
      `amount_cents` (projected; nullable → fall back to the series
      average), `amount_override_cents` (this month only), `status`
      (`upcoming` | `matched` | `skipped`), `matched_transaction_id`
      (nullable FK), `unlinked_transaction_id` (a pair a person pulled
      apart by hand, so reconcile doesn't put it back), `created_at`,
      `updated_at`. Unique on `(pattern_id, scheduled_date)` so
      regeneration is idempotent.
- [x] `recurring_pattern`: add `expected_amount_cents` (the series' default
      amount, seeded from the median of matched history) and `ended_at`
      (so a series can be ended without being dismissed).
- [x] Types in `src/types.ts` + `dashboard/src/api.ts` kept in step.

### Phase 2 — Projection engine (`src/envelopes/occurrences.ts`)

- [x] `generateOccurrences(db, householdId, month)` — walk every confirmed,
      un-ended pattern, expand its schedule across the month (monthly → one
      date; semimonthly → two; weekly → every matching weekday), and upsert
      a `series_occurrence` per due date. Idempotent: re-running never
      duplicates, never clobbers an override or a `skipped` status.
- [x] `reconcileOccurrences(db, householdId, month)` — match posted
      transactions to occurrences (same category, nearest due date within
      `day_tolerance`, unmatched-first), setting `status = 'matched'` and
      `matched_transaction_id`. Runs after Plaid sync (`src/plaid/sync.ts`)
      and on demand.
- [x] Amount resolution order: `amount_override_cents` →
      `series_occurrence.amount_cents` → `pattern.expected_amount_cents` →
      median of the last 3 matched transactions.
- [x] Unit tests in `test/seriesOccurrences.test.ts` for: month boundaries (a 31st-day bill in
      February), semimonthly and weekly expansion, idempotent regeneration,
      matching preferring the nearest unmatched occurrence, and skip
      surviving regeneration.

### Phase 3 — API surface

- [x] `GET /households/:householdId/occurrences?month=YYYY-MM` — generate,
      reconcile, and return occurrences joined to their pattern, category,
      and matched transaction. This is what the Spending Plan reads.
- [x] `PATCH .../occurrences/:occurrenceId` — `amountOverrideCents`,
      `dueDate`, `status` (to skip / un-skip).
- [x] `POST .../occurrences/:occurrenceId/unlink` — detach the matched
      transaction, returning the occurrence to `upcoming`.
- [x] `PATCH .../recurring-patterns/:patternId` — extend the existing route
      with `expectedAmountCents`, `categoryId`, and `endedAt` (end series).
- [x] Tags: `GET/POST .../tags`, `PATCH/DELETE .../tags/:tagId`,
      `PUT .../transactions/:transactionId/tags` (replace the set).
- [x] `PATCH .../transactions/:transactionId` — one consolidated edit
      covering payee, date, amount, account, category, memo, pending,
      excluded, flag. Today's `/edit` and `/categorize` stay for callers
      that use them.
- [x] `DELETE .../transactions/:transactionId` — the modal's Delete, which
      takes split children with it.
- [x] Reconciliation runs after a Plaid sync (`src/plaid/sync.ts`), so a
      posted paycheck flips its occurrence to Received without waiting for
      someone to open the page.

### Phase 4 — Shared transaction detail modal

- [x] Extract `dashboard/src/components/TransactionDetailModal.tsx`: payee,
      date, amount, account, status, category, tags, split, note, flag,
      reviewed, exclude-from-plan, linked-series card (with unlink / view
      series / edit series), Create Rule, Delete.
- [x] `TransactionsPage.tsx` pencil opens it (replacing inline editing).
- [ ] Every Spending Plan row opens the same component, so a fix lands once.
- [x] Works for an unmatched projected occurrence too: the same modal in a
      reduced form (amount override, due date, skip), since there is no
      transaction to edit yet.

### Phase 5 — Spending Plan rows

- [x] `PlanRow` — one row component for income, bills, and spend: title,
      date chip, status badge (Received / Upcoming / Pending / Paid),
      category, series icon, amount, `⋮`.
- [x] Row `⋮`: Edit transaction, Unlink transaction, Exclude from Spending
      Plan, View series, Skip this occurrence.
- [x] Included / Excluded split per section, with the excluded group
      collapsed and counted (`Excluded this month (N)`).
- [x] Section totals count included rows only, and include `Upcoming`
      projections so the plan reads forward, not just backward.
- [x] Income section renders projected paychecks alongside received ones.
- [x] Bills and Planned spend get the same rows through the envelope
      drilldown, which replaced its category-move dropdown with `PlanRow`.

### Phase 6 — Series management

- [x] Series detail view: schedule, expected amount, category, every
      occurrence this month and the next few, matched-history list.
- [x] End series / resume series (distinct from dismissing a suggestion —
      matched history stays on the plan, only future projection stops).
- [x] Edit series propagates to future `upcoming` occurrences only —
      never rewrites matched history or an existing override.

All six phases are implemented. What is deliberately not here: Simplifi's
"Create sales receipt" (a QuickBooks integration with no counterpart in
this app) and "Clients & Projects" (business-accounting fields for a
household budget). "Create Rule" from the detail modal is the one piece of
Simplifi's dialog still to wire up — `src/routes/rules.ts` already has the
write path.

## Conventions

- Cents everywhere; never floats for money.
- Every new table is `household_id`-scoped and read through the scoped
  helpers in `src/db/client.ts`.
- Migrations are additive; a deployment that has not applied `0010` must
  degrade gracefully (the page already does this for `recurring_pattern` —
  see `refreshPatterns`'s catch and `describeRecurringPatternError`).
- `npm run typecheck && npm test` before every commit.
