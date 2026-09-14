import { newId } from "../lib/id";
import type { RecurringPattern, RecurringPatternFrequency, RecurringPatternKind, RecurringPatternStatus } from "../types";
import { nowIso } from "./client";

const MIN_OCCURRENCES = 2;
const MIN_DISTINCT_MONTHS = 2;
const DEFAULT_DAY_TOLERANCE = 4;
const LOOKBACK_MONTHS = 6;

export async function listRecurringPatterns(
  db: D1Database,
  householdId: string,
  filter: { status?: RecurringPatternStatus } = {},
): Promise<RecurringPattern[]> {
  const clauses = ["household_id = ?"];
  const params: unknown[] = [householdId];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE ${clauses.join(" AND ")} ORDER BY day_of_month, created_at`)
    .bind(...params)
    .all<RecurringPattern>();
  return results;
}

function dayOfMonth(postedAt: string): number {
  return Number(postedAt.slice(8, 10));
}

/** 0=Sunday..6=Saturday, for weekly-frequency matching. postedAt is an ISO
 * date ('YYYY-MM-DD'); Date.parse on a bare date is UTC, which is fine
 * here since only the day-of-week within that date matters. */
function dayOfWeek(postedAt: string): number {
  return new Date(`${postedAt}T00:00:00Z`).getUTCDay();
}

function monthKey(postedAt: string): string {
  return postedAt.slice(0, 7);
}

/** Circular distance between two days-of-month over a ~30-day month —
 * "the 30th" and "the 1st" are 2 days apart, not 29, so a bill that lands
 * right at month-end doesn't get treated as a mismatch every other month. */
function dayDistance(a: number, b: number, monthLength = 30): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, monthLength - diff);
}

/** Median magnitude of a group's amounts, in cents — a series' expected
 * amount is the middle of what it has actually charged, not the mean,
 * so one anomalous month doesn't drag the projection with it. Always
 * positive: sign is the pattern's `kind`, not the amount's. */
function medianAmountCents(rows: { amount_cents: number }[]): number | null {
  if (rows.length === 0) return null;
  const magnitudes = rows.map((r) => Math.abs(r.amount_cents)).sort((a, b) => a - b);
  return magnitudes[Math.floor(magnitudes.length / 2)]!;
}

interface DetectableTransaction {
  normalized_merchant: string | null;
  raw_description: string;
  amount_cents: number;
  posted_at: string;
}

function merchantKey(t: DetectableTransaction): string {
  return (t.normalized_merchant ?? t.raw_description).trim().toUpperCase();
}

/**
 * Vendor + day-of-month recurrence, not exact amount — a utility bill that's
 * $200 one month and $240 the next from the same merchant around the same
 * day is still the same recurring bill (and the same shape applies to
 * recurring income, e.g. a paycheck). Scans the household's own history
 * rather than requiring the person to describe the pattern up front; run
 * after a Plaid sync (src/plaid/sync.ts) and on demand from the Recurring
 * page. Never touches a merchant+kind combo that already has a pattern row
 * (suggested, confirmed, or dismissed) — dismissing a false positive once
 * should stick, not get re-suggested on the next sync.
 */
export async function detectRecurringPatterns(db: D1Database, householdId: string): Promise<RecurringPattern[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS);
  const sinceStr = since.toISOString().slice(0, 10);

  const [{ results: transactions }, existing] = await Promise.all([
    db
      .prepare(
        `SELECT normalized_merchant, raw_description, amount_cents, posted_at FROM "transaction"
           WHERE household_id = ? AND is_transfer = 0 AND excluded_from_budget = 0 AND posted_at >= ?`,
      )
      .bind(householdId, sinceStr)
      .all<DetectableTransaction>(),
    listRecurringPatterns(db, householdId),
  ]);

  const alreadyCovered = new Set(existing.map((p) => `${p.merchant_pattern}::${p.kind}`));

  const groups = new Map<string, { kind: RecurringPatternKind; rows: DetectableTransaction[] }>();
  for (const t of transactions) {
    if (t.amount_cents === 0) continue;
    const kind: RecurringPatternKind = t.amount_cents < 0 ? "expense" : "income";
    const key = `${merchantKey(t)}::${kind}`;
    if (alreadyCovered.has(key)) continue;
    const group = groups.get(key) ?? { kind, rows: [] };
    group.rows.push(t);
    groups.set(key, group);
  }

  const now = nowIso();
  const created: RecurringPattern[] = [];
  for (const [key, group] of groups) {
    if (group.rows.length < MIN_OCCURRENCES) continue;
    const distinctMonths = new Set(group.rows.map((t) => monthKey(t.posted_at)));
    if (distinctMonths.size < MIN_DISTINCT_MONTHS) continue;

    const days = group.rows.map((t) => dayOfMonth(t.posted_at)).sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)]!;
    const allWithinTolerance = days.every((d) => dayDistance(d, medianDay) <= DEFAULT_DAY_TOLERANCE);
    if (!allWithinTolerance) continue;

    const id = newId("rpat");
    const merchant = key.slice(0, key.lastIndexOf("::"));
    // Seed the projected amount from the history that proved this is a
    // series in the first place, so an occurrence has a figure to show
    // before the next one posts (src/envelopes/occurrences.ts).
    const expectedAmountCents = medianAmountCents(group.rows);
    await db
      .prepare(
        `INSERT INTO recurring_pattern (id, household_id, category_id, merchant_pattern, kind, day_of_month, day_tolerance, status, sample_count, expected_amount_cents, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?)`,
      )
      .bind(id, householdId, merchant, group.kind, medianDay, DEFAULT_DAY_TOLERANCE, group.rows.length, expectedAmountCents, now, now)
      .run();
    created.push({
      id,
      household_id: householdId,
      category_id: null,
      merchant_pattern: merchant,
      kind: group.kind,
      frequency: "monthly",
      day_of_month: medianDay,
      day_of_month_2: null,
      day_of_week: null,
      day_tolerance: DEFAULT_DAY_TOLERANCE,
      status: "suggested",
      sample_count: group.rows.length,
      expected_amount_cents: expectedAmountCents,
      ended_at: null,
      created_at: now,
      updated_at: now,
    });
  }
  return created;
}

/**
 * The "Add recurring" wizard's write path — a pattern built by hand from a
 * picked transaction (or typed in directly), already pointed at a
 * category, so it's created straight into 'confirmed' rather than going
 * through the detector's 'suggested' stage first.
 */
export interface RecurringPatternScheduleInput {
  frequency?: RecurringPatternFrequency;
  dayOfMonth: number; // still required (and used) for 'monthly'/'semimonthly'; ignored for 'weekly'
  dayOfMonth2?: number | null; // 'semimonthly' only
  dayOfWeek?: number | null; // 'weekly' only, 0-6
  dayTolerance?: number;
}

export async function createConfirmedRecurringPattern(
  db: D1Database,
  householdId: string,
  input: { categoryId: string; merchantPattern: string; kind: RecurringPatternKind; expectedAmountCents?: number | null } & RecurringPatternScheduleInput,
): Promise<RecurringPattern> {
  const id = newId("rpat");
  const now = nowIso();
  const frequency = input.frequency ?? "monthly";
  const expectedAmountCents = input.expectedAmountCents ?? null;
  const dayTolerance = input.dayTolerance ?? DEFAULT_DAY_TOLERANCE;
  const dayOfMonth2 = frequency === "semimonthly" ? (input.dayOfMonth2 ?? null) : null;
  const dayOfWeek = frequency === "weekly" ? (input.dayOfWeek ?? null) : null;
  const merchantPattern = input.merchantPattern.trim().toUpperCase();
  await db
    .prepare(
      `INSERT INTO recurring_pattern (id, household_id, category_id, merchant_pattern, kind, frequency, day_of_month, day_of_month_2, day_of_week, day_tolerance, status, sample_count, expected_amount_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 0, ?, ?, ?)`,
    )
    .bind(id, householdId, input.categoryId, merchantPattern, input.kind, frequency, input.dayOfMonth, dayOfMonth2, dayOfWeek, dayTolerance, expectedAmountCents, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    category_id: input.categoryId,
    merchant_pattern: merchantPattern,
    kind: input.kind,
    frequency,
    day_of_month: input.dayOfMonth,
    day_of_month_2: dayOfMonth2,
    day_of_week: dayOfWeek,
    day_tolerance: dayTolerance,
    status: "confirmed",
    sample_count: 0,
    expected_amount_cents: expectedAmountCents,
    ended_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function confirmRecurringPattern(db: D1Database, householdId: string, id: string, categoryId: string): Promise<RecurringPattern> {
  const now = nowIso();
  await db
    .prepare(`UPDATE recurring_pattern SET status = 'confirmed', category_id = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(categoryId, now, id, householdId)
    .run();
  const pattern = await db.prepare(`SELECT * FROM recurring_pattern WHERE id = ? AND household_id = ?`).bind(id, householdId).first<RecurringPattern>();
  if (!pattern) throw new Error(`recurring_pattern ${id} not found`);
  return pattern;
}

