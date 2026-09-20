import { listCategories, unarchiveCategory } from "../db/categories";
import {
  allocateToEnvelope,
  applyRolloverResets,
  fundEnvelopesToTarget,
  getEnvelopeMonthSummariesForHousehold,
  listEnvelopes,
  previousMonth,
  updateEnvelope,
} from "../db/envelopes";
import { unarchiveEnvelopeForCategory } from "../db/envelopes";
import { applyCategorization, listTransactions } from "../db/transactions";
import { archiveCategory } from "../db/categories";
import { archiveEnvelopeForCategory } from "../db/envelopes";
import {
  AgentToolError,
  arr,
  bool,
  envelopeUndoEntry,
  formatDollars,
  monthArg,
  num,
  required,
  requireConfirmation,
  resolveCategory,
  resolveEnvelope,
  str,
  toCents,
  toDollars,
  type AgentTool,
} from "./agentToolKit";
import type { UndoEnvelope } from "./undo";

/**
 * Writing the plan itself: what a month is funded to, what carries into
 * it, what every envelope targets from now on, and the tidying-up
 * (unarchive, merge) that a plan accumulates over time.
 *
 * The distinction this file exists to make honest is the one a text
 * message makes casually and the data model does not:
 *
 *   "make groceries $250 a month"  → the envelope's monthly target
 *   "make groceries $250 this month" → this month's funding, once
 *
 * The first is `update_spending_plan` (agentTools.ts). The second is
 * `set_month_budget` here, which books the difference as an allocation
 * rather than rewriting the plan — and can, in the same breath, fix what
 * carried in ("...starting from zero on the 1st"), because that is the
 * other half of what people mean when they say a month should be $250.
 */

/** What a month currently holds for one envelope, after any rollover
 * reset has been applied. Every funding tool starts here, because a
 * text-message amount is a destination ("make it $250"), not a delta, and
 * the delta can only be computed against something real. */
async function monthState(env: Parameters<AgentTool["run"]>[0], householdId: string, envelopeId: string, month: string) {
  await applyRolloverResets(env.DB, householdId, month);
  const summaries = await getEnvelopeMonthSummariesForHousehold(env.DB, householdId, month);
  const summary = summaries[envelopeId];
  if (!summary) throw new AgentToolError("that envelope has no summary for that month");
  return summary;
}

const setMonthBudget: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "set_month_budget",
    description:
      "Set what one envelope has to spend in a single month, without changing the plan for other months. Optionally also set what carried in from last month ('with $0 rolled over on the 1st' = opening_rollover_dollars: 0). Both are booked as ledger entries, so they show up as real funding and can be undone. Use update_spending_plan instead when they mean every month from now on; use both when they say 'make it $250 from now on, starting this month'.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The envelope's category, by name or id." },
        amount_dollars: { type: "number", description: "What this envelope should have to spend this month, in total." },
        month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." },
        opening_rollover_dollars: {
          type: "number",
          description: "What should have carried in from last month. 0 means the month starts fresh. Omit to leave whatever carried in alone.",
        },
        also_set_monthly_target: {
          type: "boolean",
          description: "True when they mean this to be the plan from now on too, not just this month.",
        },
      },
      required: ["category", "amount_dollars"],
    },
  },
  async run(env, ctx, input) {
    const amount = num(input, "amount_dollars");
    if (amount === null) throw new AgentToolError("'amount_dollars' is required and must be a number");
    const month = monthArg(input);
    const { category, envelope } = await resolveEnvelope(env, ctx.householdId, required(input, "category"));

    const undoSteps: UndoEnvelope[] = [];

    // Opening rollover first: it lands in the previous month, so doing it
    // before the funding delta keeps the delta computed against the
    // opening figure the person actually asked for.
    const openingDollars = num(input, "opening_rollover_dollars");
    if (openingDollars !== null) {
      const before = await monthState(env, ctx.householdId, envelope.id, month);
      const desiredOpening = toCents(openingDollars);
      const correction = desiredOpening - before.carriedInCents;
      if (correction !== 0) {
        const priorMonth = previousMonth(month);
        await allocateToEnvelope(env.DB, ctx.householdId, {
          envelopeId: envelope.id,
          month: priorMonth,
          amountCents: correction,
          source: "correction",
          note: `opening balance for ${month} set to ${formatDollars(desiredOpening)}`,
          createdByUserId: ctx.userId,
        });
        undoSteps.push({ kind: "allocations", entries: [{ envelopeId: envelope.id, month: priorMonth, amountCents: correction }] });
      }
    }

    const state = await monthState(env, ctx.householdId, envelope.id, month);
    const desiredCents = toCents(amount);
    // "$250 to spend this month" means carried-in plus this month's
    // funding come to $250 — not that $250 gets added on top of whatever
    // was already there.
    const delta = desiredCents - state.carriedInCents - state.allocatedCents;
    if (delta !== 0) {
      await allocateToEnvelope(env.DB, ctx.householdId, {
        envelopeId: envelope.id,
        month,
        amountCents: delta,
        source: "correction",
        note: `${category.name} set to ${formatDollars(desiredCents)} for ${month}`,
        createdByUserId: ctx.userId,
      });
      undoSteps.push({ kind: "allocations", entries: [{ envelopeId: envelope.id, month, amountCents: delta }] });
    }

    let monthlyTargetDollars = envelope.monthly_target_cents === null ? null : toDollars(envelope.monthly_target_cents);
    if (bool(input, "also_set_monthly_target")) {
      undoSteps.push({ kind: "envelope_fields", entries: [envelopeUndoEntry(envelope)] });
      const updated = await updateEnvelope(env.DB, ctx.householdId, envelope.id, { monthlyTargetCents: desiredCents });
      monthlyTargetDollars = updated.monthly_target_cents === null ? null : toDollars(updated.monthly_target_cents);
    }

    const after = await monthState(env, ctx.householdId, envelope.id, month);
    ctx.record({
      summary: `set ${category.name} to ${formatDollars(desiredCents)} for ${month}${
        openingDollars !== null ? ` with ${formatDollars(toCents(openingDollars))} carried in` : ""
      }`,
      undo: undoSteps.length === 1 ? undoSteps[0]! : { kind: "composite", steps: undoSteps },
    });

    return {
      category: category.name,
      month,
      budgeted_dollars: toDollars(after.carriedInCents + after.allocatedCents),
      carried_in_dollars: toDollars(after.carriedInCents),
      funded_this_month_dollars: toDollars(after.allocatedCents),
      spent_dollars: toDollars(after.spentCents),
      left_dollars: toDollars(after.balanceCents),
      monthly_target_dollars: monthlyTargetDollars,
    };
  },
};

