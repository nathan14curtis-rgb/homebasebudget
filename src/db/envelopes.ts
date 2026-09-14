import { newId } from "../lib/id";
import type { Allocation, AllocationSource, Envelope, RolloverMode } from "../types";
import { getScoped, listScoped, nowIso } from "./client";

export async function listEnvelopes(db: D1Database, householdId: string): Promise<Envelope[]> {
  return listScoped<Envelope>(db, "envelope", householdId, "group_name, sort_order, created_at");
}

export async function getEnvelope(db: D1Database, householdId: string, id: string): Promise<Envelope> {
  return getScoped<Envelope>(db, "envelope", householdId, id);
}

export async function getEnvelopeByCategory(db: D1Database, householdId: string, categoryId: string): Promise<Envelope | null> {
  return db.prepare(`SELECT * FROM envelope WHERE household_id = ? AND category_id = ?`).bind(householdId, categoryId).first<Envelope>();
}

/** Regrouping (e.g. into a "Bills" group_name for the dashboard's Bills
 * view), adjusting the monthly target, and setting/clearing target_date —
 * the things about an envelope itself, as opposed to its category's name,
 * that are worth editing after creation. target_date is what turns a plain
 * expense/savings envelope into a goal-style one (PLAN.md §8.5) after the
 * fact, not just at creation via routes/categories.ts. */
export async function updateEnvelope(
  db: D1Database,
  householdId: string,
  id: string,
  input: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null; rolloverMode?: RolloverMode },
): Promise<Envelope> {
  const existing = await getEnvelope(db, householdId, id);
  const groupName = input.groupName ?? existing.group_name;
  const rolloverMode = input.rolloverMode ?? existing.rollover_mode;
  // Distinguish "omitted" (leave as-is) from "explicitly null" (clear the
  // target) — a plain `?? existing` can't tell those apart.
  const monthlyTargetCents = "monthlyTargetCents" in input ? (input.monthlyTargetCents ?? null) : existing.monthly_target_cents;
  const targetDate = "targetDate" in input ? (input.targetDate ?? null) : existing.target_date;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE envelope SET group_name = ?, monthly_target_cents = ?, target_date = ?, rollover_mode = ?, updated_at = ?
         WHERE id = ? AND household_id = ?`,
    )
    .bind(groupName, monthlyTargetCents, targetDate, rolloverMode, now, id, householdId)
    .run();
  return {
    ...existing,
    group_name: groupName,
    monthly_target_cents: monthlyTargetCents,
    target_date: targetDate,
    rollover_mode: rolloverMode,
    updated_at: now,
  };
}

export async function archiveEnvelopeForCategory(db: D1Database, householdId: string, categoryId: string): Promise<void> {
  await db
    .prepare(`UPDATE envelope SET archived_at = ?, updated_at = ? WHERE household_id = ? AND category_id = ?`)
    .bind(nowIso(), nowIso(), householdId, categoryId)
    .run();
}

export async function unarchiveEnvelopeForCategory(db: D1Database, householdId: string, categoryId: string): Promise<void> {
  await db
    .prepare(`UPDATE envelope SET archived_at = NULL, updated_at = ? WHERE household_id = ? AND category_id = ?`)
    .bind(nowIso(), householdId, categoryId)
    .run();
}

async function insertAllocation(
  db: D1Database,
  householdId: string,
  input: {
    envelopeId: string;
    month: string;
    amountCents: number;
    source: AllocationSource;
    relatedEnvelopeId?: string | null;
    note?: string | null;
    createdByUserId?: string | null;
  },
): Promise<D1PreparedStatement> {
  const id = newId("alc");
  return db
    .prepare(
      `INSERT INTO allocation (id, household_id, envelope_id, month, amount_cents, source, related_envelope_id, note, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      householdId,
      input.envelopeId,
      input.month,
      input.amountCents,
      input.source,
      input.relatedEnvelopeId ?? null,
      input.note ?? null,
      input.createdByUserId ?? null,
      nowIso(),
    );
}

/** Ready to Assign → an envelope. One ledger row (PLAN.md §8.1). */
export async function allocateToEnvelope(
  db: D1Database,
  householdId: string,
  input: {
    envelopeId: string;
    month: string;
    amountCents: number;
    source?: Extract<AllocationSource, "income_assignment" | "correction">;
    note?: string | null;
    createdByUserId?: string | null;
  },
): Promise<void> {
  const stmt = await insertAllocation(db, householdId, {
    ...input,
    source: input.source ?? "income_assignment",
  });
  await stmt.run();
}

/** Move money between two envelopes as one atomic, fully-reversible
 * operation (PLAN.md §8.1): two ledger rows, each pointing at the other. */
