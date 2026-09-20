import { newId } from "../lib/id";
import type { RecurringPattern, RecurringPatternFrequency, RecurringPatternKind, RecurringPatternStatus } from "../types";
import { nowIso } from "./client";
import { canonicalMerchantKey } from "../lib/merchant";
import {
  DEFAULT_DAY_TOLERANCE,
  dayDistance,
  dayOfMonth,
  dayOfWeek,
  inferRecurringSeries,
  type DetectableTransaction,
} from "../lib/recurringDetection";

/** How far back detection looks. Plaid's initial sync carries up to two
 * years, so a year is enough to see a series several times over without
 * resurrecting bills that ended long ago (recency is checked separately
 * in src/lib/recurringDetection.ts). */
const LOOKBACK_MONTHS = 12;

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

function merchantKey(t: DetectableTransaction): string {
  return (t.normalized_merchant ?? t.raw_description).trim().toUpperCase();
}

/**
 * Vendor + cadence recurrence, not exact amount — a utility bill that's
 * $200 one month and $240 the next from the same merchant around the same
 * day is still the same recurring bill (and the same shape applies to
 * recurring income, e.g. a paycheck). The inference itself lives in
 * src/lib/recurringDetection.ts (weekly / biweekly / twice-monthly /
 * monthly, with amount clustering and outlier tolerance); this scans the
 * household's own history rather than requiring the person to describe
 * the pattern up front, and runs after a Plaid sync (src/plaid/sync.ts)
 * and on demand from the Bills page. Never touches a merchant+kind combo
 * that already has a pattern row (suggested, confirmed, or dismissed) —
 * dismissing a false positive once should stick, not get re-suggested on
 * the next sync. "Already has" is a substring match either way, so a
 * confirmed NETFLIX blocks a NETFLIX.COM suggestion and vice versa.
 */
export async function detectRecurringPatterns(
  db: D1Database,
  householdId: string,
  today: string = nowIso().slice(0, 10),
): Promise<RecurringPattern[]> {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - LOOKBACK_MONTHS);
  const sinceStr = since.toISOString().slice(0, 10);

  const [{ results: transactions }, existing] = await Promise.all([
    db
      .prepare(
        `SELECT normalized_merchant, raw_description, amount_cents, posted_at FROM "transaction"
           WHERE household_id = ? AND is_transfer = 0 AND excluded_from_budget = 0 AND split_parent_id IS NULL AND posted_at >= ?`,
      )
      .bind(householdId, sinceStr)
      .all<DetectableTransaction>(),
    listRecurringPatterns(db, householdId),
  ]);

  const isCovered = (merchant: string, kind: RecurringPatternKind) =>
    existing.some((p) => p.kind === kind && (merchant.includes(p.merchant_pattern) || p.merchant_pattern.includes(merchant)));

  const suggestions = inferRecurringSeries(transactions, { today, isCovered });

  const now = nowIso();
  const created: RecurringPattern[] = [];
  for (const s of suggestions) {
    const id = newId("rpat");
    await db
      .prepare(
        `INSERT INTO recurring_pattern (id, household_id, category_id, merchant_pattern, kind, frequency, day_of_month, day_of_month_2, day_of_week, day_tolerance, status, sample_count, expected_amount_cents, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?)`,
      )
      .bind(id, householdId, s.merchantPattern, s.kind, s.frequency, s.dayOfMonth, s.dayOfMonth2, s.dayOfWeek, s.dayTolerance, s.sampleCount, s.expectedAmountCents, now, now)
      .run();
    created.push({
      id,
      household_id: householdId,
      category_id: null,
      merchant_pattern: s.merchantPattern,
      kind: s.kind,
      frequency: s.frequency,
      day_of_month: s.dayOfMonth,
      day_of_month_2: s.dayOfMonth2,
      day_of_week: s.dayOfWeek,
      day_tolerance: s.dayTolerance,
      status: "suggested",
      sample_count: s.sampleCount,
      expected_amount_cents: s.expectedAmountCents,
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
  // Both the display-faithful key and the detector's canonical key, so a
  // pattern the detector suggested ("AMAZON PRIME") matches a charge whose
  // raw key still carries a reference token ("AMAZON PRIME*2K4L9 ...").
  const key = merchantKey(txn);
  const canonical = canonicalMerchantKey(key);

  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE household_id = ? AND status = 'confirmed' AND kind = ? AND category_id IS NOT NULL`)
    .bind(householdId, kind)
    .all<RecurringPattern>();

  const match = results.find((p) => (key.includes(p.merchant_pattern) || canonical.includes(p.merchant_pattern)) && onSchedule(p, txn.posted_at));
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
