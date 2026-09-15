import type { Account, Category, Envelope, RecurringPattern, SeriesOccurrence } from "./api";

/**
 * Date and projection math for the Bills & Income calendar.
 *
 * Kept out of the component because it is the part worth being sure
 * about: everything here is pure, works on bare 'YYYY-MM-DD' strings in
 * UTC (so no timezone can shift a bill onto the wrong square), and is
 * covered by test/calendar.test.ts.
 */

export const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

export function isoDate(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 0 (Sunday) .. 6 (Saturday) for the 1st of the month. */
export function firstWeekdayOfMonth(month: string): number {
  return new Date(`${month}-01T00:00:00Z`).getUTCDay();
}

export function addMonths(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const monthIndex0 = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(year, monthIndex0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Every month from `from` through `to`, inclusive, capped so a wild
 * click on "next month" can never fan out into an unbounded number of
 * requests. */
export function monthsBetween(from: string, to: string, cap = 14): string[] {
  const months: string[] = [];
  let cursor = from;
  while (cursor <= to && months.length < cap) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export interface CalendarDay {
  date: string | null; // null for the blank squares padding the first/last week
  day: number;
}

/** The month as whole Sunday-to-Saturday weeks. Squares outside the month
 * are blank rather than showing the neighbouring month's dates: this
 * calendar is read one month at a time (that is the unit a budget is
 * planned in), and greyed-out dates that can't be clicked or added to
 * would only invite clicks that do nothing. */
export function weeksInMonth(month: string): CalendarDay[][] {
  const length = daysInMonth(month);
  const lead = firstWeekdayOfMonth(month);
  const cells: CalendarDay[] = [];
  for (let i = 0; i < lead; i++) cells.push({ date: null, day: 0 });
  for (let day = 1; day <= length; day++) cells.push({ date: isoDate(month, day), day });
  while (cells.length % 7 !== 0) cells.push({ date: null, day: 0 });
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** What an occurrence is worth, as a magnitude. An override set by hand
 * for this month wins, then whatever was captured when it was generated
 * (which reconciliation replaces with the real amount once a transaction
 * posts), then the series' standing expectation. Null means "no figure
 * yet" — the tile shows a dash, never $0.00, which would read as a real
 * zero-dollar bill. */
export function occurrenceAmountCents(occurrence: SeriesOccurrence, pattern: RecurringPattern | undefined): number | null {
  const magnitude = occurrence.amount_override_cents ?? occurrence.amount_cents ?? pattern?.expected_amount_cents ?? null;
  return magnitude === null ? null : Math.abs(magnitude);
}

/** Signed for arithmetic: income adds, a bill subtracts. A skipped
 * occurrence is money that is not going to move, so it is worth nothing. */
export function occurrenceSignedCents(occurrence: SeriesOccurrence, pattern: RecurringPattern | undefined): number {
  if (occurrence.status === "skipped") return 0;
  const magnitude = occurrenceAmountCents(occurrence, pattern) ?? 0;
  return pattern?.kind === "income" ? magnitude : -magnitude;
}

/** Cash on hand right now: the active depository accounts only. Credit
 * card balances are debts that show up as bills, not as spendable cash,
 * so counting them here would double-subtract them. */
export function cashOnHandCents(accounts: Account[]): number {
  return accounts
    .filter((a) => a.status === "active" && (a.type === "depository_checking" || a.type === "depository_savings"))
    .reduce((sum, a) => sum + (a.current_balance_cents ?? 0), 0);
}

/**
 * The everyday-spending run rate the projection burns down at: what the
 * Spending Plan budgets each month for non-recurring spending, spread
 * evenly across the days of the month.
 *
 * Two kinds of envelope are deliberately left out. Bills are already on
 * the calendar as their own tiles, so counting them here would subtract
 * them twice. And a savings envelope's target is its finish line, not a
 * monthly figure — a $12,000 car fund is not $400 a day of spending, and
 * including it made the projected balance fall off a cliff.
 */
export function perDiemCents(envelopes: Envelope[], categoryById: Map<string, Category>, month: string): number {
  const plannedCents = envelopes
    .filter((e) => !e.archived_at && e.group_name.toLowerCase() !== "bills" && categoryById.get(e.category_id)?.kind === "expense")
    .reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0);
  return Math.round(plannedCents / daysInMonth(month));
}

export interface ProjectionInput {
  month: string; // the month being displayed
  today: string;
  startingCashCents: number;
  /** Occurrences keyed by the month they fall in, for every month from
   * today's through the displayed one. */
  occurrencesByMonth: Record<string, SeriesOccurrence[]>;
  patternById: Map<string, RecurringPattern>;
  perDiemCentsForMonth: (month: string) => number;
}

/**
 * A rough cash balance for each day of the displayed month.
 *
 * It walks forward one day at a time from today's real bank balance,
 * subtracting the everyday-spending per diem and applying each still-
 * upcoming bill and deposit as it comes due. Occurrences already matched
 * to a posted transaction are skipped: that money has already moved, so
 * it is in the starting balance, and applying it again would count it
 * twice.
 *
 * Days before today are absent from the result — they are history, not a
 * projection, and a guess laid over them would be worse than nothing.
 * Viewing a future month walks through the intervening months too, so
 * March's estimate genuinely reflects January's and February's bills.
 */
export function projectDailyBalances(input: ProjectionInput): Map<string, number> {
  const { month, today, startingCashCents, occurrencesByMonth, patternById, perDiemCentsForMonth } = input;
  const balances = new Map<string, number>();
  const lastDay = isoDate(month, daysInMonth(month));
  if (lastDay < today) return balances; // a month entirely in the past

  const upcomingByDate = new Map<string, SeriesOccurrence[]>();
  for (const list of Object.values(occurrencesByMonth)) {
    for (const occurrence of list) {
      if (occurrence.status !== "upcoming") continue;
      const bucket = upcomingByDate.get(occurrence.due_date) ?? [];
      bucket.push(occurrence);
      upcomingByDate.set(occurrence.due_date, bucket);
    }
  }

  let balance = startingCashCents;
  // Today's square shows the real balance, not a projection of it, so the
  // walk starts the day after and today is recorded as-is.
  if (today >= `${month}-01` && today <= lastDay) balances.set(today, balance);

  for (let date = addDays(today, 1); date <= lastDay; date = addDays(date, 1)) {
    balance -= perDiemCentsForMonth(monthOf(date));
    for (const occurrence of upcomingByDate.get(date) ?? []) {
      balance += occurrenceSignedCents(occurrence, patternById.get(occurrence.pattern_id));
    }
    if (date >= `${month}-01`) balances.set(date, balance);
  }

  return balances;
}
