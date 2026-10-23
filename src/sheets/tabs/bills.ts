import { listCategories } from "../../db/categories";
import { listRecurringPatterns } from "../../db/recurringPatterns";
import { getTransaction } from "../../db/transactions";
import { listOccurrences, resolveOccurrenceAmountCents } from "../../envelopes/occurrences";
import { centsToDollars, isBlank, parseDate, parseIntCell, parseMoneyDollars, parseWeekday, text, WEEKDAYS } from "../cells";
import type { CellValue } from "../client";
import { changed, runSheetTool, SheetEditError, withSync, type ChangedCell, type SheetRow, type TabSpec } from "../layout";

/**
 * Recurring bills and paychecks, in two tabs because they're two different
 * edits (src/messaging/seriesTools.ts):
 *
 *  - Bills: the series. "Rocky Mountain Power, around the 12th, ~$180."
 *    Changing a row changes every month from now on.
 *  - Bills This Month: this month's instance of each. Changing a row
 *    changes only this month ("the power bill is $240 this month").
 */

const STATUSES = ["suggested", "confirmed", "ended", "dismissed", "delete"];

export const billsTab: TabSpec = {
  name: "Bills",
  headerRow: 1,
  allowsCreate: true,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "merchant", header: "Merchant contains", type: "text", editable: true, width: 190, note: "Text matched against the merchant name, e.g. XFINITY." },
    { key: "kind", header: "Kind", type: "choice", editable: false, createOnly: true, options: ["expense", "income"], width: 90, note: "expense = bill, income = paycheck." },
    { key: "category", header: "Category", type: "text", editable: true, dropdown: "categories", width: 170 },
    { key: "frequency", header: "Frequency", type: "choice", editable: true, options: ["monthly", "semimonthly", "weekly"], width: 110 },
    { key: "day", header: "Day of month", type: "int", editable: true, width: 100, note: "1-31. For monthly and semimonthly." },
    { key: "day2", header: "2nd day", type: "int", editable: true, width: 80, note: "The second day, for semimonthly (e.g. paid the 1st and 15th)." },
    { key: "weekday", header: "Weekday", type: "choice", editable: true, options: WEEKDAYS, width: 100, note: "For weekly." },
    { key: "amount", header: "Usual amount", type: "money", editable: true, width: 110, note: "As a positive number." },
    {
      key: "status",
      header: "Status",
      type: "choice",
      editable: true,
      options: STATUSES,
      width: 110,
      note: "suggested → confirmed to accept one the app noticed, or dismissed to stop it. confirmed → ended when a bill stops (keeps history). delete removes one added by mistake.",
    },
  ]),

  async render(ctx) {
    const [patterns, categories] = await Promise.all([listRecurringPatterns(ctx.env.DB, ctx.householdId), listCategories(ctx.env.DB, ctx.householdId)]);
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const statusOrder = (p: (typeof patterns)[number]) => (p.status === "suggested" ? 1 : p.ended_at ? 2 : 0);
    return patterns
      .filter((p) => p.status !== "dismissed")
      .sort((a, b) => statusOrder(a) - statusOrder(b) || a.kind.localeCompare(b.kind) || a.day_of_month - b.day_of_month)
      .map((p) => ({
        id: p.id,
        cells: {
          id: p.id,
          merchant: p.merchant_pattern,
          kind: p.kind,
          category: p.category_id ? (categoryName.get(p.category_id) ?? "") : "",
          frequency: p.frequency,
          day: p.frequency === "weekly" ? null : p.day_of_month,
          day2: p.day_of_month_2,
          weekday: p.day_of_week === null ? "" : WEEKDAYS[p.day_of_week]!,
          amount: centsToDollars(p.expected_amount_cents),
          status: p.ended_at ? "ended" : p.status,
        },
      }));
  },

  async applyEdit(ctx, id, changes, row) {
    const status = changed(changes, "status");
    const to = status ? text(status.value).toLowerCase() : null;
    if (to === "delete") {
      await runSheetTool(ctx, "delete_recurring_series", { series: id, confirmed: true });
      return;
    }
    if (to === "dismissed") {
      if (status!.before !== "suggested") throw new SheetEditError("Only a suggested bill can be dismissed — set it to ended instead");
      await runSheetTool(ctx, "review_suggested_series", { series: id, accept: false });
      return;
    }

    const update: Record<string, unknown> = {};
    const merchant = changed(changes, "merchant");
    if (merchant) {
      if (isBlank(merchant.value)) throw new SheetEditError("Merchant can't be blank");
      update.merchant_contains = text(merchant.value);
    }
    const category = changed(changes, "category");
    if (category && !isBlank(category.value)) {
      const accepting = to === "confirmed" && status!.before === "suggested";
      if (!accepting && changes.length > 0 && rowStatusBefore(changes, row) === "suggested") {
        throw new SheetEditError("Set Status to confirmed to accept this bill with that category");
      }
      if (!accepting) update.category = text(category.value);
    }
    Object.assign(update, scheduleChanges(changes));
    const amount = changed(changes, "amount");
    if (amount) {
      const dollars = parseMoneyDollars(amount.value);
      if (dollars === null) throw new SheetEditError("Usual amount needs a number (it can't be cleared, only changed)");
      update.expected_amount_dollars = Math.abs(dollars);
    }
    if (Object.keys(update).length > 0) await runSheetTool(ctx, "update_recurring_series", { series: id, ...update });

    if (to === "confirmed" && status!.before === "suggested") {
      await runSheetTool(ctx, "review_suggested_series", { series: id, accept: true, ...(isBlank(row.category) ? {} : { category: text(row.category) }) });
    } else if (to === "ended" && status!.before !== "ended") {
      await runSheetTool(ctx, "end_recurring_series", { series: id, confirmed: true });
    } else if (to !== null && to !== status!.before) {
      throw new SheetEditError(`Can't go from ${status!.before} to ${to} — add it again as a new row instead`);
    }
  },

  async applyCreate(ctx, row) {
    const merchant = text(row.merchant);
    if (!merchant || isBlank(row.category)) throw new SheetEditError("To add a bill, fill in Merchant contains and Category");
    const kind = isBlank(row.kind) ? "expense" : text(row.kind).toLowerCase();
    const amount = parseMoneyDollars(row.amount);
    await runSheetTool(ctx, "create_recurring_series", {
      merchant_contains: merchant,
      kind,
      category: text(row.category),
      frequency: isBlank(row.frequency) ? "monthly" : text(row.frequency).toLowerCase(),
      ...scheduleFromRow(row),
      ...(amount === null ? {} : { expected_amount_dollars: Math.abs(amount) }),
    });
  },
};

