import { canonicalMerchantKey } from "./merchant";
import type { RecurringPatternFrequency, RecurringPatternKind } from "../types";

/**
 * Pure recurrence inference over a household's transaction history —
 * the part of bill detection that has no database in it, so it can be
 * exercised directly in tests. src/db/recurringPatterns.ts's
 * detectRecurringPatterns feeds it rows and stores what comes back.
 *
 * Why this exists: the original detector only ever looked for "one charge
 * a month, always within four days of the same date", so a biweekly
 * paycheck, a mortgage paid on the 1st and 15th, a weekly daycare charge,
 * a subscription buried among one-off purchases at the same merchant, or
 * a utility whose due date drifts with the billing cycle were all
 * invisible. This version:
 *
 *  1. groups by a canonical merchant key that survives reference tokens,
 *     phone numbers and ".COM" suffixes (src/lib/merchant.ts);
 *  2. clusters each merchant's charges by amount, so a fixed-price
 *     subscription separates from ad hoc shopping at the same store;
 *  3. reads the cadence off the gaps between charges (weekly, biweekly,
 *     twice a month, monthly) instead of assuming monthly;
 *  4. allows a few outliers rather than rejecting the whole series on one
 *     stray charge;
 *  5. ignores series whose last charge is too old to still be live.
 */

export interface DetectableTransaction {
  normalized_merchant: string | null;
  raw_description: string;
  amount_cents: number;
  posted_at: string; // 'YYYY-MM-DD'
}

export interface SeriesSuggestion {
  merchantPattern: string;
  kind: RecurringPatternKind;
  frequency: RecurringPatternFrequency;
  dayOfMonth: number;
  dayOfMonth2: number | null;
  dayOfWeek: number | null;
  dayTolerance: number;
  sampleCount: number;
  expectedAmountCents: number;
  /** The cadence actually observed. 'biweekly' has no frequency of its
   * own in the schema yet, so it is stored as the nearest shape
   * (semimonthly, on the two most recent paydays) with a wider tolerance;
   * this field says so, for callers and tests that care. */
  observedCadence: "weekly" | "biweekly" | "semimonthly" | "monthly";
}

export const DEFAULT_DAY_TOLERANCE = 4;
/** Widest tolerance a monthly suggestion is allowed to stretch to when the
 * observed dates need it (utilities whose due date wanders with the
 * billing cycle). */
const MAX_MONTHLY_TOLERANCE = 6;
/** Tolerance stored for a biweekly series approximated as semimonthly —
 * the paydays walk through the month by a couple of days each cycle, so
 * the projected dates need room to still reconcile against what posts. */
const BIWEEKLY_APPROX_TOLERANCE = 6;
const WEEKLY_TOLERANCE = 2;

const MIN_MONTHLY_OCCURRENCES = 2;
const MIN_MONTHLY_DISTINCT_MONTHS = 2;
const MIN_SEMIMONTHLY_OCCURRENCES = 4;
const MIN_BIWEEKLY_OCCURRENCES = 3;
const MIN_WEEKLY_OCCURRENCES = 4;
/** Share of occurrences that must share a weekday for weekly/biweekly. */
const WEEKDAY_AGREEMENT = 0.75;
/** One stray charge is tolerated per this many occurrences (rounded down). */
const OUTLIERS_PER_OCCURRENCES = 4;

/** Amount clustering: adjacent (sorted) magnitudes belong to the same
 * cluster when the larger is within this ratio of the smaller, plus a
 * small absolute slack so cheap subscriptions don't split on a tax
 * change. */
const AMOUNT_CLUSTER_RATIO = 1.25;
const AMOUNT_CLUSTER_SLACK_CENTS = 300;

/** How long after its expected next date a series may go quiet before it
 * stops being suggested (a cancelled subscription shouldn't show up as a
 * bill months later). */
const STALE_AFTER_DAYS: Record<SeriesSuggestion["observedCadence"], number> = {
  weekly: 21,
  biweekly: 35,
  semimonthly: 35,
  monthly: 50,
};

export function dayOfMonth(postedAt: string): number {
  return Number(postedAt.slice(8, 10));
}

/** 0=Sunday..6=Saturday. postedAt is a bare ISO date, parsed as UTC so
 * only the calendar day matters. */
export function dayOfWeek(postedAt: string): number {
  return new Date(`${postedAt}T00:00:00Z`).getUTCDay();
}

function monthKey(postedAt: string): string {
  return postedAt.slice(0, 7);
}

/** Circular distance between two days-of-month over a ~30-day month —
 * "the 30th" and "the 1st" are 2 days apart, not 29. */
export function dayDistance(a: number, b: number, monthLength = 30): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, monthLength - diff);
}

export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Median magnitude in cents — the middle of what the series has actually
 * charged, so one anomalous month doesn't drag the projection. */