export async function moveMoneyBetweenEnvelopes(
  db: D1Database,
  householdId: string,
  input: {
    fromEnvelopeId: string;
    toEnvelopeId: string;
    month: string;
    amountCents: number; // positive magnitude to move
    note?: string | null;
    createdByUserId?: string | null;
  },
): Promise<void> {
  if (input.amountCents <= 0) throw new Error("moveMoneyBetweenEnvelopes amountCents must be positive");

  const debit = await insertAllocation(db, householdId, {
    envelopeId: input.fromEnvelopeId,
    month: input.month,
    amountCents: -input.amountCents,
    source: "envelope_move",
    relatedEnvelopeId: input.toEnvelopeId,
    note: input.note,
    createdByUserId: input.createdByUserId,
  });
  const credit = await insertAllocation(db, householdId, {
    envelopeId: input.toEnvelopeId,
    month: input.month,
    amountCents: input.amountCents,
    source: "envelope_move",
    relatedEnvelopeId: input.fromEnvelopeId,
    note: input.note,
    createdByUserId: input.createdByUserId,
  });
  await db.batch([debit, credit]);
}

export async function listAllocations(
  db: D1Database,
  householdId: string,
  envelopeId: string,
): Promise<Allocation[]> {
  const { results } = await db
    .prepare(`SELECT * FROM allocation WHERE household_id = ? AND envelope_id = ? ORDER BY month, created_at`)
    .bind(householdId, envelopeId)
    .all<Allocation>();
  return results;
}

export interface EnvelopeMonthSummary {
  month: string;
  allocatedCents: number; // this month only
  spentCents: number; // this month only
  balanceCents: number; // cumulative through this month — the number that matters (PLAN.md §9)
  /** What the envelope walked into the month holding: the balance through
   * the end of last month. Derived, not queried — balance = carriedIn +
   * allocated − spent, so this is the same three numbers rearranged. It is
   * the "opening rollover" a person means by "start the month at zero". */
  carriedInCents: number;
}

/** balance(month) = carriedIn + allocated(month) − spent(month), so the
 * opening figure falls straight out of the three the query already
 * computed. One definition, used everywhere rollover is discussed. */
export function carriedInCents(summary: { allocatedCents: number; spentCents: number; balanceCents: number }): number {
  return summary.balanceCents - summary.allocatedCents + summary.spentCents;
}

/** The month before a 'YYYY-MM', which is where a correction that changes
 * what carried *into* a month has to land — putting it in the month itself
 * would show up as this month's funding and make "I budgeted $250" read as
 * something else. */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  return monthIndex === 1 ? `${year - 1}-12` : `${year}-${String(monthIndex - 1).padStart(2, "0")}`;
}

/**
 * Derived, never stored (PLAN.md §3). Because the balance recurrence
 * telescopes to a running sum (src/envelopes/ledger.ts), "through this
 * month" is one aggregate query rather than a month-by-month replay —
 * cheap enough to skip envelope_balance_snapshot until it's proven to
 * matter for a real household's history size.
 */
export async function getEnvelopeMonthSummary(
  db: D1Database,
  householdId: string,
  envelopeId: string,
  month: string,
): Promise<EnvelopeMonthSummary> {
  const envelope = await getEnvelope(db, householdId, envelopeId);

  const [thisMonthAlloc, cumulativeAlloc, thisMonthSpend, cumulativeSpend] = await Promise.all([
    db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM allocation WHERE household_id = ? AND envelope_id = ? AND month = ?`)
      .bind(householdId, envelopeId, month)
      .first<{ total: number }>(),
    db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM allocation WHERE household_id = ? AND envelope_id = ? AND month <= ?`)
      .bind(householdId, envelopeId, month)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM "transaction"
           WHERE household_id = ? AND category_id = ? AND is_transfer = 0 AND excluded_from_budget = 0
             AND strftime('%Y-%m', posted_at) = ?`,
      )
      .bind(householdId, envelope.category_id, month)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM "transaction"
           WHERE household_id = ? AND category_id = ? AND is_transfer = 0 AND excluded_from_budget = 0
             AND strftime('%Y-%m', posted_at) <= ?`,
      )
      .bind(householdId, envelope.category_id, month)
      .first<{ total: number }>(),
  ]);

  const allocatedCents = thisMonthAlloc?.total ?? 0;
  // transaction.amount_cents is negative for spend, so summing it directly
  // and adding (not subtracting) to the allocation total is the balance —
  // see netSpendCents in src/envelopes/ledger.ts for the same identity.
  const spentCents = -(thisMonthSpend?.total ?? 0) || 0;
  const balanceCents = (cumulativeAlloc?.total ?? 0) + (cumulativeSpend?.total ?? 0);

  return { month, allocatedCents, spentCents, balanceCents, carriedInCents: balanceCents - allocatedCents + spentCents };
}

/**
 * Same identity as getEnvelopeMonthSummary, computed for every envelope in
 * the household at once — four GROUP BY queries instead of four-per-envelope.
 * The redesigned Overview page's envelope-fill chart needs every envelope's
 * spend/planned ratio simultaneously, which makes the dashboard's existing
 * per-envelope Promise.all fetch pattern (one HTTP round trip per envelope)
 * meaningfully worse than it already was.
 */