/** The row's status as the app last wrote it — from the change if Status
 * was edited, else from the cell (which then still holds it). */
function rowStatusBefore(changes: ChangedCell[], row: SheetRow): string {
  return changed(changes, "status")?.before ?? text(row.status).toLowerCase();
}

function scheduleChanges(changes: ChangedCell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const frequency = changed(changes, "frequency");
  if (frequency) out.frequency = text(frequency.value).toLowerCase();
  const day = changed(changes, "day");
  if (day) out.day_of_month = intOrThrow(day.value, "Day of month");
  const day2 = changed(changes, "day2");
  if (day2) out.second_day_of_month = intOrThrow(day2.value, "2nd day");
  const weekday = changed(changes, "weekday");
  if (weekday) {
    const index = parseWeekday(weekday.value);
    if (index === null) throw new SheetEditError("Weekday is a day name, like Friday");
    out.day_of_week = index;
  }
  return out;
}

function scheduleFromRow(row: SheetRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const day = parseIntCell(row.day);
  if (day !== null) out.day_of_month = day;
  const day2 = parseIntCell(row.day2);
  if (day2 !== null) out.second_day_of_month = day2;
  const weekday = parseWeekday(row.weekday);
  if (weekday !== null) out.day_of_week = weekday;
  return out;
}

