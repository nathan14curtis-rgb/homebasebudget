import { listCategories } from "../db/categories";
import {
  confirmRecurringPattern,
  createConfirmedRecurringPattern,
  deleteRecurringPattern,
  dismissRecurringPattern,
  getRecurringPattern,
  listRecurringPatterns,
  updateRecurringPattern,
} from "../db/recurringPatterns";
import { getOccurrence, listOccurrences, resolveOccurrenceAmountCents, updateOccurrence } from "../envelopes/occurrences";
import { getTransaction } from "../db/transactions";
import type { RecurringPattern, RecurringPatternFrequency } from "../types";
import {
  AgentToolError,
  bool,
  dateArg,
  formatDollars,
  monthArg,
  num,
  required,
  requireConfirmation,
  resolveCategory,
  str,
  toCents,
  toDollars,
  type AgentTool,
} from "./agentToolKit";
import type { Env } from "../types";

/**
 * Recurring bills and paychecks, as a text message sees them.
 *
 * Two layers, and keeping them distinct is the whole job:
 *
 *  - the **series** (`recurring_pattern`) — "Rocky Mountain Power, around
 *    the 12th, Utilities, usually about $180". Changing this changes every
 *    future month.
 *  - the **occurrence** (`series_occurrence`) — this month's instance of
 *    it. Changing this changes one month and leaves the series alone,
 *    which is what "the power bill is $240 this month" means, and what
 *    "skip the gym this month" means.
 *
 * A person will say both of those the same way, so the tools are named for
 * the difference and their descriptions spell it out.
 */

const FREQUENCIES = new Set<RecurringPatternFrequency>(["weekly", "semimonthly", "monthly"]);

function scheduleFrom(input: Record<string, unknown>, fallback?: RecurringPattern) {
  const frequency = (str(input, "frequency") ?? fallback?.frequency ?? "monthly") as RecurringPatternFrequency;
  if (!FREQUENCIES.has(frequency)) throw new AgentToolError("'frequency' must be 'weekly', 'semimonthly' or 'monthly'");

  const dayOfMonth = num(input, "day_of_month") ?? fallback?.day_of_month ?? null;
  const dayOfMonth2 = num(input, "second_day_of_month") ?? fallback?.day_of_month_2 ?? null;
  const dayOfWeek = num(input, "day_of_week") ?? fallback?.day_of_week ?? null;

  if (frequency === "weekly") {
    if (dayOfWeek === null || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new AgentToolError("a weekly series needs 'day_of_week' (0 = Sunday … 6 = Saturday)");
    }
  } else {
    if (dayOfMonth === null || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new AgentToolError("this series needs 'day_of_month' (1-31) — which day of the month it lands on");
    }
    if (frequency === "semimonthly" && (dayOfMonth2 === null || dayOfMonth2 < 1 || dayOfMonth2 > 31)) {
      throw new AgentToolError("a semimonthly series needs 'second_day_of_month' too — the two days it lands on");
    }
  }
  return {
    frequency,
    dayOfMonth: dayOfMonth ?? 1,
    dayOfMonth2: dayOfMonth2 ?? undefined,
    dayOfWeek: dayOfWeek ?? undefined,
  };
}

/** Series are named by merchant in conversation ("the power bill", "rocky
 * mountain power"), by id in the data. Match on either, preferring an
 * exact merchant match, and refuse ambiguity out loud rather than editing
 * the wrong bill. */
async function resolveSeries(env: Env, householdId: string, nameOrId: string): Promise<RecurringPattern> {
  const patterns = await listRecurringPatterns(env.DB, householdId);
  const byId = patterns.find((p) => p.id === nameOrId);
  if (byId) return byId;
  const needle = nameOrId.trim().toUpperCase();
  const exact = patterns.filter((p) => p.merchant_pattern === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = patterns.filter((p) => p.merchant_pattern.includes(needle) && !p.ended_at);
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new AgentToolError(`'${nameOrId}' matches more than one series (${partial.map((p) => p.merchant_pattern).join(", ")}) — use the exact merchant.`);
  }
  const active = patterns.filter((p) => !p.ended_at).map((p) => p.merchant_pattern);
  throw new AgentToolError(`No recurring series matching '${nameOrId}'. Existing series: ${active.join(", ") || "(none)"}.`);
}

function seriesUndo(pattern: RecurringPattern) {
  return {
    kind: "pattern_fields" as const,
    patternId: pattern.id,
    merchantPattern: pattern.merchant_pattern,
    categoryId: pattern.category_id!,
    frequency: pattern.frequency,
    dayOfMonth: pattern.day_of_month,
    dayOfMonth2: pattern.day_of_month_2,
    dayOfWeek: pattern.day_of_week,
    dayTolerance: pattern.day_tolerance,
    expectedAmountCents: pattern.expected_amount_cents,
    endedAt: pattern.ended_at,
  };
}

