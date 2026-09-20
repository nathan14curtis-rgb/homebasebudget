/**
 * Projected occurrences of a recurring series (docs/SPENDING_PLAN_EDITING.md
 * phase 2).
 *
 * The Spending Plan reads forward, not just backward: a paycheck due on the
 * 20th is a row on the 4th, marked "Upcoming", before any transaction
 * exists — and becomes "Received" when the real one posts. That means
 * expanding each confirmed pattern's schedule across a month into concrete
 * `series_occurrence` rows, then reconciling them against what actually
 * posted.
 *
 * Occurrences are materialized rather than derived on read because a single
 * one can be edited ("the water bill is $240 this month") or skipped, and a
 * derived list has nowhere to hang that. Generation is therefore idempotent
 * and non-destructive: it upserts on (pattern_id, due_date), and never
 * touches an override, a skip, or a match.
 */

import { newId } from "../lib/id";
import { nowIso } from "../db/client";
import type { RecurringPattern, SeriesOccurrence } from "../types";

const MONTH_RE = /^\d{4}-\d{2}$/;

function assertMonth(month: string): void {
  if (!MONTH_RE.test(month)) throw new Error(`month must be 'YYYY-MM', got '${month}'`);
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function isoDate(year: number, monthIndex0: number, day: number): string {
  const mm = String(monthIndex0 + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Days between two ISO dates, absolute. Both are bare dates, so UTC
 * parsing keeps this free of timezone drift. */
export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/**
 * Every date in `month` this pattern is due, in ascending order.
 *
 * - monthly: its day_of_month, clamped to the month's length so a bill due
 *   on the 31st still lands (on the 28th/29th/30th) in a short month
 *   instead of silently vanishing or rolling into the next one.
 * - semimonthly: both days, same clamping, deduplicated and sorted.
 * - weekly: every date in the month falling on day_of_week — four or five
 *   rows, which is the point (a weekly paycheck is not "one a month").
 */
export function dueDatesInMonth(pattern: RecurringPattern, month: string): string[] {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const monthIndex0 = Number(month.slice(5, 7)) - 1;
  const length = daysInMonth(year, monthIndex0);

  if (pattern.frequency === "weekly") {
    if (pattern.day_of_week === null) return [];
    const dates: string[] = [];
    for (let day = 1; day <= length; day++) {
      if (new Date(Date.UTC(year, monthIndex0, day)).getUTCDay() === pattern.day_of_week) {
        dates.push(isoDate(year, monthIndex0, day));
      }
    }
    return dates;
  }

  const days = [pattern.day_of_month];
  if (pattern.frequency === "semimonthly" && pattern.day_of_month_2 !== null) days.push(pattern.day_of_month_2);
  const clamped = [...new Set(days.map((d) => Math.min(Math.max(d, 1), length)))].sort((a, b) => a - b);
  return clamped.map((d) => isoDate(year, monthIndex0, d));
}

/** What an occurrence should show. Once a transaction has matched, what
 * it actually cost is the answer, whatever was projected or overridden
 * beforehand. Before that, a one-month override wins, then the amount
 * captured when it was generated, then the series' expected amount. Null
 * means "no figure yet" — the UI shows a dash rather than $0.00, which
 * would read as a real, zero-dollar bill. */
export function resolveOccurrenceAmountCents(
  occurrence: Pick<SeriesOccurrence, "amount_cents" | "amount_override_cents"> & Partial<Pick<SeriesOccurrence, "status">>,
  pattern: Pick<RecurringPattern, "expected_amount_cents"> | undefined,
): number | null {
  if (occurrence.status === "matched" && occurrence.amount_cents !== null) return occurrence.amount_cents;
  if (occurrence.amount_override_cents !== null) return occurrence.amount_override_cents;
  if (occurrence.amount_cents !== null) return occurrence.amount_cents;
  return pattern?.expected_amount_cents ?? null;
}

async function listOccurrenceRows(db: D1Database, householdId: string, month: string): Promise<SeriesOccurrence[]> {
  const { results } = await db
    .prepare(`SELECT * FROM series_occurrence WHERE household_id = ? AND month = ? ORDER BY due_date, id`)
    .bind(householdId, month)
    .all<SeriesOccurrence>();
  return results;
}

/** Which (pattern, scheduled_date) pairs already exist for the month.
 * Keyed on scheduled_date, not due_date, so an occurrence someone moved to
 * a different day still counts as generated. A moved occurrence can leave
 * its month, so this reads by scheduled_date's month rather than the
 * stored `month` column. */
async function listScheduledDates(db: D1Database, householdId: string, month: string): Promise<{ pattern_id: string; scheduled_date: string }[]> {
  const { results } = await db
    .prepare(`SELECT pattern_id, scheduled_date FROM series_occurrence WHERE household_id = ? AND scheduled_date LIKE ?`)
    .bind(householdId, `${month}-%`)
    .all<{ pattern_id: string; scheduled_date: string }>();
  return results;
}

/** Confirmed, categorized, not-yet-ended series — the only ones worth
 * projecting. A series ended mid-month still projects the occurrences
 * that fall on or before its end date. */
async function listProjectablePatterns(db: D1Database, householdId: string): Promise<RecurringPattern[]> {
  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE household_id = ? AND status = 'confirmed' AND category_id IS NOT NULL`)
    .bind(householdId)
    .all<RecurringPattern>();
  return results;
}

/**
 * Materialize every occurrence of every confirmed series in `month`.
 *
 * Idempotent by construction: an occurrence already stored for a
 * (pattern, due_date) is left exactly as it is — overrides, skips, and
 * matches all survive a regeneration, and only genuinely new due dates are
 * inserted. Safe to call on every page load.
 */
export async function generateOccurrences(db: D1Database, householdId: string, month: string): Promise<SeriesOccurrence[]> {
  assertMonth(month);
  const [patterns, existing] = await Promise.all([listProjectablePatterns(db, householdId), listScheduledDates(db, householdId, month)]);
  const existingKeys = new Set(existing.map((o) => `${o.pattern_id}::${o.scheduled_date}`));
  const now = nowIso();

  const inserts: D1PreparedStatement[] = [];
  const created: SeriesOccurrence[] = [];
  for (const pattern of patterns) {
    for (const scheduledDate of dueDatesInMonth(pattern, month)) {
      // A series that ended on the 10th shouldn't sprout an occurrence on
      // the 20th, but the one it already had on the 4th stays.
      if (pattern.ended_at && scheduledDate > pattern.ended_at.slice(0, 10)) continue;
      if (existingKeys.has(`${pattern.id}::${scheduledDate}`)) continue;
      const row: SeriesOccurrence = {
        id: newId("socc"),
        household_id: householdId,
        pattern_id: pattern.id,
        month,
        scheduled_date: scheduledDate,
        due_date: scheduledDate,
        amount_cents: pattern.expected_amount_cents,
        amount_override_cents: null,
        status: "upcoming",
        matched_transaction_id: null,
        unlinked_transaction_id: null,
        created_at: now,
        updated_at: now,
      };
      inserts.push(
        db
          .prepare(
            `INSERT INTO series_occurrence (id, household_id, pattern_id, month, scheduled_date, due_date, amount_cents, amount_override_cents, status, matched_transaction_id, unlinked_transaction_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'upcoming', NULL, NULL, ?, ?)`,
          )
          .bind(row.id, householdId, pattern.id, month, scheduledDate, scheduledDate, row.amount_cents, now, now),
      );
      created.push(row);
    }
  }
  if (inserts.length > 0) await db.batch(inserts);
  return created;
}

interface MatchableTransaction {
  id: string;
  category_id: string | null;
  posted_at: string;
  amount_cents: number;
}

/**
 * Point each occurrence at the transaction that actually paid it.
 *
 * Matching is by category (the series' category, which is what the
 * categorization pipeline already files a matched merchant under) and
 * proximity of the posted date to the due date, within the series'
 * day_tolerance. Both sides are consumed greedily nearest-first, so a
 * twice-monthly series with two deposits doesn't hang both of them on the
 * same occurrence — and a transaction already claimed by another
 * occurrence is never double-counted.
 *
 * Skipped occurrences are left alone (a skip is a deliberate "this one
 * isn't happening"), and an occurrence whose matched transaction has since
 * been deleted or recategorized falls back to 'upcoming'.
 */
export async function reconcileOccurrences(db: D1Database, householdId: string, month: string): Promise<SeriesOccurrence[]> {
  assertMonth(month);
  const [occurrences, patterns, { results: transactions }] = await Promise.all([
    listOccurrenceRows(db, householdId, month),
    listProjectablePatterns(db, householdId),
    db
      .prepare(
        `SELECT id, category_id, posted_at, amount_cents FROM "transaction"
           WHERE household_id = ? AND posted_at LIKE ? AND is_transfer = 0 AND split_parent_id IS NULL`,
      )
      .bind(householdId, `${month}-%`)
      .all<MatchableTransaction>(),
  ]);
  const patternById = new Map(patterns.map((p) => [p.id, p]));

  // Candidate pairs across every (occurrence, transaction) that share a
  // category and fall within tolerance, then taken nearest-first so the
  // closest pairing wins regardless of iteration order.
  interface Candidate {
    occurrence: SeriesOccurrence;
    transaction: MatchableTransaction;
    distance: number;
  }
  const candidates: Candidate[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.status === "skipped") continue;
    const pattern = patternById.get(occurrence.pattern_id);
    if (!pattern) continue;
    for (const transaction of transactions) {
      if (transaction.category_id !== pattern.category_id) continue;
      // A pair a person pulled apart by hand stays apart.
      if (occurrence.unlinked_transaction_id === transaction.id) continue;
      const distance = daysBetween(transaction.posted_at, occurrence.due_date);
      if (distance > pattern.day_tolerance) continue;
      candidates.push({ occurrence, transaction, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.occurrence.due_date.localeCompare(b.occurrence.due_date));

  const claimedTransactions = new Set<string>();
  const matchedOccurrences = new Map<string, MatchableTransaction>();
  for (const { occurrence, transaction } of candidates) {
    if (claimedTransactions.has(transaction.id) || matchedOccurrences.has(occurrence.id)) continue;
    claimedTransactions.add(transaction.id);
    matchedOccurrences.set(occurrence.id, transaction);
  }

  const now = nowIso();
  const writes: D1PreparedStatement[] = [];
  const updated: SeriesOccurrence[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.status === "skipped") {
      updated.push(occurrence);
      continue;
    }
    const match = matchedOccurrences.get(occurrence.id) ?? null;
    const nextStatus = match ? "matched" : "upcoming";
    const nextTransactionId = match?.id ?? null;
    // The matched transaction is the truth about what this occurrence
    // cost, so its magnitude replaces the projection once it posts.
    const nextAmount = match ? Math.abs(match.amount_cents) : occurrence.amount_cents;
    if (occurrence.status === nextStatus && occurrence.matched_transaction_id === nextTransactionId && occurrence.amount_cents === nextAmount) {
      updated.push(occurrence);
      continue;
    }
    writes.push(
      db
        .prepare(`UPDATE series_occurrence SET status = ?, matched_transaction_id = ?, amount_cents = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
        .bind(nextStatus, nextTransactionId, nextAmount, now, occurrence.id, householdId),
    );
    updated.push({ ...occurrence, status: nextStatus, matched_transaction_id: nextTransactionId, amount_cents: nextAmount, updated_at: now });
  }
  if (writes.length > 0) await db.batch(writes);
  return updated;
}

/** Generate, reconcile, and hand back the month's occurrences — what every
 * read of the Spending Plan does, in one call. */
export async function syncOccurrences(db: D1Database, householdId: string, month: string): Promise<SeriesOccurrence[]> {
  await generateOccurrences(db, householdId, month);
  return reconcileOccurrences(db, householdId, month);
}

export async function getOccurrence(db: D1Database, householdId: string, id: string): Promise<SeriesOccurrence | null> {
  return db.prepare(`SELECT * FROM series_occurrence WHERE id = ? AND household_id = ?`).bind(id, householdId).first<SeriesOccurrence>();
}

/**
 * A single occurrence's own edits: this month's amount, a moved due date,
 * or skipping/un-skipping it. None of these touch the series — that's the
 * whole reason occurrences are stored rows.
 */
export async function updateOccurrence(
  db: D1Database,
  householdId: string,
  id: string,
  input: { amountOverrideCents?: number | null; dueDate?: string; status?: "upcoming" | "skipped" },
): Promise<SeriesOccurrence> {
  const existing = await getOccurrence(db, householdId, id);
  if (!existing) throw new Error(`series_occurrence ${id} not found`);

  const amountOverrideCents = "amountOverrideCents" in input ? (input.amountOverrideCents ?? null) : existing.amount_override_cents;
  const dueDate = input.dueDate ?? existing.due_date;
  const month = dueDate.slice(0, 7);
  // Un-skipping returns the occurrence to 'upcoming'; the next reconcile
  // decides whether it's actually matched. A matched occurrence keeps its
  // match unless the caller explicitly skips it.
  const status = input.status ?? (existing.status === "skipped" ? "skipped" : existing.status);
  const matchedTransactionId = status === "skipped" ? null : existing.matched_transaction_id;
  const now = nowIso();

  await db
    .prepare(
      `UPDATE series_occurrence SET amount_override_cents = ?, due_date = ?, month = ?, status = ?, matched_transaction_id = ?, updated_at = ?
         WHERE id = ? AND household_id = ?`,
    )
    .bind(amountOverrideCents, dueDate, month, status, matchedTransactionId, now, id, householdId)
    .run();
  // scheduled_date deliberately untouched — it is what regeneration keys
  // off, and moving an occurrence must not make it look ungenerated.

  return { ...existing, amount_override_cents: amountOverrideCents, due_date: dueDate, month, status, matched_transaction_id: matchedTransactionId, updated_at: now };
}

/**
 * "Unlink transaction" — detach the posted transaction from its occurrence
 * without deleting either. The occurrence goes back to 'upcoming', the
 * transaction is left alone, and the pair is remembered in
 * unlinked_transaction_id so the next reconcile doesn't immediately put
 * them back together.
 */
export async function unlinkOccurrence(db: D1Database, householdId: string, id: string): Promise<SeriesOccurrence> {
  const existing = await getOccurrence(db, householdId, id);
  if (!existing) throw new Error(`series_occurrence ${id} not found`);
  const now = nowIso();
  const unlinked = existing.matched_transaction_id;
  await db
    .prepare(
      `UPDATE series_occurrence SET status = 'upcoming', matched_transaction_id = NULL, unlinked_transaction_id = ?, updated_at = ?
         WHERE id = ? AND household_id = ?`,
    )
    .bind(unlinked, now, id, householdId)
    .run();
  return { ...existing, status: "upcoming", matched_transaction_id: null, unlinked_transaction_id: unlinked, updated_at: now };
}

/**
 * Bring a series' still-upcoming occurrences back in line with the series
 * after it has been edited.
 *
 * Generation copies the expected amount into each row and only ever
 * inserts, so without this an edited amount never reaches the squares
 * already on the calendar, and a moved day leaves the old square behind
 * next to the new one. From the current month forward, an untouched
 * upcoming row (no override, not moved by hand) is deleted when its date
 * is no longer on the schedule and re-seeded with the new expected amount
 * when it is; a row someone edited by hand keeps its edits but still
 * picks up the new amount underneath any override. Matched and skipped
 * rows are history and are left exactly as they are. The next read of the
 * month generates whatever new dates the schedule now calls for.
 */
export async function realignOccurrences(
  db: D1Database,
  householdId: string,
  pattern: RecurringPattern,
  fromMonth: string = nowIso().slice(0, 7),
): Promise<{ removed: number; reseeded: number }> {
  assertMonth(fromMonth);
  const { results } = await db
    .prepare(
      `SELECT * FROM series_occurrence WHERE household_id = ? AND pattern_id = ? AND status = 'upcoming' AND scheduled_date >= ?`,
    )
    .bind(householdId, pattern.id, `${fromMonth}-01`)
    .all<SeriesOccurrence>();

  const onSchedule = new Map<string, Set<string>>();
  function stillScheduled(scheduledDate: string): boolean {
    if (pattern.status !== "confirmed" || pattern.category_id === null) return false;
    if (pattern.ended_at && scheduledDate > pattern.ended_at.slice(0, 10)) return false;
    const month = scheduledDate.slice(0, 7);
    let dates = onSchedule.get(month);
    if (!dates) {
      dates = new Set(dueDatesInMonth(pattern, month));
      onSchedule.set(month, dates);
    }
    return dates.has(scheduledDate);
  }

  const now = nowIso();
  const writes: D1PreparedStatement[] = [];
  let removed = 0;
  let reseeded = 0;
  for (const occurrence of results) {
    const touched = occurrence.amount_override_cents !== null || occurrence.due_date !== occurrence.scheduled_date;
    if (!touched && !stillScheduled(occurrence.scheduled_date)) {
      writes.push(db.prepare(`DELETE FROM series_occurrence WHERE id = ? AND household_id = ?`).bind(occurrence.id, householdId));
      removed++;
      continue;
    }
    if (occurrence.amount_cents !== pattern.expected_amount_cents) {
      writes.push(
        db
          .prepare(`UPDATE series_occurrence SET amount_cents = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
          .bind(pattern.expected_amount_cents, now, occurrence.id, householdId),
      );
      reseeded++;
    }
  }
  if (writes.length > 0) await db.batch(writes);
  return { removed, reseeded };
}

/** Every occurrence in the month, after a sync. */
export async function listOccurrences(db: D1Database, householdId: string, month: string): Promise<SeriesOccurrence[]> {
  return syncOccurrences(db, householdId, month);
}