function intOrThrow(value: CellValue, label: string): number {
  const n = parseIntCell(value);
  if (n === null) throw new SheetEditError(`${label} needs a whole number`);
  return n;
}

export const billsThisMonthTab: TabSpec = {
  name: "Bills This Month",
  headerRow: 1,
  allowsCreate: false,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "due", header: "Due", type: "date", editable: true, width: 100, note: "Move this month's due date without changing the series." },
    { key: "merchant", header: "Bill", type: "text", editable: false, width: 190 },
    { key: "kind", header: "Kind", type: "text", editable: false, width: 80 },
    { key: "category", header: "Category", type: "text", editable: false, width: 160 },
    { key: "amount", header: "Amount", type: "money", editable: true, width: 100, note: "This month only. Clear it to go back to the usual amount." },
    { key: "status", header: "Status", type: "choice", editable: true, options: ["upcoming", "skipped", "matched"], width: 100, note: "skipped = not happening this month." },
    { key: "matched", header: "Matched charge", type: "text", editable: false, width: 220 },
  ]),

  async render(ctx) {
    const [occurrences, patterns, categories] = await Promise.all([
      listOccurrences(ctx.env.DB, ctx.householdId, ctx.month),
      listRecurringPatterns(ctx.env.DB, ctx.householdId),
      listCategories(ctx.env.DB, ctx.householdId),
    ]);
    const patternById = new Map(patterns.map((p) => [p.id, p]));
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const rows = [];
    for (const o of occurrences.slice().sort((a, b) => a.due_date.localeCompare(b.due_date))) {
      const pattern = patternById.get(o.pattern_id);
      let matched = "";
      if (o.matched_transaction_id) {
        try {
          const t = await getTransaction(ctx.env.DB, ctx.householdId, o.matched_transaction_id);
          matched = `${t.posted_at.slice(0, 10)} ${t.normalized_merchant ?? t.raw_description} ${(t.amount_cents / 100).toFixed(2)}`;
        } catch {
          matched = "";
        }
      }
      rows.push({
        id: o.id,
        cells: {
          id: o.id,
          due: o.due_date,
          merchant: pattern?.merchant_pattern ?? "?",
          kind: pattern?.kind ?? "",
          category: pattern?.category_id ? (categoryName.get(pattern.category_id) ?? "") : "",
          amount: centsToDollars(resolveOccurrenceAmountCents(o, pattern)),
          status: o.status,
          matched,
        },
      });
    }
    return rows;
  },

  async applyEdit(ctx, id, changes) {
    const patch: Record<string, unknown> = {};
    const due = changed(changes, "due");
    if (due) {
      const date = parseDate(due.value);
      if (!date) throw new SheetEditError(`'${text(due.value)}' isn't a date — use 2026-10-05`);
      patch.due_date = date;
    }
    const amount = changed(changes, "amount");
    if (amount) {
      if (isBlank(amount.value)) patch.clear_amount_override = true;
      else {
        const dollars = parseMoneyDollars(amount.value);
        if (dollars === null) throw new SheetEditError(`'${text(amount.value)}' isn't an amount`);
        patch.amount_dollars = Math.abs(dollars);
      }
    }
    const status = changed(changes, "status");
    if (status) {
      const to = text(status.value).toLowerCase();
      if (to === "skipped") patch.skip = true;
      else if (to === "upcoming") patch.skip = false;
      else throw new SheetEditError("Status can be set to upcoming or skipped — matched is set when the charge lands");
    }
    if (Object.keys(patch).length > 0) await runSheetTool(ctx, "update_bill_occurrence", { occurrence_id: id, ...patch });
  },
};
