import { listAccounts } from "../../db/accounts";
import { listCategories } from "../../db/categories";
import { listRecurringPatterns } from "../../db/recurringPatterns";
import { listOccurrences, resolveOccurrenceAmountCents } from "../../envelopes/occurrences";
import type { RecurringPattern, SeriesOccurrence } from "../../types";
import { centsToDollars } from "../cells";
import type { CellValue } from "../client";
import type { RenderedRow, SyncContext, TabSpec } from "../layout";

/**
 * A weekly cash-flow forecast, read-only, rebuilt on every sync.
 *
 * For each of the next WEEKS weeks (Monday–Sunday, starting with this one):
 *
 *   Beginning cash + Income − Bills − Avg spending = Ending cash
 *
 *  - Beginning cash for this week is cash on hand now: checking + savings
 *    balances minus what's owed on credit cards (the same model Ready to
 *    Assign uses — cards are paid in full, so card spending already
 *    happened). Each later week begins where the last one ended.
 *  - Income and Bills are the confirmed recurring series' occurrences due
 *    that week (src/envelopes/occurrences.ts), with this month's overrides
 *    and skips applied. Ones already matched to a charge are in the
 *    balance already and are left out; ones up to 3 days overdue and still
 *    unmatched land in this week (older ones are assumed handled).
 *  - Avg spending is everything else the household spent per week over
 *    the last LOOKBACK_WEEKS weeks — not bills, transfers, income or
 *    excluded charges. This week gets only the days that are left.
 */

export const CASH_FLOW_WEEKS = 13;
const LOOKBACK_WEEKS = 12;

interface ForecastItem {
  date: string;
  name: string;
  kind: "income" | "expense";
  cents: number | null;
}

export interface CashFlowForecast {
  asOf: string;
  cashOnHandCents: number;
  avgWeeklySpendCents: number;
  weeks: Array<{
    start: string;
    end: string;
    beginningCents: number;
    incomeCents: number;
    billsCents: number;
    spendingCents: number;
    endingCents: number;
    items: ForecastItem[];
  }>;
}

// Banks post a few days late; past that, an unmatched occurrence is assumed
// paid some other way or skipped rather than still on its way.
const OVERDUE_DAYS = 3;

// The meta row and the table are rendered separately in one pass; build the
// forecast once per pass.
const cache = new WeakMap<SyncContext, Promise<CashFlowForecast>>();

export function buildCashFlowForecast(ctx: SyncContext): Promise<CashFlowForecast> {
  let pending = cache.get(ctx);
  if (!pending) {
    pending = computeForecast(ctx);
    cache.set(ctx, pending);
  }
  return pending;
}

async function computeForecast(ctx: SyncContext): Promise<CashFlowForecast> {
  const today = ctx.today;
  const weekStart = mondayOf(today);
  const horizonEnd = addDays(weekStart, CASH_FLOW_WEEKS * 7 - 1);

  const [accounts, categories, patterns] = await Promise.all([
    listAccounts(ctx.env.DB, ctx.householdId),
    listCategories(ctx.env.DB, ctx.householdId),
    listRecurringPatterns(ctx.env.DB, ctx.householdId),
  ]);
  const kindByCategory = new Map(categories.map((c) => [c.id, c.kind]));

  // Cash on hand.
  let cashOnHandCents = 0;
  for (const a of accounts) {
    if (a.status === "removed" || a.current_balance_cents === null) continue;
    if (a.type === "depository_checking" || a.type === "depository_savings") cashOnHandCents += a.current_balance_cents;
    else if (a.type === "credit_card") cashOnHandCents -= a.current_balance_cents;
  }

  // Recurring income and bills due in the horizon. A card payment or
  // account transfer series would double-count against the card balances
  // already netted out above, so transfer-kind series are skipped.
  const patternById = new Map(patterns.map((p) => [p.id, p]));
  const overdueCutoff = addDays(today, -OVERDUE_DAYS);
  const occurrences: SeriesOccurrence[] = [];
  for (const month of monthsBetween(overdueCutoff.slice(0, 7), horizonEnd.slice(0, 7))) {
    occurrences.push(...(await listOccurrences(ctx.env.DB, ctx.householdId, month)));
  }

  const items: ForecastItem[] = [];
  const seen = new Set<string>();
  for (const o of occurrences) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    if (o.status !== "upcoming") continue;
    const pattern = patternById.get(o.pattern_id);
    if (!pattern || isTransferSeries(pattern, kindByCategory)) continue;
    if (o.due_date > horizonEnd || o.due_date < overdueCutoff) continue;
    items.push({
      date: o.due_date < today ? today : o.due_date,
      name: pattern.merchant_pattern,
      kind: pattern.kind,
      cents: resolveOccurrenceAmountCents(o, pattern),
    });
  }

  const avgWeeklySpendCents = await averageWeeklySpendCents(ctx, today, kindByCategory);

  const weeks: CashFlowForecast["weeks"] = [];
  let running = cashOnHandCents;
  for (let w = 0; w < CASH_FLOW_WEEKS; w++) {
    const start = addDays(weekStart, w * 7);
    const end = addDays(start, 6);
    const inWeek = items.filter((i) => i.date >= start && i.date <= end).sort((a, b) => a.date.localeCompare(b.date));
    const incomeCents = inWeek.filter((i) => i.kind === "income").reduce((s, i) => s + Math.abs(i.cents ?? 0), 0);
    const billsCents = inWeek.filter((i) => i.kind === "expense").reduce((s, i) => s + Math.abs(i.cents ?? 0), 0);
    // This week: only the days still ahead, today included.
    const daysLeft = w === 0 ? daysBetween(today, end) + 1 : 7;
    const spendingCents = Math.round((avgWeeklySpendCents * daysLeft) / 7);
    const beginningCents = running;
    const endingCents = beginningCents + incomeCents - billsCents - spendingCents;
    weeks.push({ start, end, beginningCents, incomeCents, billsCents, spendingCents, endingCents, items: inWeek });
    running = endingCents;
  }

  return { asOf: today, cashOnHandCents, avgWeeklySpendCents, weeks };
}