const setOpeningRollover: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "set_opening_rollover",
    description:
      "Set what an envelope carried into a month from the month before — 'groceries should have started the month at zero', 'leave $100 of last month's gas money'. Books a correction in the prior month so this month's funding figure stays what they budgeted.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        amount_dollars: { type: "number", description: "What should have carried in. 0 starts the month fresh." },
        month: { type: "string", description: "'YYYY-MM' whose opening balance this is. Defaults to the current month." },
      },
      required: ["category", "amount_dollars"],
    },
  },
  async run(env, ctx, input) {
    const amount = num(input, "amount_dollars");
    if (amount === null) throw new AgentToolError("'amount_dollars' is required and must be a number");
    const month = monthArg(input);
    const { category, envelope } = await resolveEnvelope(env, ctx.householdId, required(input, "category"));
    const before = await monthState(env, ctx.householdId, envelope.id, month);
    const desired = toCents(amount);
    const correction = desired - before.carriedInCents;
    if (correction === 0) {
      return { category: category.name, month, carried_in_dollars: toDollars(desired), changed: false };
    }

    const priorMonth = previousMonth(month);
    await allocateToEnvelope(env.DB, ctx.householdId, {
      envelopeId: envelope.id,
      month: priorMonth,
      amountCents: correction,
      source: "correction",
      note: `opening balance for ${month} set to ${formatDollars(desired)}`,
      createdByUserId: ctx.userId,
    });
    const after = await monthState(env, ctx.householdId, envelope.id, month);
    ctx.record({
      summary: `set ${category.name}'s opening balance for ${month} to ${formatDollars(desired)}`,
      undo: { kind: "allocations", entries: [{ envelopeId: envelope.id, month: priorMonth, amountCents: correction }] },
    });
    return {
      category: category.name,
      month,
      changed: true,
      carried_in_dollars: toDollars(after.carriedInCents),
      left_dollars: toDollars(after.balanceCents),
    };
  },
};

