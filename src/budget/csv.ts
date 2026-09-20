/**
 * Bulk-editing the budget through a spreadsheet.
 *
 * The file is form-specific: `GET .../budget/csv` writes the household's
 * current plan out in exactly the shape `POST .../budget/csv` reads back,
 * so the workflow is download, edit the cells, upload. One row is one
 * thing the budget knows about — an everyday envelope, a savings goal, a
 * bill, or a paycheck — and a row is matched to what already exists by
 * its type and name, so editing a row updates and a new row creates.
 *
 * Columns (header row is required; order does not matter; extra columns
 * are ignored):
 *
 *   type       envelope | goal | bill | income                (required)
 *   name       the category's name; matched case-insensitively (required)
 *   amount     dollars. envelope: what it gets each month. goal: the total
 *              needed. bill/income: the expected amount. Blank leaves an
 *              existing value alone; "none" clears it.
 *   group      envelope/goal only: the heading it is listed under
 *   frequency  bill/income only: monthly | twice-monthly | weekly
 *   day        bill/income only: day of month (1-31), or the weekday name
 *              for a weekly series
 *   day2       bill/income only: the second day of a twice-monthly series
 *   merchant   bill/income only: text a statement line must contain to be
 *              matched automatically. Blank on a new row means the name.
 *   goal_date  goal only: YYYY-MM-DD to save toward; "none" clears it
 *   rollover   envelope only: carry | reset
 *   action     blank to add or update; "archive" to archive an envelope or
 *              goal, or to end a bill or income series
 *
 * Nothing is written by a preview: the same plan is built for the preview
 * and for the apply, and only the apply executes it.
 */

import { archiveCategory, createCategory, createEnvelopeForCategory, listCategories, syncBillEnvelope, unarchiveCategory } from "../db/categories";
import { listEnvelopes, updateEnvelope } from "../db/envelopes";
import { createConfirmedRecurringPattern, listRecurringPatterns, updateRecurringPattern } from "../db/recurringPatterns";
import { formatCsv, parseCsvWithHeader } from "../lib/csv";
import { nowIso } from "../db/client";
import type { Category, Envelope, RecurringPattern, RecurringPatternFrequency, RolloverMode } from "../types";

export const BUDGET_CSV_HEADER = ["type", "name", "amount", "group", "frequency", "day", "day2", "merchant", "goal_date", "rollover", "action"] as const;

export type BudgetRowType = "envelope" | "goal" | "bill" | "income";
export type BudgetPlanAction = "create" | "update" | "archive" | "unchanged" | "error";

export interface BudgetPlanRow {
  /** 1-based line in the file, counting the header as line 1. */
  line: number;
  type: BudgetRowType | null;
  name: string;
  action: BudgetPlanAction;
  /** Human-readable, one per field that changes. */
  changes: string[];
  error?: string;
}

export interface BudgetPlanSummary {
  rows: BudgetPlanRow[];
  creates: number;
  updates: number;
  archives: number;
  errors: number;
  applied: boolean;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function money(cents: number | null): string {
  return cents === null ? "none" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseType(raw: string): BudgetRowType | null {
  const value = raw.trim().toLowerCase();
  if (value === "envelope" || value === "spending" || value === "expense") return "envelope";
  if (value === "goal" || value === "savings" || value === "saving") return "goal";
  if (value === "bill") return "bill";
  if (value === "income" || value === "paycheck" || value === "deposit") return "income";
  return null;
}

/** "", "none", "$1,234.50" → undefined (leave alone), null (clear), cents. */
function parseAmount(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (value === "none" || value === "clear" || value === "-") return null;
  const numeric = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`amount "${raw}" is not a dollar amount`);
  return Math.round(numeric * 100);
}

function parseFrequency(raw: string): RecurringPatternFrequency | undefined {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (value === "") return undefined;
  if (value === "monthly" || value === "month") return "monthly";
  if (value === "semimonthly" || value === "twicemonthly" || value === "twiceamonth" || value === "biweekly2x") return "semimonthly";
  if (value === "weekly" || value === "week") return "weekly";
  throw new Error(`frequency "${raw}" must be monthly, twice-monthly, or weekly`);
}

function parseDayOfMonth(raw: string, label: string): number | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(`${label} "${raw}" must be a day of the month from 1 to 31`);
  return day;
}