function isTransferSeries(pattern: RecurringPattern, kindByCategory: Map<string, string>): boolean {
  return pattern.category_id !== null && kindByCategory.get(pattern.category_id) === "transfer";
}

/** Day-to-day spending per week: outflows net of refunds over the last
 * LOOKBACK_WEEKS full weeks, leaving out anything a bill forecast already
 * covers (charges matched to a series occurrence), transfers, income,
 * excluded charges and split parents (their parts are counted instead). */
async function averageWeeklySpendCents(ctx: SyncContext, today: string, kindByCategory: Map<string, string>): Promise<number> {
  const to = addDays(mondayOf(today), -1);
  const from = addDays(to, -(LOOKBACK_WEEKS * 7) + 1);
  const { results } = await ctx.env.DB.prepare(
    `SELECT t.amount_cents, t.category_id FROM "transaction" t
       WHERE t.household_id = ? AND t.posted_at >= ? AND t.posted_at <= ?
         AND t.is_transfer = 0 AND t.excluded_from_budget = 0
         AND NOT EXISTS (SELECT 1 FROM series_occurrence o WHERE o.matched_transaction_id = t.id)`,
  )
    .bind(ctx.householdId, from, `${to}T23:59:59`)
    .all<{ amount_cents: number; category_id: string | null }>();

  let netOut = 0;
  for (const row of results) {
    const kind = row.category_id ? kindByCategory.get(row.category_id) : undefined;
    if (kind === "income" || kind === "transfer") continue;
    // Uncategorized money in is more likely income than a refund; leave it out.
    if (!row.category_id && row.amount_cents > 0) continue;
    netOut -= row.amount_cents;
  }
  return Math.max(0, Math.round(netOut / LOOKBACK_WEEKS));
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export const cashFlowTab: TabSpec = {
  name: "Cash Flow",
  headerRow: 2,
  allowsCreate: false,
  columns: [
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "week", header: "Week", type: "text", editable: false, width: 130 },
    { key: "beginning", header: "Beginning cash", type: "money", editable: false, width: 120 },
    { key: "income", header: "Income", type: "money", editable: false, width: 110, note: "Recurring paychecks and income due this week (Bills tab, kind = income)." },
    { key: "bills", header: "Bills", type: "money", editable: false, width: 110, note: "Recurring bills due this week, with this month's changes and skips (Bills This Month)." },
    {
      key: "spending",
      header: "Avg spending",
      type: "money",
      editable: false,
      width: 120,
      note: "Your average non-bill spending per week over the last 12 weeks. This week counts only the days left.",
    },
    { key: "net", header: "Net", type: "money", editable: false, width: 110 },
    { key: "ending", header: "Ending cash", type: "money", editable: false, width: 120 },
    { key: "detail", header: "What's due", type: "text", editable: false, width: 420 },
  ],

  meta: {
    async render(ctx) {
      const f = await buildCashFlowForecast(ctx);
      const row: CellValue[] = [
        "",
        `As of ${f.asOf}`,
        "Cash on hand",
        centsToDollars(f.cashOnHandCents),
        "Avg spending / week",
        centsToDollars(f.avgWeeklySpendCents),
        "",
        "",
        "Cash on hand = checking + savings − credit card balances. Read-only; updates every 5 minutes.",
      ];
      return row;
    },
    editable: [],
    async apply() {},
  },

  async render(ctx) {
    const f = await buildCashFlowForecast(ctx);
    return f.weeks.map(
      (w): RenderedRow => ({
        id: w.start,
        cells: {
          id: w.start,
          week: `${shortDate(w.start)} – ${shortDate(w.end)}`,
          beginning: centsToDollars(w.beginningCents),
          income: centsToDollars(w.incomeCents),
          bills: centsToDollars(w.billsCents),
          spending: centsToDollars(w.spendingCents),
          net: centsToDollars(w.endingCents - w.beginningCents),
          ending: centsToDollars(w.endingCents),
          detail: w.items
            .map((i) => `${shortDate(i.date)} ${i.kind === "income" ? "+" : "−"}${i.name}${i.cents === null ? " (amount unknown)" : ` $${(Math.abs(i.cents) / 100).toFixed(0)}`}`)
            .join(", "),
        },
      }),
    );
  },
};

// ---------------------------------------------------------------------------
// Dates ('YYYY-MM-DD', UTC arithmetic so time zones can't shift a day)
// ---------------------------------------------------------------------------

function toUtc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function mondayOf(date: string): string {
  const dow = new Date(toUtc(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}` <= to) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return out;
}

function shortDate(date: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}