export async function getEnvelopeMonthSummariesForHousehold(
  db: D1Database,
  householdId: string,
  month: string,
): Promise<Record<string, EnvelopeMonthSummary>> {
  const envelopes = await listEnvelopes(db, householdId);

  const [thisMonthAlloc, cumulativeAlloc, thisMonthSpend, cumulativeSpend] = await Promise.all([
    db
      .prepare(
        `SELECT envelope_id, COALESCE(SUM(amount_cents), 0) AS total FROM allocation
           WHERE household_id = ? AND month = ? GROUP BY envelope_id`,
      )
      .bind(householdId, month)
      .all<{ envelope_id: string; total: number }>(),
    db
      .prepare(
        `SELECT envelope_id, COALESCE(SUM(amount_cents), 0) AS total FROM allocation
           WHERE household_id = ? AND month <= ? GROUP BY envelope_id`,
      )
      .bind(householdId, month)
      .all<{ envelope_id: string; total: number }>(),
    db
      .prepare(
        `SELECT e.id AS envelope_id, COALESCE(SUM(t.amount_cents), 0) AS total
           FROM envelope e JOIN "transaction" t ON t.category_id = e.category_id
           WHERE e.household_id = ? AND t.is_transfer = 0 AND t.excluded_from_budget = 0
             AND strftime('%Y-%m', t.posted_at) = ?
           GROUP BY e.id`,
      )
      .bind(householdId, month)
      .all<{ envelope_id: string; total: number }>(),
    db
      .prepare(
        `SELECT e.id AS envelope_id, COALESCE(SUM(t.amount_cents), 0) AS total
           FROM envelope e JOIN "transaction" t ON t.category_id = e.category_id
           WHERE e.household_id = ? AND t.is_transfer = 0 AND t.excluded_from_budget = 0
             AND strftime('%Y-%m', t.posted_at) <= ?
           GROUP BY e.id`,
      )
      .bind(householdId, month)
      .all<{ envelope_id: string; total: number }>(),
  ]);

  const toMap = (rows: { envelope_id: string; total: number }[]) => new Map(rows.map((r) => [r.envelope_id, r.total]));
  const thisMonthAllocByEnv = toMap(thisMonthAlloc.results);
  const cumAllocByEnv = toMap(cumulativeAlloc.results);
  const thisMonthSpendByEnv = toMap(thisMonthSpend.results);
  const cumSpendByEnv = toMap(cumulativeSpend.results);

  const summaries: Record<string, EnvelopeMonthSummary> = {};
  for (const envelope of envelopes) {
    const allocatedCents = thisMonthAllocByEnv.get(envelope.id) ?? 0;
    const spentCents = -(thisMonthSpendByEnv.get(envelope.id) ?? 0) || 0;
    const balanceCents = (cumAllocByEnv.get(envelope.id) ?? 0) + (cumSpendByEnv.get(envelope.id) ?? 0);
    summaries[envelope.id] = {
      month,
      allocatedCents,
      spentCents,
      balanceCents,
      carriedInCents: balanceCents - allocatedCents + spentCents,
    };
  }
  return summaries;
}

/** How a rollover-reset correction is labelled in the ledger. The note is
 * also the idempotency key: one reset per envelope per month, however many
 * times the plan gets read. */
function rolloverResetNote(month: string): string {
  return `rollover-reset:${month}`;
}

/**
 * Zero the opening balance of every envelope set to 'reset' rollover
 * (migration 0011), by writing a correction into the *previous* month
 * equal to minus whatever carried in.
 *
 * Done as a ledger entry rather than a special case in the balance query
 * so that "always regenerable from the ledger" (PLAN.md §3) still holds:
 * the reset is a visible, reversible row, not an invisible rule that makes
 * the stored history stop adding up. Idempotent by note, so calling it on
 * every read of the plan is safe.
 */
export async function applyRolloverResets(db: D1Database, householdId: string, month: string): Promise<string[]> {
  const envelopes = (await listEnvelopes(db, householdId)).filter((e) => !e.archived_at && e.rollover_mode === "reset");
  if (envelopes.length === 0) return [];

  const summaries = await getEnvelopeMonthSummariesForHousehold(db, householdId, month);
  const note = rolloverResetNote(month);
  const prior = previousMonth(month);
  const reset: string[] = [];

  for (const envelope of envelopes) {
    const summary = summaries[envelope.id];
    if (!summary) continue;
    const opening = summary.carriedInCents;
    if (opening === 0) continue;
    const already = await db
      .prepare(`SELECT id FROM allocation WHERE household_id = ? AND envelope_id = ? AND month = ? AND note = ?`)
      .bind(householdId, envelope.id, prior, note)
      .first<{ id: string }>();
    if (already) continue;

    await allocateToEnvelope(db, householdId, {
      envelopeId: envelope.id,
      month: prior,
      amountCents: -opening,
      source: "correction",
      note,
    });
    reset.push(envelope.id);
  }
  return reset;
}