function describeSchedule(pattern: { frequency: string; day_of_month: number; day_of_month_2: number | null; day_of_week: number | null }): string {
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (pattern.frequency === "weekly") return `every ${weekdays[pattern.day_of_week ?? 0]}`;
  if (pattern.frequency === "semimonthly") return `on the ${pattern.day_of_month} and the ${pattern.day_of_month_2}`;
  return `around the ${pattern.day_of_month}`;
}

const createSeries: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "create_recurring_series",
    description:
      "Set up a recurring bill or paycheck: which merchant it comes from, when it lands, what category it files under, and roughly what it costs. From then on it shows up as an upcoming row on the plan before the charge arrives, and posting charges match to it automatically. Use this for 'add my $95 internet bill on the 5th' or 'my paycheck hits the 15th and the last day of the month'.",
    input_schema: {
      type: "object",
      properties: {
        merchant_contains: { type: "string", description: "Text matched against the merchant name, e.g. 'XFINITY'. Case-insensitive." },
        kind: { type: "string", enum: ["expense", "income"], description: "expense for a bill, income for a paycheck." },
        category: { type: "string", description: "Category it files under, by name or id. It must already exist." },
        frequency: { type: "string", enum: ["monthly", "semimonthly", "weekly"], description: "Defaults to monthly." },
        day_of_month: { type: "number", description: "1-31, for monthly and semimonthly." },
        second_day_of_month: { type: "number", description: "The second day, for semimonthly." },
        day_of_week: { type: "number", description: "0 = Sunday … 6 = Saturday, for weekly." },
        expected_amount_dollars: { type: "number", description: "What it usually costs, as a positive number." },
        day_tolerance: { type: "number", description: "How many days either side still counts as this bill. Defaults to 4." },
      },
      required: ["merchant_contains", "kind", "category"],
    },
  },
  async run(env, ctx, input) {
    const kind = required(input, "kind");
    if (kind !== "expense" && kind !== "income") throw new AgentToolError("'kind' must be 'expense' or 'income'");
    const category = await resolveCategory(env, ctx.householdId, required(input, "category"));
    const schedule = scheduleFrom(input);
    const expected = num(input, "expected_amount_dollars");
    const tolerance = num(input, "day_tolerance");

    const pattern = await createConfirmedRecurringPattern(env.DB, ctx.householdId, {
      categoryId: category.id,
      merchantPattern: required(input, "merchant_contains"),
      kind,
      expectedAmountCents: expected === null ? null : Math.abs(toCents(expected)),
      dayTolerance: tolerance === null ? undefined : tolerance,
      ...schedule,
    });

    ctx.record({
      summary: `added a recurring ${kind === "income" ? "paycheck" : "bill"}: ${pattern.merchant_pattern} ${describeSchedule(pattern)} → ${category.name}`,
      undo: { kind: "pattern_created", patternId: pattern.id },
    });
    return {
      series_id: pattern.id,
      merchant: pattern.merchant_pattern,
      kind: pattern.kind,
      category: category.name,
      schedule: describeSchedule(pattern),
      expected_amount_dollars: pattern.expected_amount_cents === null ? null : toDollars(pattern.expected_amount_cents),
    };
  },
};

const updateSeries: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "update_recurring_series",
    description:
      "Change a recurring bill or paycheck for every month from now on: what it costs, when it lands, what category it files under, or which merchant it matches. For a one-month change ('rent is $50 more just this month'), use update_bill_occurrence instead.",
    input_schema: {
      type: "object",
      properties: {
        series: { type: "string", description: "The series, by merchant text or id." },
        merchant_contains: { type: "string", description: "New merchant text to match on." },
        category: { type: "string" },
        frequency: { type: "string", enum: ["monthly", "semimonthly", "weekly"] },
        day_of_month: { type: "number" },
        second_day_of_month: { type: "number" },
        day_of_week: { type: "number" },
        expected_amount_dollars: { type: "number", description: "What it usually costs now, as a positive number." },
        day_tolerance: { type: "number" },
      },
      required: ["series"],
    },
  },
  async run(env, ctx, input) {
    const pattern = await resolveSeries(env, ctx.householdId, required(input, "series"));
    const category = str(input, "category") ? await resolveCategory(env, ctx.householdId, str(input, "category")!) : null;
    const schedule = scheduleFrom(input, pattern);
    const expected = num(input, "expected_amount_dollars");
    const tolerance = num(input, "day_tolerance");

    const before = seriesUndo(pattern);
    const updated = await updateRecurringPattern(env.DB, ctx.householdId, pattern.id, {
      ...(str(input, "merchant_contains") ? { merchantPattern: str(input, "merchant_contains")! } : {}),
      ...(category ? { categoryId: category.id } : {}),
      ...(expected === null ? {} : { expectedAmountCents: Math.abs(toCents(expected)) }),
      ...(tolerance === null ? {} : { dayTolerance: tolerance }),
      ...schedule,
    });

    ctx.record({ summary: `changed the ${updated.merchant_pattern} series`, undo: before });
    const categories = await listCategories(env.DB, ctx.householdId);
    return {
      series_id: updated.id,
      merchant: updated.merchant_pattern,
      category: categories.find((c) => c.id === updated.category_id)?.name ?? null,
      schedule: describeSchedule(updated),
      expected_amount_dollars: updated.expected_amount_cents === null ? null : toDollars(updated.expected_amount_cents),
    };
  },
};