const setTargetsInBulk: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "set_targets_in_bulk",
    description:
      "Change the monthly target on several envelopes in one go — 'set all my bills to what they actually cost', 'cut every eating-out category by 20%'. Do the arithmetic yourself and pass final numbers. Tell the person what the totals came to afterwards; don't make them read a list of twenty lines.",
    input_schema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          description: "One entry per envelope being retargeted.",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              monthly_target_dollars: { type: "number" },
              group: { type: "string", description: "Optionally regroup it at the same time." },
            },
            required: ["category", "monthly_target_dollars"],
          },
        },
      },
      required: ["targets"],
    },
  },
  async run(env, ctx, input) {
    const entries = arr(input, "targets") as Record<string, unknown>[];
    if (entries.length === 0) throw new AgentToolError("'targets' must contain at least one envelope");

    const before: ReturnType<typeof envelopeUndoEntry>[] = [];
    const applied: unknown[] = [];
    let totalCents = 0;
    for (const entry of entries) {
      const targetDollars = num(entry, "monthly_target_dollars");
      if (targetDollars === null) throw new AgentToolError(`'monthly_target_dollars' is required for every target (missing on '${str(entry, "category") ?? "?"}')`);
      const { category, envelope } = await resolveEnvelope(env, ctx.householdId, required(entry, "category"));
      before.push(envelopeUndoEntry(envelope));
      const updated = await updateEnvelope(env.DB, ctx.householdId, envelope.id, {
        monthlyTargetCents: toCents(targetDollars),
        ...(str(entry, "group") ? { groupName: str(entry, "group")! } : {}),
      });
      totalCents += updated.monthly_target_cents ?? 0;
      applied.push({ category: category.name, monthly_target_dollars: targetDollars, group: updated.group_name });
    }

    ctx.record({
      summary: `retargeted ${applied.length} ${applied.length === 1 ? "envelope" : "envelopes"} (${formatDollars(totalCents)} a month between them)`,
      undo: { kind: "envelope_fields", entries: before },
    });
    return { updated: applied, combined_monthly_target_dollars: toDollars(totalCents) };
  },
};

const fundMonthFromPlan: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "fund_month_from_plan",
    description:
      "Fund a month according to the plan: bring every envelope with a monthly target up to that target, all at once. This is 'assign my paycheck the usual way' / 'set up October'. Envelopes already at or above their target are left alone unless top_up_only is false.",
    input_schema: {
      type: "object",
      properties: {
        month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Limit to these envelopes. Omit to fund every envelope that has a monthly target.",
        },
        top_up_only: {
          type: "boolean",
          description: "Default true: only add money where the envelope is short. False also takes money back out of envelopes that are over their target.",
        },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const month = monthArg(input);
    const topUpOnly = bool(input, "top_up_only") ?? true;
    const only = (arr(input, "categories") as unknown[]).filter((c): c is string => typeof c === "string");

    const [envelopes, categories] = await Promise.all([listEnvelopes(env.DB, ctx.householdId), listCategories(env.DB, ctx.householdId)]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const envelopeById = new Map(envelopes.map((e) => [e.id, e]));

    const wanted = new Set<string>();
    for (const name of only) wanted.add((await resolveCategory(env, ctx.householdId, name)).id);
    const envelopeIds = wanted.size > 0 ? envelopes.filter((e) => wanted.has(e.category_id)).map((e) => e.id) : undefined;

    // The same funding the dashboard's "Fund to target" does (src/db/envelopes.ts).
    const written = await fundEnvelopesToTarget(env.DB, ctx.householdId, { month, envelopeIds, topUpOnly, createdByUserId: ctx.userId });
    const entries = written.map(({ envelopeId, month: m, amountCents }) => ({ envelopeId, month: m, amountCents }));
    const totalCents = written.reduce((sum, w) => sum + w.amountCents, 0);
    const funded = written.map((w) => ({
      category: categoryById.get(envelopeById.get(w.envelopeId)?.category_id ?? "")?.name ?? "?",
      added_dollars: toDollars(w.amountCents),
      now_available_dollars: toDollars(w.availableAfterCents),
    }));

    if (entries.length === 0) return { month, funded: [], total_dollars: 0, note: "every envelope was already funded to its target" };
    ctx.record({
      summary: `funded ${entries.length} ${entries.length === 1 ? "envelope" : "envelopes"} for ${month} (${formatDollars(totalCents)})`,
      undo: { kind: "allocations", entries },
    });
    return { month, funded, total_dollars: toDollars(totalCents) };
  },
};

