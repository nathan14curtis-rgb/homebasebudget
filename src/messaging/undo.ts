import { unarchiveCategory, archiveCategory, renameCategory } from "../db/categories";
import { allocateToEnvelope, updateEnvelope } from "../db/envelopes";
import { deleteRecurringPattern, updateRecurringPattern } from "../db/recurringPatterns";
import { deleteRule } from "../db/rules";
import { setTransactionTags } from "../db/tags";
import { clearCategorization, deleteTransaction, updateTransaction } from "../db/transactions";
import { archiveEnvelopeForCategory, unarchiveEnvelopeForCategory } from "../db/envelopes";
import { updateOccurrence } from "../envelopes/occurrences";
import type { Env, RolloverMode } from "../types";

/**
 * Taking back what a text message did.
 *
 * Every mutating agent tool records a before-image (src/db/changeLog.ts)
 * shaped like one of the envelopes below, and this module is the single
 * place that knows how to play one backwards. Two rules:
 *
 *  1. A reversal is a *new* write through the same db helpers, never a
 *     delete of history. Undoing a $250 allocation books −$250; undoing a
 *     rename renames back. The ledger stays the record of what happened,
 *     including the mistake (PLAN.md §3).
 *  2. Anything that can't be honestly reversed records `none` with a
 *     reason, and the agent says so rather than pretending. Merging two
 *     categories is the live example: the "which charge came from where"
 *     information is gone once it's done.
 */

export type UndoEnvelope =
  | { kind: "none"; reason: string }
  | { kind: "composite"; steps: UndoEnvelope[] }
  | { kind: "allocations"; entries: Array<{ envelopeId: string; month: string; amountCents: number }> }
  | {
      kind: "envelope_fields";
      entries: Array<{
        envelopeId: string;
        groupName: string;
        monthlyTargetCents: number | null;
        targetDate: string | null;
        rolloverMode: RolloverMode;
      }>;
    }
  | { kind: "category_renamed"; categoryId: string; name: string }
  | { kind: "category_archived"; categoryId: string; wasArchived: boolean }
  | { kind: "category_created"; categoryId: string }
  | {
      kind: "transactions";
      entries: Array<{
        transactionId: string;
        categoryId: string | null;
        amountCents: number;
        postedAt: string;
        payee: string | null;
        memo: string | null;
        excluded: boolean;
        flagColor: string | null;
      }>;
    }
  | { kind: "transaction_tags"; transactionId: string; tagIds: string[] }
  | { kind: "pattern_created"; patternId: string }
  | {
      kind: "pattern_fields";
      patternId: string;
      merchantPattern: string;
      categoryId: string;
      frequency: "weekly" | "semimonthly" | "monthly";
      dayOfMonth: number;
      dayOfMonth2: number | null;
      dayOfWeek: number | null;
      dayTolerance: number;
      expectedAmountCents: number | null;
      endedAt: string | null;
    }
  | {
      kind: "occurrence_fields";
      occurrenceId: string;
      amountOverrideCents: number | null;
      dueDate: string;
      status: "upcoming" | "skipped";
    }
  | { kind: "rule_created"; ruleId: string }
  | { kind: "split"; parentId: string; childIds: string[] };

export class UndoNotPossibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoNotPossibleError";
  }
}

export function parseUndo(raw: string): UndoEnvelope {
  try {
    const parsed = JSON.parse(raw) as UndoEnvelope;
    if (parsed && typeof parsed === "object" && typeof (parsed as { kind?: unknown }).kind === "string") return parsed;
  } catch {
    // fall through to the same "can't reverse this" answer a bad shape gets
  }
  return { kind: "none", reason: "the change wasn't recorded in a reversible form" };
}

export async function applyUndo(env: Env, householdId: string, undo: UndoEnvelope, userId: string | null): Promise<void> {
  switch (undo.kind) {
    case "none":
      throw new UndoNotPossibleError(undo.reason);

    case "composite":
      // Reverse order: the last thing done is the first thing undone.
      for (const step of [...undo.steps].reverse()) await applyUndo(env, householdId, step, userId);
      return;

    case "allocations":
      for (const entry of undo.entries) {
        await allocateToEnvelope(env.DB, householdId, {
          envelopeId: entry.envelopeId,
          month: entry.month,
          amountCents: -entry.amountCents,
          source: "correction",
          note: "undo",
          createdByUserId: userId,
        });
      }
      return;

    case "envelope_fields":
      for (const entry of undo.entries) {
        await updateEnvelope(env.DB, householdId, entry.envelopeId, {
          groupName: entry.groupName,
          monthlyTargetCents: entry.monthlyTargetCents,
          targetDate: entry.targetDate,
          rolloverMode: entry.rolloverMode,
        });
      }
      return;

    case "category_renamed":
      await renameCategory(env.DB, householdId, undo.categoryId, undo.name);
      return;

    case "category_archived":
      if (undo.wasArchived) {
        await archiveCategory(env.DB, householdId, undo.categoryId);
        await archiveEnvelopeForCategory(env.DB, householdId, undo.categoryId);
      } else {
        await unarchiveCategory(env.DB, householdId, undo.categoryId);
        await unarchiveEnvelopeForCategory(env.DB, householdId, undo.categoryId);
      }
      return;

    case "category_created":
      // Archived, not deleted: anything already filed under it keeps a
      // valid category_id, which a delete would break.
      await archiveCategory(env.DB, householdId, undo.categoryId);
      await archiveEnvelopeForCategory(env.DB, householdId, undo.categoryId);
      return;

    case "transactions":
      for (const entry of undo.entries) {
        await updateTransaction(env.DB, householdId, entry.transactionId, {
          amountCents: entry.amountCents,
          postedAt: entry.postedAt,
          payee: entry.payee ?? "",
          memo: entry.memo,
          excluded: entry.excluded,
          flagColor: entry.flagColor as never,
          ...(entry.categoryId ? { categoryId: entry.categoryId } : {}),
        });
        if (!entry.categoryId) await clearCategorization(env.DB, householdId, entry.transactionId, userId);
      }
      return;

    case "transaction_tags":
      await setTransactionTags(env.DB, householdId, undo.transactionId, { tagIds: undo.tagIds });
      return;

    case "pattern_created":
      await deleteRecurringPattern(env.DB, householdId, undo.patternId);
      return;

    case "pattern_fields":
      await updateRecurringPattern(env.DB, householdId, undo.patternId, {
        merchantPattern: undo.merchantPattern,
        categoryId: undo.categoryId,
        frequency: undo.frequency,
        dayOfMonth: undo.dayOfMonth,
        dayOfMonth2: undo.dayOfMonth2 ?? undefined,
        dayOfWeek: undo.dayOfWeek ?? undefined,
        dayTolerance: undo.dayTolerance,
        expectedAmountCents: undo.expectedAmountCents,
        endedAt: undo.endedAt,
      });
      return;

    case "occurrence_fields":
      await updateOccurrence(env.DB, householdId, undo.occurrenceId, {
        amountOverrideCents: undo.amountOverrideCents,
        dueDate: undo.dueDate,
        status: undo.status,
      });
      return;

    case "rule_created":
      await deleteRule(env.DB, householdId, undo.ruleId);
      return;

    case "split":
      for (const childId of undo.childIds) await deleteTransaction(env.DB, householdId, childId);
      await updateTransaction(env.DB, householdId, undo.parentId, { excluded: false });
      return;

    default: {
      const exhaustive: never = undo;
      throw new UndoNotPossibleError(`unknown undo kind ${JSON.stringify(exhaustive)}`);
    }
  }
}