const endSeries: AgentTool = {
  mutates: true,
  access: "destructive",
  definition: {
    name: "end_recurring_series",
    description:
      "Stop a recurring bill or paycheck from being projected forward — a subscription they cancelled, a job they left. Past months keep it; no future month shows it. Confirm before calling.",
    input_schema: {
      type: "object",
      properties: {
        series: { type: "string" },
        confirmed: { type: "boolean", description: "True only after the person has agreed." },
      },
      required: ["series"],
    },
  },
  async run(env, ctx, input) {
    const pattern = await resolveSeries(env, ctx.householdId, required(input, "series"));
    requireConfirmation(input, `ending the ${pattern.merchant_pattern} series`);
    const before = seriesUndo(pattern);
    const updated = await updateRecurringPattern(env.DB, ctx.householdId, pattern.id, { endedAt: new Date().toISOString() });
    ctx.record({ summary: `ended the ${pattern.merchant_pattern} series`, undo: before });
    return { series_id: updated.id, merchant: updated.merchant_pattern, ended: true };
  },
};

const confirmSuggestedSeries: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "review_suggested_series",
    description:
      "Accept or dismiss a series the app noticed on its own. Accepting starts projecting it on the plan; dismissing stops it being suggested again. Use this when someone answers a 'is this a recurring bill?' question.",
    input_schema: {
      type: "object",
      properties: {
        series: { type: "string", description: "The suggested series, by merchant text or id." },
        accept: { type: "boolean", description: "True to confirm it, false to dismiss it." },
        category: { type: "string", description: "Which category it files under. Required when accepting and the suggestion has none." },
      },
      required: ["series", "accept"],
    },
  },
  async run(env, ctx, input) {
    const accept = bool(input, "accept");
    if (accept === null) throw new AgentToolError("'accept' must be true or false");
    const pattern = await resolveSeries(env, ctx.householdId, required(input, "series"));

    if (!accept) {
      await dismissRecurringPattern(env.DB, ctx.householdId, pattern.id);
      ctx.record({
        summary: `dismissed the suggested ${pattern.merchant_pattern} series`,
        undo: { kind: "none", reason: "a dismissed suggestion can be re-created with create_recurring_series, but the original suggestion isn't restorable" },
      });
      return { series_id: pattern.id, merchant: pattern.merchant_pattern, status: "dismissed" };
    }

    const categoryName = str(input, "category");
    const categoryId = categoryName ? (await resolveCategory(env, ctx.householdId, categoryName)).id : pattern.category_id;
    if (!categoryId) throw new AgentToolError(`'${pattern.merchant_pattern}' has no category yet — pass 'category' to say where it files.`);
    const before = seriesUndo({ ...pattern, category_id: categoryId });
    const updated = await confirmRecurringPattern(env.DB, ctx.householdId, pattern.id, categoryId);
    ctx.record({ summary: `confirmed the ${pattern.merchant_pattern} series`, undo: before });
    return { series_id: updated.id, merchant: updated.merchant_pattern, status: "confirmed", schedule: describeSchedule(updated) };
  },
};

const deleteSeries: AgentTool = {
  mutates: true,
  access: "destructive",
  definition: {
    name: "delete_recurring_series",
    description:
      "Remove a recurring series entirely, including the upcoming rows it projected. Only right for one created by mistake — for a bill that genuinely stopped, end_recurring_series keeps the history and is what you want. Confirm before calling.",
    input_schema: {
      type: "object",
      properties: { series: { type: "string" }, confirmed: { type: "boolean" } },
      required: ["series"],
    },
  },
  async run(env, ctx, input) {
    const pattern = await resolveSeries(env, ctx.householdId, required(input, "series"));
    requireConfirmation(input, `deleting the ${pattern.merchant_pattern} series outright`);
    await deleteRecurringPattern(env.DB, ctx.householdId, pattern.id);
    ctx.record({
      summary: `deleted the ${pattern.merchant_pattern} series`,
      undo: { kind: "none", reason: "the series and its projected rows are gone; it can be set up again with create_recurring_series" },
    });
    return { deleted: pattern.merchant_pattern };
  },
};