/**
 * Editing a series: which merchant it matches, its schedule, what it's
 * expected to cost, which category it files under, and whether it has
 * ended. Ending a series is deliberately not the same as dismissing a
 * suggestion — matched history stays on the plan, only future projection
 * stops (src/envelopes/occurrences.ts skips ended patterns).
 */
export async function updateRecurringPattern(
  db: D1Database,
  householdId: string,
  id: string,
  input: {
    merchantPattern?: string;
    categoryId?: string;
    expectedAmountCents?: number | null;
    endedAt?: string | null;
  } & Partial<RecurringPatternScheduleInput>,
): Promise<RecurringPattern> {
  const existing = await db.prepare(`SELECT * FROM recurring_pattern WHERE id = ? AND household_id = ?`).bind(id, householdId).first<RecurringPattern>();
  if (!existing) throw new Error(`recurring_pattern ${id} not found`);

  const frequency = input.frequency ?? existing.frequency;
  const dayOfMonth = input.dayOfMonth ?? existing.day_of_month;
  const dayOfMonth2 = frequency === "semimonthly" ? (input.dayOfMonth2 ?? existing.day_of_month_2) : null;
  const dayOfWeek = frequency === "weekly" ? (input.dayOfWeek ?? existing.day_of_week) : null;
  const dayTolerance = input.dayTolerance ?? existing.day_tolerance;
  const merchantPattern = input.merchantPattern ? input.merchantPattern.trim().toUpperCase() : existing.merchant_pattern;
  const categoryId = input.categoryId ?? existing.category_id;
  // "expectedAmountCents": null clears the figure (fall back to matched
  // history); omitted leaves it alone. Same for endedAt, where null is
  // how a series is un-ended.
  const expectedAmountCents = "expectedAmountCents" in input ? (input.expectedAmountCents ?? null) : existing.expected_amount_cents;
  const endedAt = "endedAt" in input ? (input.endedAt ?? null) : existing.ended_at;
  const now = nowIso();

  await db
    .prepare(
      `UPDATE recurring_pattern
         SET merchant_pattern = ?, category_id = ?, frequency = ?, day_of_month = ?, day_of_month_2 = ?, day_of_week = ?, day_tolerance = ?,
             expected_amount_cents = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND household_id = ?`,
    )
    .bind(merchantPattern, categoryId, frequency, dayOfMonth, dayOfMonth2, dayOfWeek, dayTolerance, expectedAmountCents, endedAt, now, id, householdId)
    .run();

  return {
    ...existing,
    merchant_pattern: merchantPattern,
    category_id: categoryId,
    frequency,
    day_of_month: dayOfMonth,
    day_of_month_2: dayOfMonth2,
    day_of_week: dayOfWeek,
    day_tolerance: dayTolerance,
    expected_amount_cents: expectedAmountCents,
    ended_at: endedAt,
    updated_at: now,
  };
}