function medianAmountCents(rows: DetectableTransaction[]): number {
  return median(rows.map((r) => Math.abs(r.amount_cents)));
}

function distinctSortedDates(rows: DetectableTransaction[]): string[] {
  return [...new Set(rows.map((r) => r.posted_at))].sort();
}

function mode<T>(values: T[]): { value: T; share: number } {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T = values[0]!;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, share: bestCount / values.length };
}

export function groupingKey(t: DetectableTransaction): string {
  return canonicalMerchantKey(t.normalized_merchant ?? t.raw_description);
}

/**
 * Split a merchant's charges into amount clusters. Sorted by magnitude,
 * a charge joins the running cluster while it is within
 * AMOUNT_CLUSTER_RATIO (plus slack) of the previous one — so $15.99 every
 * month is its own cluster next to $43.12 and $8.99 of shopping, while a
 * utility drifting $180 → $200 → $220 → $260 chains into one.
 */
export function amountClusters(rows: DetectableTransaction[]): DetectableTransaction[][] {
  const sorted = [...rows].sort((a, b) => Math.abs(a.amount_cents) - Math.abs(b.amount_cents));
  const clusters: DetectableTransaction[][] = [];
  let current: DetectableTransaction[] = [];
  let previous: number | null = null;
  for (const row of sorted) {
    const magnitude = Math.abs(row.amount_cents);
    if (previous !== null && magnitude > previous * AMOUNT_CLUSTER_RATIO + AMOUNT_CLUSTER_SLACK_CENTS) {
      clusters.push(current);
      current = [];
    }
    current.push(row);
    previous = magnitude;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

interface Schedule {
  frequency: RecurringPatternFrequency;
  observedCadence: SeriesSuggestion["observedCadence"];
  dayOfMonth: number;
  dayOfMonth2: number | null;
  dayOfWeek: number | null;
  dayTolerance: number;
  kept: DetectableTransaction[];
  /** Charges in the evaluated set the schedule had to leave out. */
  outliers: number;
}

function isStale(schedule: Schedule, today: string): boolean {
  const last = distinctSortedDates(schedule.kept).at(-1)!;
  if (last > today) return false;
  return daysBetween(last, today) > STALE_AFTER_DAYS[schedule.observedCadence];
}

function allowedOutliers(n: number): number {
  return Math.floor(n / OUTLIERS_PER_OCCURRENCES);
}

/** Weekly: at least four charges, a median gap of about a week, and
 * three quarters of them on the same weekday. */
function inferWeekly(rows: DetectableTransaction[], gaps: number[]): Schedule | null {
  if (rows.length < MIN_WEEKLY_OCCURRENCES || gaps.length === 0) return null;
  const medianGap = median(gaps);
  if (medianGap < 5 || medianGap > 9) return null;
  const weekday = mode(rows.map((r) => dayOfWeek(r.posted_at)));
  if (weekday.share < WEEKDAY_AGREEMENT) return null;
  const kept = rows.filter((r) => dayOfWeek(r.posted_at) === weekday.value);
  return {
    frequency: "weekly",
    observedCadence: "weekly",
    dayOfMonth: dayOfMonth(kept.at(-1)!.posted_at),
    dayOfMonth2: null,
    dayOfWeek: weekday.value,
    dayTolerance: WEEKLY_TOLERANCE,
    kept,
    outliers: 0,
  };
}

/** Best single day-of-month centre for a set of days: the one (over all
 * 31 candidates, so the centre needn't be an observed day) leaving the
 * fewest outliers past `tolerance`, then the smallest spread. */
function bestCentre(days: number[], tolerance: number): { centre: number; outliers: number; spread: number } {
  let best = { centre: days[0]!, outliers: Infinity, spread: Infinity, total: Infinity };
  for (let centre = 1; centre <= 31; centre++) {
    const distances = days.map((d) => dayDistance(d, centre));
    const inside = distances.filter((d) => d <= tolerance);
    const outliers = distances.length - inside.length;
    const total = inside.reduce((sum, d) => sum + d, 0);
    const spread = Math.max(...inside, 0);
    // Fewest outliers, then closest to the charges overall (so the 1st
    // wins over the 2nd for 1,1,1,3), then the tightest spread.
    if (outliers < best.outliers || (outliers === best.outliers && (total < best.total || (total === best.total && spread < best.spread)))) {
      best = { centre, outliers, spread, total };
    }
  }
  return { centre: best.centre, outliers: best.outliers, spread: best.spread };
}

/** Twice a month on two fixed days (the 1st and the 15th): at least four
 * charges whose days-of-month fall into two groups at least ten days
 * apart, each within the default tolerance. */
function inferSemimonthly(rows: DetectableTransaction[], gaps: number[]): Schedule | null {
  if (rows.length < MIN_SEMIMONTHLY_OCCURRENCES || gaps.length === 0) return null;
  const medianGap = median(gaps);
  if (medianGap < 10 || medianGap > 20) return null;
  const days = rows.map((r) => dayOfMonth(r.posted_at));
  // Split the circle of days at its widest empty arc, then again at the
  // second widest — the two arcs left are the two paydays' clusters.
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  const arcs = unique.map((d, i) => {
    const next = unique[(i + 1) % unique.length]!;
    const length = i === unique.length - 1 ? next + 30 - d : next - d;
    return { from: d, length };
  });
  const [gapA, gapB] = [...arcs].sort((x, y) => y.length - x.length);
  if (!gapA || !gapB) return null;
  const inCluster = (d: number, startExclusive: number, endInclusive: number) => {
    // Circular membership in (start, end] over a 30-day ring.
    const rel = (x: number) => ((x - startExclusive) % 30 + 30) % 30;
    return rel(d) > 0 && rel(d) <= rel(endInclusive);
  };
  const clusterA = days.filter((d) => inCluster(d, gapA.from, gapB.from));
  const clusterB = days.filter((d) => !inCluster(d, gapA.from, gapB.from));
  if (clusterA.length === 0 || clusterB.length === 0) return null;
  const centreA = bestCentre(clusterA, DEFAULT_DAY_TOLERANCE).centre;
  const centreB = bestCentre(clusterB, DEFAULT_DAY_TOLERANCE).centre;
  if (dayDistance(centreA, centreB) < 10) return null;
  const onSchedule = (r: DetectableTransaction) => {
    const d = dayOfMonth(r.posted_at);
    return dayDistance(d, centreA) <= DEFAULT_DAY_TOLERANCE || dayDistance(d, centreB) <= DEFAULT_DAY_TOLERANCE;
  };
  const kept = rows.filter(onSchedule);
  if (rows.length - kept.length > allowedOutliers(rows.length)) return null;
  // Both days must actually be used, not one payday plus noise, and the
  // charges must alternate between them in time — a subscription on the
  // 10th plus shopping on the 2nd and 27th is not "twice a month".
  const sides = kept.map((r) => (dayDistance(dayOfMonth(r.posted_at), centreA) <= DEFAULT_DAY_TOLERANCE ? "a" : "b"));
  const nearA = sides.filter((s) => s === "a").length;
  if (nearA < 2 || kept.length - nearA < 2) return null;
  const repeats = sides.filter((side, i) => i > 0 && side === sides[i - 1]).length;
  if (repeats > allowedOutliers(rows.length)) return null;
  const distinctMonths = new Set(kept.map((r) => monthKey(r.posted_at))).size;
  if (kept.length > distinctMonths * 2.5) return null;
  const [first, second] = [centreA, centreB].sort((a, b) => a - b) as [number, number];
  return {
    frequency: "semimonthly",
    observedCadence: "semimonthly",
    dayOfMonth: first,
    dayOfMonth2: second,
    dayOfWeek: null,
    dayTolerance: DEFAULT_DAY_TOLERANCE,
    kept,
    outliers: 0,
  };
}

/** Every other week (the classic paycheck): a median gap of about 14 days
 * and a consistent weekday. Stored as semimonthly on the two most recent
 * paydays' days-of-month — see SeriesSuggestion.observedCadence. */
function inferBiweekly(rows: DetectableTransaction[], gaps: number[]): Schedule | null {
  if (rows.length < MIN_BIWEEKLY_OCCURRENCES || gaps.length === 0) return null;
  const medianGap = median(gaps);
  if (medianGap < 12 || medianGap > 16) return null;
  const weekday = mode(rows.map((r) => dayOfWeek(r.posted_at)));
  if (weekday.share < WEEKDAY_AGREEMENT) return null;
  const kept = rows.filter((r) => dayOfWeek(r.posted_at) === weekday.value);
  const dates = distinctSortedDates(kept);
  if (dates.length < 2) return null;
  const [older, latest] = [dates.at(-2)!, dates.at(-1)!];
  const days = [dayOfMonth(older), dayOfMonth(latest)].sort((a, b) => a - b);
  if (days[0] === days[1]) return null;
  return {
    frequency: "semimonthly",
    observedCadence: "biweekly",
    dayOfMonth: days[0]!,
    dayOfMonth2: days[1]!,
    dayOfWeek: null,
    dayTolerance: BIWEEKLY_APPROX_TOLERANCE,
    kept,
    outliers: 0,
  };
}

/** Once a month around the same day, with room for the due date to
 * wander (up to MAX_MONTHLY_TOLERANCE) and for a stray charge or two. */
function inferMonthly(rows: DetectableTransaction[]): Schedule | null {
  if (rows.length < MIN_MONTHLY_OCCURRENCES) return null;
  const days = rows.map((r) => dayOfMonth(r.posted_at));
  const centre = bestCentre(days, MAX_MONTHLY_TOLERANCE);
  if (centre.outliers > allowedOutliers(rows.length)) return null;
  const kept = rows.filter((r) => dayDistance(dayOfMonth(r.posted_at), centre.centre) <= MAX_MONTHLY_TOLERANCE);
  const distinctMonths = new Set(kept.map((r) => monthKey(r.posted_at)));
  if (distinctMonths.size < MIN_MONTHLY_DISTINCT_MONTHS) return null;
  // "Monthly" means about one a month: a shop visited every few days that
  // happens to cluster around the same dates is not a bill.
  if (kept.length > distinctMonths.size * 1.5) return null;
  return {
    frequency: "monthly",
    observedCadence: "monthly",
    dayOfMonth: centre.centre,
    dayOfMonth2: null,
    dayOfWeek: null,
    dayTolerance: Math.max(DEFAULT_DAY_TOLERANCE, centre.spread),
    kept,
    outliers: 0,
  };
}

function inferSchedule(rows: DetectableTransaction[], today: string): Schedule | null {
  const dates = distinctSortedDates(rows);
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  const sorted = [...rows].sort((a, b) => a.posted_at.localeCompare(b.posted_at));
  // Biweekly before twice-monthly: over a few months the two look alike
  // by day-of-month, and what tells them apart is that every-other-week
  // pay lands on the same weekday while the 1st-and-15th does not.
  const schedule = inferWeekly(sorted, gaps) ?? inferBiweekly(sorted, gaps) ?? inferSemimonthly(sorted, gaps) ?? inferMonthly(sorted);
  if (!schedule || isStale(schedule, today)) return null;
  return { ...schedule, outliers: rows.length - schedule.kept.length };
}

/**
 * The best series a merchant's charges support, evaluated over the whole
 * set (a utility whose amount moves month to month is still one bill)
 * and over each amount cluster (a subscription among one-off purchases).
 * At most one suggestion per merchant and kind, since that is how
 * confirmed patterns match transactions.
 */
function bestSeries(rows: DetectableTransaction[], today: string): Schedule | null {
  const candidates = [rows, ...amountClusters(rows).filter((c) => c.length >= MIN_MONTHLY_OCCURRENCES && c.length < rows.length)];
  const schedules = candidates
    .map((set) => {
      const schedule = inferSchedule(set, today);
      return schedule ? { schedule, outlierShare: schedule.outliers / set.length } : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  // The cleanest fit wins: fewest charges left out (as a share of what
  // was evaluated), then the tightest spread, then the most evidence.
  // So a fixed-price subscription beats "all of Amazon with two
  // outliers", while a utility that varies in amount but never misses
  // its date still wins as one whole series.
  schedules.sort(
    (a, b) => a.outlierShare - b.outlierShare || a.schedule.dayTolerance - b.schedule.dayTolerance || b.schedule.kept.length - a.schedule.kept.length,
  );
  return schedules[0]?.schedule ?? null;
}

export interface InferOptions {
  /** 'YYYY-MM-DD'; series whose last charge is too far before this are dropped. */
  today: string;
  /** Skip a merchant+kind when this returns true (already has a pattern row). */
  isCovered?: (merchantPattern: string, kind: RecurringPatternKind) => boolean;
}

export function inferRecurringSeries(transactions: DetectableTransaction[], options: InferOptions): SeriesSuggestion[] {
  const groups = new Map<string, { merchant: string; kind: RecurringPatternKind; rows: DetectableTransaction[] }>();
  for (const t of transactions) {
    if (t.amount_cents === 0) continue;
    const merchant = groupingKey(t);
    if (!merchant) continue;
    const kind: RecurringPatternKind = t.amount_cents < 0 ? "expense" : "income";
    if (options.isCovered?.(merchant, kind)) continue;
    const key = `${merchant}::${kind}`;
    const group = groups.get(key) ?? { merchant, kind, rows: [] };
    group.rows.push(t);
    groups.set(key, group);
  }

  const suggestions: SeriesSuggestion[] = [];
  for (const group of groups.values()) {
    const schedule = bestSeries(group.rows, options.today);
    if (!schedule) continue;
    suggestions.push({
      merchantPattern: group.merchant,
      kind: group.kind,
      frequency: schedule.frequency,
      dayOfMonth: schedule.dayOfMonth,
      dayOfMonth2: schedule.dayOfMonth2,
      dayOfWeek: schedule.dayOfWeek,
      dayTolerance: schedule.dayTolerance,
      sampleCount: schedule.kept.length,
      expectedAmountCents: medianAmountCents(schedule.kept),
      observedCadence: schedule.observedCadence,
    });
  }
  return suggestions.sort((a, b) => a.merchantPattern.localeCompare(b.merchantPattern));
}
