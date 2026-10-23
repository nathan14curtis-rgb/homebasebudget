import { listAccounts } from "../../db/accounts";
import { listCategories } from "../../db/categories";
import { applyRolloverResets, getEnvelopeMonthSummariesForHousehold, listEnvelopes } from "../../db/envelopes";
import { computeReadyToAssign } from "../../envelopes/ledger";
import { centsToDollars, isBlank, parseBool, parseDate, parseMoneyCents, parseMoneyDollars, text } from "../cells";
import type { CellValue } from "../client";
import { afterCreate, changed, runSheetTool, SheetEditError, withSync, type SyncContext, type TabSpec } from "../layout";

/**
 * The envelopes for one month — the tab a person lives in.
 *
 * Row 1 picks the month (type 2026-11 over it) and can fund the whole
 * month to plan in one tick. Below it, one row per envelope: the plan
 * (target, rollover, goal date — every month) and this month's money
 * (carried in, assigned — this month only). Spent and Available are the
 * ledger's answer and can't be typed over.
 */

export const BUDGET_META = {
  monthLabel: 1, // B1
  month: 2, // C1
  fundLabel: 4, // E1
  fund: 5, // F1
  readyLabel: 7, // H1
  ready: 8, // I1
};

export const budgetTab: TabSpec = {
  name: "Budget",
  headerRow: 2,
  allowsCreate: true,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "group", header: "Group", type: "text", editable: true, dropdown: "groups", width: 120 },
    { key: "category", header: "Category", type: "text", editable: true, width: 180, note: "Type over a name to rename it. Add a new envelope on an empty row at the bottom." },
    { key: "target", header: "Monthly target", type: "money", editable: true, width: 120, note: "What you plan to put in every month. Changes the plan from now on." },
    {
      key: "rollover",
      header: "Rollover",
      type: "choice",
      editable: true,
      options: ["carry", "reset"],
      width: 90,
      note: "carry = leftover money stays in the envelope next month. reset = every month starts at zero.",
    },
    { key: "goal_date", header: "Goal date", type: "date", editable: true, width: 100, note: "For savings goals: the date it should be fully funded by." },
    { key: "carried_in", header: "Carried in", type: "money", editable: true, width: 110, note: "What this envelope started the month with. Set it to 0 to start fresh." },
    { key: "assigned", header: "Assigned", type: "money", editable: true, width: 110, note: "Money put in this month. Type the total you want; the difference is booked." },
    { key: "spent", header: "Spent", type: "money", editable: false, width: 100 },
    { key: "available", header: "Available", type: "money", editable: false, width: 110 },
  ]),

  meta: {
    async render(ctx) {
      const ready = await readyToAssignCents(ctx);
      const row: Array<string | number | boolean | null> = ["", "Month", ctx.month, "", "Fund to plan", false, "", "Ready to assign", centsToDollars(ready)];
      return row;
    },
    editable: [
      { index: BUDGET_META.month, type: "text" },
      { index: BUDGET_META.fund, type: "bool" },
    ],
    async apply(ctx, changes) {
      // The month change itself is read by sync.ts (it decides which month
      // the next render shows); only the fund checkbox does work here.
      const fund = changes.find((c) => c.index === BUDGET_META.fund);
      if (fund && parseBool(fund.value)) await runSheetTool(ctx, "fund_month_from_plan", { month: ctx.month });
    },
  },

  async render(ctx) {
    await applyRolloverResets(ctx.env.DB, ctx.householdId, ctx.month);
    const [envelopes, categories, summaries] = await Promise.all([
      listEnvelopes(ctx.env.DB, ctx.householdId),
      listCategories(ctx.env.DB, ctx.householdId),
      getEnvelopeMonthSummariesForHousehold(ctx.env.DB, ctx.householdId, ctx.month),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const groupOrder = new Map<string, number>();
    for (const e of envelopes) if (!groupOrder.has(e.group_name)) groupOrder.set(e.group_name, Math.min(...envelopes.filter((x) => x.group_name === e.group_name).map((x) => x.sort_order)));

    return envelopes
      .filter((e) => !e.archived_at && categoryById.get(e.category_id) && !categoryById.get(e.category_id)!.archived_at)
      .sort((a, b) => (groupOrder.get(a.group_name)! - groupOrder.get(b.group_name)!) || a.group_name.localeCompare(b.group_name) || a.sort_order - b.sort_order)
      .map((e) => {
        const s = summaries[e.id];
        return {
          id: e.category_id,
          cells: {
            id: e.category_id,
            group: e.group_name,
            category: categoryById.get(e.category_id)!.name,
            target: centsToDollars(e.monthly_target_cents),
            rollover: e.rollover_mode,
            goal_date: e.target_date ?? "",
            carried_in: centsToDollars(s?.carriedInCents ?? 0),
            assigned: centsToDollars(s?.allocatedCents ?? 0),
            spent: centsToDollars(s?.spentCents ?? 0),
            available: centsToDollars(s?.balanceCents ?? 0),
          },
        };
      });
  },

  async applyEdit(ctx, id, changes) {
    const name = changed(changes, "category");
    if (name) {
      if (isBlank(name.value)) throw new SheetEditError("Category name can't be blank — to retire it, tick Archived on the Categories tab");
      await runSheetTool(ctx, "rename_category", { category: id, new_name: text(name.value) });
    }

    const plan: Record<string, unknown> = {};
    const group = changed(changes, "group");
    if (group && !isBlank(group.value)) plan.group = text(group.value);
    const target = changed(changes, "target");
    if (target) {
      if (isBlank(target.value)) plan.clear_monthly_target = true;
      else {
        const dollars = parseMoneyDollars(target.value);
        if (dollars === null) throw new SheetEditError(`'${text(target.value)}' isn't an amount`);
        plan.monthly_target_dollars = dollars;
      }
    }
    const rollover = changed(changes, "rollover");
    if (rollover) {
      const mode = text(rollover.value).toLowerCase();
      if (mode !== "carry" && mode !== "reset") throw new SheetEditError("Rollover is either 'carry' or 'reset'");
      plan.rollover = mode;
    }
    const goal = changed(changes, "goal_date");
    if (goal) {
      if (isBlank(goal.value)) plan.clear_goal_date = true;
      else {
        const date = parseDate(goal.value);
        if (!date) throw new SheetEditError(`'${text(goal.value)}' isn't a date — use 2027-06-01`);
        plan.goal_date = date;
      }
    }
    if (Object.keys(plan).length > 0) await runSheetTool(ctx, "update_spending_plan", { category: id, ...plan });

    const carried = changed(changes, "carried_in");
    if (carried) {
      const dollars = parseMoneyDollars(isBlank(carried.value) ? 0 : carried.value);
      if (dollars === null) throw new SheetEditError(`'${text(carried.value)}' isn't an amount`);
      await runSheetTool(ctx, "set_opening_rollover", { category: id, amount_dollars: dollars, month: ctx.month });
    }

    const assigned = changed(changes, "assigned");
    if (assigned) await setAssigned(ctx, id, assigned.value);
  },

  async applyCreate(ctx, row) {
    const name = text(row.category);
    if (!name) throw new SheetEditError("Give the new envelope a Category name");
    const targetCents = parseMoneyCents(row.target);
    const goalDate = parseDate(row.goal_date);
    const rollover = text(row.rollover).toLowerCase();
    const created = await runSheetTool(ctx, "create_category", {
      name,
      kind: goalDate ? "savings" : "expense",
      ...(isBlank(row.group) ? {} : { group: text(row.group) }),
      ...(targetCents === null ? {} : { monthly_target_dollars: targetCents / 100 }),
      ...(goalDate ? { goal_date: goalDate } : {}),
      ...(rollover === "carry" || rollover === "reset" ? { rollover } : {}),
    });
    const categoryId = String((created.created as { category_id: string }).category_id);
    await afterCreate(categoryId, async () => {
      if (!isBlank(row.carried_in)) {
        const dollars = parseMoneyDollars(row.carried_in);
        if (dollars !== null) await runSheetTool(ctx, "set_opening_rollover", { category: categoryId, amount_dollars: dollars, month: ctx.month });
      }
      if (!isBlank(row.assigned)) await setAssigned(ctx, categoryId, row.assigned ?? null);
    });
  },
};

/** "Assigned" is typed as the total for the month; book the difference. */
async function setAssigned(ctx: SyncContext, categoryId: string, value: CellValue): Promise<void> {
  const wantCents = isBlank(value) ? 0 : parseMoneyCents(value);
  if (wantCents === null) throw new SheetEditError(`'${text(value)}' isn't an amount`);
  const envelopes = await listEnvelopes(ctx.env.DB, ctx.householdId);
  const envelope = envelopes.find((e) => e.category_id === categoryId);
  if (!envelope) throw new SheetEditError("That category has no envelope to put money in");
  const summary = (await getEnvelopeMonthSummariesForHousehold(ctx.env.DB, ctx.householdId, ctx.month))[envelope.id];
  const delta = wantCents - (summary?.allocatedCents ?? 0);
  if (delta === 0) return;
  await runSheetTool(ctx, "assign_money", { category: categoryId, amount_dollars: delta / 100, month: ctx.month, note: "set from the sheet" });
}

/** Cash in the bank, less what's owed on cards, less what's already in
 * envelopes (src/envelopes/ledger.ts). Uses the banks' last-reported
 * balances, so it's as fresh as the last Plaid sync. */
async function readyToAssignCents(ctx: SyncContext): Promise<number> {
  const [accounts, envelopes, summaries] = await Promise.all([
    listAccounts(ctx.env.DB, ctx.householdId),
    listEnvelopes(ctx.env.DB, ctx.householdId),
    getEnvelopeMonthSummariesForHousehold(ctx.env.DB, ctx.householdId, ctx.month),
  ]);
  const active = accounts.filter((a) => a.status !== "removed" && a.current_balance_cents !== null);
  const depository = active.filter((a) => a.type === "depository_checking" || a.type === "depository_savings").map((a) => a.current_balance_cents!);
  const cards = active.filter((a) => a.type === "credit_card").map((a) => a.current_balance_cents!);
  const balances = envelopes.filter((e) => !e.archived_at).map((e) => summaries[e.id]?.balanceCents ?? 0);
  return computeReadyToAssign(depository, cards, balances);
}