export async function dismissRecurringPattern(db: D1Database, householdId: string, id: string): Promise<void> {
  await db
    .prepare(`UPDATE recurring_pattern SET status = 'dismissed', updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(nowIso(), id, householdId)
    .run();
}

/**
 * The categorization pipeline's first stop (src/categorization/pipeline.ts,
 * ahead of the rules/memory/LLM cascade): "any transaction from Lehi City
 * on that pattern is auto matched to that bill" regardless of the amount —
 * a confirmed recurring pattern is a stronger, human-approved signal than
 * anything the cascade would otherwise produce for that merchant.
 */
/** Whether txn's posted date falls on schedule for a confirmed pattern,
 * dispatched on frequency: 'monthly' checks day_of_month, 'semimonthly'
 * checks either of its two days, 'weekly' checks the weekday exactly (day
 * counts don't apply across week boundaries the way they do within a
 * month, so day_tolerance is ignored for weekly rows). */
function onSchedule(pattern: RecurringPattern, postedAt: string): boolean {
  if (pattern.frequency === "weekly") {
    return pattern.day_of_week !== null && dayOfWeek(postedAt) === pattern.day_of_week;
  }
  const day = dayOfMonth(postedAt);
  if (pattern.frequency === "semimonthly") {
    const matchesFirst = dayDistance(day, pattern.day_of_month) <= pattern.day_tolerance;
    const matchesSecond = pattern.day_of_month_2 !== null && dayDistance(day, pattern.day_of_month_2) <= pattern.day_tolerance;
    return matchesFirst || matchesSecond;
  }
  return dayDistance(day, pattern.day_of_month) <= pattern.day_tolerance;
}

export async function matchRecurringPattern(db: D1Database, householdId: string, txn: DetectableTransaction): Promise<string | null> {
  if (txn.amount_cents === 0) return null;
  const kind: RecurringPatternKind = txn.amount_cents < 0 ? "expense" : "income";
  const key = merchantKey(txn);

  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE household_id = ? AND status = 'confirmed' AND kind = ? AND category_id IS NOT NULL`)
    .bind(householdId, kind)
    .all<RecurringPattern>();

  const match = results.find((p) => key.includes(p.merchant_pattern) && onSchedule(p, txn.posted_at));
  return match?.category_id ?? null;
}

/**
 * Remove a series outright, along with the occurrences it projected.
 * Distinct from ending it (which keeps matched history on the plan) and
 * from dismissing a suggestion (which stops it being re-suggested) — this
 * is for a series that should never have existed, which in practice means
 * undoing one that was just created by mistake.
 */
export async function deleteRecurringPattern(db: D1Database, householdId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM series_occurrence WHERE pattern_id = ? AND household_id = ?`).bind(id, householdId).run();
  await db.prepare(`DELETE FROM recurring_pattern WHERE id = ? AND household_id = ?`).bind(id, householdId).run();
}

export async function getRecurringPattern(db: D1Database, householdId: string, id: string): Promise<RecurringPattern | null> {
  return db.prepare(`SELECT * FROM recurring_pattern WHERE id = ? AND household_id = ?`).bind(id, householdId).first<RecurringPattern>();
}