const listUpcoming: AgentTool = {
  mutates: false,
  access: "read",
  definition: {
    name: "list_month_occurrences",
    description:
      "Every bill and paycheck expected in a month, with its due date, the amount expected, whether it has landed yet, and the occurrence id needed to change just that one. Use this for 'what's still due this month' and before changing a single month's bill.",
    input_schema: {
      type: "object",
      properties: { month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." } },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const month = monthArg(input);
    const [occurrences, patterns, categories] = await Promise.all([
      listOccurrences(env.DB, ctx.householdId, month),
      listRecurringPatterns(env.DB, ctx.householdId),
      listCategories(env.DB, ctx.householdId),
    ]);
    const patternById = new Map(patterns.map((p) => [p.id, p]));
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));

    const rows = occurrences.map((occurrence) => {
      const pattern = patternById.get(occurrence.pattern_id);
      const amountCents = resolveOccurrenceAmountCents(occurrence, pattern);
      return {
        occurrence_id: occurrence.id,
        merchant: pattern?.merchant_pattern ?? "?",
        kind: pattern?.kind ?? "expense",
        category: pattern?.category_id ? (categoryById.get(pattern.category_id) ?? null) : null,
        due_date: occurrence.due_date,
        status: occurrence.status,
        amount_dollars: amountCents === null ? null : toDollars(amountCents),
        matched_transaction_id: occurrence.matched_transaction_id,
      };
    });
    return { month, occurrences: rows };
  },
};

const updateOccurrenceTool: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "update_bill_occurrence",
    description:
      "Change one month's instance of a recurring bill without touching the series: a different amount this month, a moved due date, or skipping it entirely. Get the occurrence id from list_month_occurrences first.",
    input_schema: {
      type: "object",
      properties: {
        occurrence_id: { type: "string" },
        amount_dollars: { type: "number", description: "What it is this month, as a positive number." },
        clear_amount_override: { type: "boolean", description: "True to go back to the series' usual amount." },
        due_date: { type: "string", description: "'YYYY-MM-DD' it's actually due this month." },
        skip: { type: "boolean", description: "True to skip it this month, false to un-skip it." },
      },
      required: ["occurrence_id"],
    },
  },
  async run(env, ctx, input) {
    const occurrenceId = required(input, "occurrence_id");
    const existing = await getOccurrence(env.DB, ctx.householdId, occurrenceId);
    if (!existing) throw new AgentToolError(`No occurrence '${occurrenceId}' — call list_month_occurrences to get the right id.`);

    const patch: { amountOverrideCents?: number | null; dueDate?: string; status?: "upcoming" | "skipped" } = {};
    const amount = num(input, "amount_dollars");
    if (bool(input, "clear_amount_override")) patch.amountOverrideCents = null;
    else if (amount !== null) patch.amountOverrideCents = Math.abs(toCents(amount));
    const dueDate = dateArg(input, "due_date");
    if (dueDate) patch.dueDate = dueDate;
    const skip = bool(input, "skip");
    if (skip !== null) patch.status = skip ? "skipped" : "upcoming";

    const pattern = await getRecurringPattern(env.DB, ctx.householdId, existing.pattern_id);
    const updated = await updateOccurrence(env.DB, ctx.householdId, occurrenceId, patch);
    ctx.record({
      summary: `${
        patch.status === "skipped"
          ? `skipped ${pattern?.merchant_pattern ?? "a bill"} for ${existing.month}`
          : `changed ${pattern?.merchant_pattern ?? "a bill"}'s ${existing.month} occurrence`
      }${patch.amountOverrideCents ? ` to ${formatDollars(patch.amountOverrideCents)}` : ""}`,
      undo: {
        kind: "occurrence_fields",
        occurrenceId,
        amountOverrideCents: existing.amount_override_cents,
        dueDate: existing.due_date,
        status: existing.status === "skipped" ? "skipped" : "upcoming",
      },
    });

    const matched = updated.matched_transaction_id ? await getTransaction(env.DB, ctx.householdId, updated.matched_transaction_id).catch(() => null) : null;
    return {
      occurrence_id: updated.id,
      merchant: pattern?.merchant_pattern ?? null,
      month: updated.month,
      due_date: updated.due_date,
      status: updated.status,
      amount_dollars: updated.amount_override_cents === null ? null : toDollars(updated.amount_override_cents),
      matched_charge: matched ? { transaction_id: matched.id, amount_dollars: toDollars(matched.amount_cents) } : null,
    };
  },
};

export const SERIES_TOOLS: AgentTool[] = [
  createSeries,
  updateSeries,
  endSeries,
  deleteSeries,
  confirmSuggestedSeries,
  listUpcoming,
  updateOccurrenceTool,
];