function parseWeekday(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  const byName = WEEKDAYS.findIndex((d) => d === value || d.slice(0, 3) === value.slice(0, 3));
  if (byName >= 0) return byName;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric;
  throw new Error(`day "${raw}" must be a weekday name for a weekly series`);
}

function parseDate(raw: string): string | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (value === "none" || value === "clear" || value === "-") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`goal_date "${raw}" must be YYYY-MM-DD`);
  return value;
}

function parseRollover(raw: string): RolloverMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (value === "carry" || value === "rollover" || value === "roll over" || value === "yes") return "carry";
  if (value === "reset" || value === "no") return "reset";
  throw new Error(`rollover "${raw}" must be carry or reset`);
}

function parseAction(raw: string): "archive" | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "update" || value === "add" || value === "keep") return undefined;
  if (value === "archive" || value === "end" || value === "remove" || value === "delete" || value === "stop") return "archive";
  throw new Error(`action "${raw}" must be blank or "archive"`);
}

function scheduleLabel(p: Pick<RecurringPattern, "frequency" | "day_of_month" | "day_of_month_2" | "day_of_week">): string {
  if (p.frequency === "weekly") return p.day_of_week === null ? "weekly" : `every ${WEEKDAY_LABELS[p.day_of_week]}`;
  if (p.frequency === "semimonthly") return `twice a month on the ${p.day_of_month} and ${p.day_of_month_2 ?? "?"}`;
  return `monthly on the ${p.day_of_month}`;
}

interface Snapshot {
  categories: Category[];
  envelopes: Envelope[];
  patterns: RecurringPattern[];
  envelopeByCategory: Map<string, Envelope>;
  /** Confirmed, not-ended series by category id. */
  seriesByCategory: Map<string, RecurringPattern>;
}

async function snapshot(db: D1Database, householdId: string): Promise<Snapshot> {
  const [categories, envelopes, patterns] = await Promise.all([
    listCategories(db, householdId),
    listEnvelopes(db, householdId),
    listRecurringPatterns(db, householdId, { status: "confirmed" }),
  ]);
  const envelopeByCategory = new Map(envelopes.map((e) => [e.category_id, e]));
  const seriesByCategory = new Map<string, RecurringPattern>();
  for (const p of patterns) if (p.category_id && !p.ended_at && !seriesByCategory.has(p.category_id)) seriesByCategory.set(p.category_id, p);
  return { categories, envelopes, patterns, envelopeByCategory, seriesByCategory };
}

/** The household's current plan, one row per envelope, goal, bill and
 * paycheck, in the exact shape the import reads. */
export async function exportBudgetCsv(db: D1Database, householdId: string): Promise<string> {
  const snap = await snapshot(db, householdId);
  const rows: Array<Array<string | number | null>> = [];
  const active = snap.categories.filter((c) => !c.archived_at);
  const byName = (a: Category, b: Category) => a.name.localeCompare(b.name);

  const envelopeRows = active
    .filter((c) => c.kind === "expense" && !snap.seriesByCategory.has(c.id) && snap.envelopeByCategory.get(c.id) && !snap.envelopeByCategory.get(c.id)!.archived_at)
    .map((c) => ({ c, e: snap.envelopeByCategory.get(c.id)! }))
    .sort((a, b) => a.e.group_name.localeCompare(b.e.group_name) || a.c.name.localeCompare(b.c.name));
  for (const { c, e } of envelopeRows) rows.push(["envelope", c.name, dollars(e.monthly_target_cents), e.group_name, "", "", "", "", "", e.rollover_mode, ""]);

  for (const c of active.filter((c) => c.kind === "savings" && snap.envelopeByCategory.get(c.id) && !snap.envelopeByCategory.get(c.id)!.archived_at).sort(byName)) {
    const e = snap.envelopeByCategory.get(c.id)!;
    rows.push(["goal", c.name, dollars(e.monthly_target_cents), e.group_name, "", "", "", "", e.target_date ?? "", "", ""]);
  }

  const seriesRows = [...snap.seriesByCategory.values()]
    .map((p) => ({ p, c: snap.categories.find((c) => c.id === p.category_id) }))
    .filter((x): x is { p: RecurringPattern; c: Category } => Boolean(x.c))
    .sort((a, b) => Number(a.p.kind === "income") - Number(b.p.kind === "income") || a.c.name.localeCompare(b.c.name));
  for (const { p, c } of seriesRows) {
    rows.push([
      p.kind === "income" ? "income" : "bill",
      c.name,
      dollars(p.expected_amount_cents),
      "",
      p.frequency === "semimonthly" ? "twice-monthly" : p.frequency,
      p.frequency === "weekly" ? (p.day_of_week === null ? "" : WEEKDAY_LABELS[p.day_of_week]!) : p.day_of_month,
      p.frequency === "semimonthly" ? p.day_of_month_2 : "",
      p.merchant_pattern,
      "",
      "",
      "",
    ]);
  }
  return formatCsv([...BUDGET_CSV_HEADER], rows);
}