const suggestBudgetFromHistory: AgentTool = {
  mutates: false,
  access: "read",
  definition: {
    name: "suggest_budget_from_history",
    description:
      "What each category has actually cost, per month, over the last few months — the numbers to build or sanity-check a budget from. Read-only: it proposes nothing on its own. Pair it with set_targets_in_bulk once the person has agreed to the shape of it.",
    input_schema: {
      type: "object",
      properties: {
        months: { type: "number", description: "How many whole months back to look at. Defaults to 3, max 12." },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const months = Math.min(Math.max(Math.round(num(input, "months") ?? 3), 1), 12);
    const start = new Date();
    start.setMonth(start.getMonth() - months);
    const fromDate = start.toISOString().slice(0, 10);

    const [transactions, categories, envelopes] = await Promise.all([
      listTransactions(env.DB, ctx.householdId, { fromDate, limit: 5000 }),
      listCategories(env.DB, ctx.householdId),
      listEnvelopes(env.DB, ctx.householdId),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const targetByCategory = new Map(envelopes.map((e) => [e.category_id, e.monthly_target_cents]));

    const byCategory = new Map<string, { total: number; months: Set<string> }>();
    for (const t of transactions) {
      if (!t.category_id || t.is_transfer === 1 || t.excluded_from_budget === 1) continue;
      if (t.amount_cents >= 0) continue; // spend only
      const bucket = byCategory.get(t.category_id) ?? { total: 0, months: new Set<string>() };
      bucket.total += -t.amount_cents;
      bucket.months.add(t.posted_at.slice(0, 7));
      byCategory.set(t.category_id, bucket);
    }

    const rows = [...byCategory.entries()]
      .map(([categoryId, bucket]) => ({
        category: categoryById.get(categoryId)?.name ?? "?",
        months_with_spending: bucket.months.size,
        average_monthly_dollars: toDollars(Math.round(bucket.total / months)),
        total_dollars: toDollars(bucket.total),
        current_monthly_target_dollars:
          targetByCategory.get(categoryId) === undefined || targetByCategory.get(categoryId) === null
            ? null
            : toDollars(targetByCategory.get(categoryId)!),
      }))
      .sort((a, b) => b.average_monthly_dollars - a.average_monthly_dollars);

    return { months_examined: months, since: fromDate, categories: rows };
  },
};

const unarchiveCategoryTool: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "unarchive_category",
    description: "Bring a retired category (and its envelope) back into the spending plan, with its history and balance intact.",
    input_schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] },
  },
  async run(env, ctx, input) {
    const category = await resolveCategory(env, ctx.householdId, required(input, "category"));
    if (!category.archived_at) return { category: category.name, changed: false, note: "it was never archived" };
    await unarchiveCategory(env.DB, ctx.householdId, category.id);
    await unarchiveEnvelopeForCategory(env.DB, ctx.householdId, category.id);
    ctx.record({
      summary: `brought ${category.name} back into the plan`,
      undo: { kind: "category_archived", categoryId: category.id, wasArchived: true },
    });
    return { category: category.name, changed: true };
  },
};

const mergeCategories: AgentTool = {
  mutates: true,
  access: "destructive",
  definition: {
    name: "merge_categories",
    description:
      "Fold one category into another: every charge filed under the first is refiled under the second, and the first is archived. Use it for duplicates ('Groceries' and 'Grocery'). This cannot be undone — which charges came from where is gone once it's done — so say that when you confirm it.",
    input_schema: {
      type: "object",
      properties: {
        from_category: { type: "string", description: "The one being folded in and archived." },
        into_category: { type: "string", description: "The one that survives." },
        confirmed: { type: "boolean", description: "True only after the person has agreed, having been told it can't be undone." },
      },
      required: ["from_category", "into_category"],
    },
  },
  async run(env, ctx, input) {
    const from = await resolveCategory(env, ctx.householdId, required(input, "from_category"));
    const into = await resolveCategory(env, ctx.householdId, required(input, "into_category"));
    if (from.id === into.id) throw new AgentToolError("those are the same category");
    if (from.kind !== into.kind) {
      throw new AgentToolError(`'${from.name}' is a ${from.kind} category and '${into.name}' is ${into.kind} — merging across kinds would break the plan's math.`);
    }
    requireConfirmation(input, `merging ${from.name} into ${into.name} (which can't be undone)`);

    const transactions = await listTransactions(env.DB, ctx.householdId, { categoryId: from.id, limit: 5000 });
    for (const transaction of transactions) {
      await applyCategorization(env.DB, ctx.householdId, transaction.id, {
        categoryId: into.id,
        method: "human",
        createdByUserId: ctx.userId,
      });
    }
    await archiveCategory(env.DB, ctx.householdId, from.id);
    await archiveEnvelopeForCategory(env.DB, ctx.householdId, from.id);

    ctx.record({
      summary: `merged ${from.name} into ${into.name} (${transactions.length} ${transactions.length === 1 ? "charge" : "charges"} moved)`,
      undo: { kind: "none", reason: `merging ${from.name} into ${into.name} can't be reversed — which charges came from where isn't recorded anywhere after the merge` },
    });
    return { merged: { from: from.name, into: into.name, transactions_moved: transactions.length } };
  },
};

export const PLAN_TOOLS: AgentTool[] = [
  setMonthBudget,
  setOpeningRollover,
  setTargetsInBulk,
  fundMonthFromPlan,
  suggestBudgetFromHistory,
  unarchiveCategoryTool,
  mergeCategories,
];