interface PlannedRow extends BudgetPlanRow {
  run: () => Promise<void>;
}

/**
 * Read the file against the current plan and decide, row by row, what
 * would change. Every row gets a verdict even when another row is broken,
 * so a preview shows the whole picture at once. Rows are independent of
 * each other except that two rows naming the same thing are refused —
 * the second would silently overwrite the first.
 */
async function buildPlan(db: D1Database, householdId: string, csv: string): Promise<PlannedRow[]> {
  const records = parseCsvWithHeader(csv);
  const header = Object.keys(records[0] ?? {}).map((k) => k.toLowerCase());
  if (records.length > 0 && (!header.includes("type") || !header.includes("name"))) {
    throw new Error(`The header row must include "type" and "name" columns (got: ${Object.keys(records[0]!).join(", ") || "nothing"})`);
  }
  const snap = await snapshot(db, householdId);
  const today = nowIso().slice(0, 10);
  const seen = new Set<string>();
  const planned: PlannedRow[] = [];

  records.forEach((raw, index) => {
    const line = index + 2;
    // Case-insensitive header lookup so "Type" and "type" both work.
    const cell = (key: string) => raw[key] ?? raw[Object.keys(raw).find((k) => k.toLowerCase() === key) ?? ""] ?? "";
    const name = cell("name").trim();
    const type = parseType(cell("type"));
    const fail = (error: string): PlannedRow => ({ line, type, name, action: "error", changes: [], error, run: async () => {} });

    if (!type && !name) return; // a blank line
    if (!type) return void planned.push(fail(`type "${cell("type")}" must be envelope, goal, bill, or income`));
    if (!name) return void planned.push(fail("name is required"));
    const key = `${type}::${name.toLowerCase()}`;
    if (seen.has(key)) return void planned.push(fail(`${name} appears twice as a ${type}; keep one row`));
    seen.add(key);

    try {
      const amount = parseAmount(cell("amount"));
      const group = cell("group").trim() || undefined;
      const action = parseAction(cell("action"));
      const kind = type === "goal" ? "savings" : type === "income" ? "income" : "expense";
      const category = snap.categories.find((c) => !c.archived_at && c.kind === kind && c.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
      const changes: string[] = [];

      if (type === "envelope" || type === "goal") {
        const rollover = type === "envelope" ? parseRollover(cell("rollover")) : undefined;
        const goalDate = type === "goal" ? parseDate(cell("goal_date")) : undefined;
        const envelope = category ? (snap.envelopeByCategory.get(category.id) ?? null) : null;
        if (category && type === "envelope" && snap.seriesByCategory.has(category.id)) {
          return void planned.push(fail(`${category.name} is a bill on the calendar; change it with a "bill" row`));
        }

        if (action === "archive") {
          if (!category || !envelope || envelope.archived_at) return void planned.push({ line, type, name, action: "unchanged", changes: ["not in the plan, nothing to archive"], run: async () => {} });
          return void planned.push({ line, type, name, action: "archive", changes: [`archive ${category.name}`], run: () => archiveCategory(db, householdId, category.id).then(() => {}) });
        }

        if (!category || !envelope) {
          const groupName = group ?? (type === "goal" ? "Goals" : "Uncategorized");
          changes.push(`new ${type} "${name}"`);
          if (amount !== undefined && amount !== null) changes.push(`${type === "goal" ? "total needed" : "amount each month"} ${money(amount)}`);
          changes.push(`group ${groupName}`);
          if (goalDate) changes.push(`goal date ${goalDate}`);
          if (rollover) changes.push(`rollover ${rollover}`);
          return void planned.push({
            line,
            type,
            name,
            action: "create",
            changes,
            run: async () => {
              const created = await createCategory(db, householdId, { name, kind });
              await createEnvelopeForCategory(db, householdId, created, {
                groupName,
                monthlyTargetCents: amount ?? null,
                targetDate: goalDate ?? null,
                rolloverMode: rollover,
              });
            },
          });
        }

        const patch: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null; rolloverMode?: RolloverMode } = {};
        if (amount !== undefined && amount !== envelope.monthly_target_cents) {
          patch.monthlyTargetCents = amount;
          changes.push(`${type === "goal" ? "total needed" : "amount each month"} ${money(envelope.monthly_target_cents)} → ${money(amount)}`);
        }
        if (group && group !== envelope.group_name) {
          patch.groupName = group;
          changes.push(`group ${envelope.group_name} → ${group}`);
        }
        if (goalDate !== undefined && goalDate !== envelope.target_date) {
          patch.targetDate = goalDate;
          changes.push(`goal date ${envelope.target_date ?? "none"} → ${goalDate ?? "none"}`);
        }
        if (rollover && rollover !== envelope.rollover_mode) {
          patch.rolloverMode = rollover;
          changes.push(`rollover ${envelope.rollover_mode} → ${rollover}`);
        }
        const unarchive = Boolean(envelope.archived_at);
        if (unarchive) changes.push("bring back from archive");
        if (changes.length === 0) return void planned.push({ line, type, name, action: "unchanged", changes, run: async () => {} });
        return void planned.push({
          line,
          type,
          name,
          action: "update",
          changes,
          run: async () => {
            if (unarchive) await unarchiveCategory(db, householdId, category.id);
            if (Object.keys(patch).length > 0) await updateEnvelope(db, householdId, envelope.id, patch);
          },
        });
      }

      // bill / income
      const frequency = parseFrequency(cell("frequency"));
      const merchant = cell("merchant").trim() || undefined;
      const series = category ? (snap.seriesByCategory.get(category.id) ?? null) : null;
      const effectiveFrequency = frequency ?? series?.frequency ?? "monthly";
      const dayOfMonth = effectiveFrequency === "weekly" ? undefined : parseDayOfMonth(cell("day"), "day");
      const dayOfWeek = effectiveFrequency === "weekly" ? parseWeekday(cell("day")) : undefined;
      const dayOfMonth2 = effectiveFrequency === "semimonthly" ? parseDayOfMonth(cell("day2"), "day2") : undefined;

      if (action === "archive") {
        if (!series) return void planned.push({ line, type, name, action: "unchanged", changes: ["not on the calendar, nothing to end"], run: async () => {} });
        return void planned.push({
          line,
          type,
          name,
          action: "archive",
          changes: [`end the series as of ${today}`],
          run: () => updateRecurringPattern(db, householdId, series.id, { endedAt: today }).then(() => {}),
        });
      }

      if (!series) {
        if (effectiveFrequency === "weekly" && dayOfWeek === undefined) throw new Error("a new weekly series needs a weekday in the day column");
        if (effectiveFrequency !== "weekly" && dayOfMonth === undefined) throw new Error(`a new ${type} needs a day of the month in the day column`);
        if (effectiveFrequency === "semimonthly" && dayOfMonth2 === undefined) throw new Error("a twice-monthly series needs day2 as well");
        const preview = { frequency: effectiveFrequency, day_of_month: dayOfMonth ?? 1, day_of_month_2: dayOfMonth2 ?? null, day_of_week: dayOfWeek ?? null };
        changes.push(category ? `put ${category.name} on the calendar` : `new ${type} "${name}"`);
        if (amount !== undefined && amount !== null) changes.push(`expected ${money(amount)}`);
        changes.push(scheduleLabel(preview));
        changes.push(`matches "${(merchant ?? name).toUpperCase()}"`);
        return void planned.push({
          line,
          type,
          name,
          action: "create",
          changes,
          run: async () => {
            const cat = category ?? (await createCategory(db, householdId, { name, kind }));
            const pattern = await createConfirmedRecurringPattern(db, householdId, {
              categoryId: cat.id,
              merchantPattern: merchant ?? name,
              kind: type === "income" ? "income" : "expense",
              expectedAmountCents: amount ?? null,
              frequency: effectiveFrequency,
              dayOfMonth: dayOfMonth ?? 1,
              dayOfMonth2,
              dayOfWeek,
            });
            await syncBillEnvelope(db, householdId, cat, pattern.expected_amount_cents);
          },
        });
      }

      const patch: Parameters<typeof updateRecurringPattern>[3] = {};
      if (amount !== undefined && amount !== series.expected_amount_cents) {
        patch.expectedAmountCents = amount;
        changes.push(`expected ${money(series.expected_amount_cents)} → ${money(amount)}`);
      }
      const next = {
        frequency: effectiveFrequency,
        day_of_month: dayOfMonth ?? series.day_of_month,
        day_of_month_2: effectiveFrequency === "semimonthly" ? (dayOfMonth2 ?? series.day_of_month_2) : null,
        day_of_week: effectiveFrequency === "weekly" ? (dayOfWeek ?? series.day_of_week) : null,
      };
      if (scheduleLabel(next) !== scheduleLabel(series)) {
        patch.frequency = next.frequency;
        patch.dayOfMonth = next.day_of_month;
        patch.dayOfMonth2 = next.day_of_month_2 ?? undefined;
        patch.dayOfWeek = next.day_of_week ?? undefined;
        changes.push(`${scheduleLabel(series)} → ${scheduleLabel(next)}`);
      }
      if (merchant && merchant.trim().toUpperCase() !== series.merchant_pattern) {
        patch.merchantPattern = merchant;
        changes.push(`matches "${series.merchant_pattern}" → "${merchant.trim().toUpperCase()}"`);
      }
      if (Object.keys(patch).length === 0) return void planned.push({ line, type, name, action: "unchanged", changes, run: async () => {} });
      return void planned.push({
        line,
        type,
        name,
        action: "update",
        changes,
        run: async () => {
          const updated = await updateRecurringPattern(db, householdId, series.id, patch);
          if (category) await syncBillEnvelope(db, householdId, category, updated.expected_amount_cents);
        },
      });
    } catch (err) {
      planned.push(fail(err instanceof Error ? err.message : String(err)));
    }
  });

  return planned;
}

function summarize(rows: PlannedRow[], applied: boolean): BudgetPlanSummary {
  const publicRows: BudgetPlanRow[] = rows.map(({ line, type, name, action, changes, error }) => ({ line, type, name, action, changes, ...(error ? { error } : {}) }));
  return {
    rows: publicRows,
    creates: rows.filter((r) => r.action === "create").length,
    updates: rows.filter((r) => r.action === "update").length,
    archives: rows.filter((r) => r.action === "archive").length,
    errors: rows.filter((r) => r.action === "error").length,
    applied,
  };
}

/** What uploading this file would do, without doing any of it. */
export async function previewBudgetCsv(db: D1Database, householdId: string, csv: string): Promise<BudgetPlanSummary> {
  return summarize(await buildPlan(db, householdId, csv), false);
}

/**
 * Apply the file. Refused outright if any row has an error, so a typo on
 * line 14 never half-applies a plan: fix the file and upload again. Rows
 * run in file order.
 */
export async function applyBudgetCsv(db: D1Database, householdId: string, csv: string): Promise<BudgetPlanSummary> {
  const rows = await buildPlan(db, householdId, csv);
  if (rows.some((r) => r.action === "error")) return summarize(rows, false);
  for (const row of rows) await row.run();
  return summarize(rows, true);
}
