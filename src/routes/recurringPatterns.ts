import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createCategory, createEnvelopeForCategory } from "../db/categories";
import type { RecurringPatternFrequency } from "../types";
import {
  confirmRecurringPattern,
  createConfirmedRecurringPattern,
  deleteRecurringPattern,
  detectRecurringPatterns,
  dismissRecurringPattern,
  getRecurringPattern,
  listRecurringPatterns,
  updateRecurringPattern,
} from "../db/recurringPatterns";

const FREQUENCIES = new Set<RecurringPatternFrequency>(["weekly", "semimonthly", "monthly"]);

function validateSchedule(body: {
  frequency?: string;
  dayOfMonth?: number;
  dayOfMonth2?: number;
  dayOfWeek?: number;
}): { error: string } | { frequency: RecurringPatternFrequency } {
  const frequency = (body.frequency ?? "monthly") as RecurringPatternFrequency;
  if (!FREQUENCIES.has(frequency)) return { error: "frequency must be 'weekly', 'semimonthly', or 'monthly'" };
  if (frequency === "weekly") {
    if (!Number.isInteger(body.dayOfWeek) || body.dayOfWeek! < 0 || body.dayOfWeek! > 6) {
      return { error: "dayOfWeek must be an integer between 0 (Sunday) and 6 (Saturday) for a weekly pattern" };
    }
  } else {
    if (!Number.isInteger(body.dayOfMonth) || body.dayOfMonth! < 1 || body.dayOfMonth! > 31) {
      return { error: "dayOfMonth must be an integer between 1 and 31" };
    }
    if (frequency === "semimonthly" && (!Number.isInteger(body.dayOfMonth2) || body.dayOfMonth2! < 1 || body.dayOfMonth2! > 31)) {
      return { error: "dayOfMonth2 must be an integer between 1 and 31 for a semimonthly pattern" };
    }
  }
  return { frequency };
}

export const recurringPatternsRoute = new Hono<{ Bindings: Env }>();

recurringPatternsRoute.get("/", async (c) => {
  const status = c.req.query("status");
  const patterns = await listRecurringPatterns(c.env.DB, requireParam(c, "householdId"), {
    status: status === "suggested" || status === "confirmed" || status === "dismissed" ? status : undefined,
  });
  return c.json(patterns);
});

// The "Add recurring" wizard's endpoint — builds a pattern straight from a
// picked (or typed) merchant instead of waiting for the detector to notice
// it, going directly to 'confirmed' since a person just set it up by hand.
// Same existing-vs-new-category choice as .../:patternId/confirm below.
recurringPatternsRoute.post("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{
    merchantPattern?: string;
    kind?: "expense" | "income";
    frequency?: string;
    dayOfMonth?: number;
    dayOfMonth2?: number;
    dayOfWeek?: number;
    dayTolerance?: number;
    categoryId?: string;
    newCategoryName?: string;
    monthlyTargetCents?: number;
    expectedAmountCents?: number;
  }>();

  if (!body.merchantPattern?.trim()) return c.json({ error: "merchantPattern is required" }, 400);
  if (body.kind !== "expense" && body.kind !== "income") return c.json({ error: "kind must be 'expense' or 'income'" }, 400);
  const schedule = validateSchedule(body);
  if ("error" in schedule) return c.json({ error: schedule.error }, 400);
  if (body.expectedAmountCents !== undefined && !Number.isInteger(body.expectedAmountCents)) {
    return c.json({ error: "expectedAmountCents must be an integer number of cents" }, 400);
  }

  let categoryId = body.categoryId;
  if (!categoryId) {
    if (!body.newCategoryName?.trim()) return c.json({ error: "categoryId or newCategoryName is required" }, 400);
    const category = await createCategory(c.env.DB, householdId, { name: body.newCategoryName.trim(), kind: body.kind });
    if (category.kind === "expense") {
      await createEnvelopeForCategory(c.env.DB, householdId, category, { groupName: "Bills", monthlyTargetCents: body.monthlyTargetCents ?? null });
    }
    categoryId = category.id;
  }

  const pattern = await createConfirmedRecurringPattern(c.env.DB, householdId, {
    categoryId,
    merchantPattern: body.merchantPattern,
    kind: body.kind,
    // What the Bills & Income calendar projects a tile at before anything
    // has posted. An expense also mirrors it onto its envelope's monthly
    // target above; income has no envelope, so this is its only home.
    expectedAmountCents: body.expectedAmountCents ?? body.monthlyTargetCents,
    frequency: schedule.frequency,
    dayOfMonth: body.dayOfMonth ?? 1,
    dayOfMonth2: body.dayOfMonth2,
    dayOfWeek: body.dayOfWeek,
    dayTolerance: body.dayTolerance,
  });
  return c.json(pattern, 201);
});

// Manual trigger for "or manually" — the same detector Plaid sync runs
// automatically (src/plaid/sync.ts), exposed for the Recurring page's
// "suggest bills" action.
recurringPatternsRoute.post("/detect", async (c) => {
  const created = await detectRecurringPatterns(c.env.DB, requireParam(c, "householdId"));
  return c.json(created, 201);
});

// Confirming a suggestion needs a category to file future matches under —
// either an existing one (categoryId) or a brand-new one created on the
// spot (newCategoryName), the same category+envelope pairing
// routes/categories.ts's POST / does for a manually-added bill.
recurringPatternsRoute.post("/:patternId/confirm", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ categoryId?: string; newCategoryName?: string; kind?: "expense" | "income" }>();

  let categoryId = body.categoryId;
  if (!categoryId) {
    if (!body.newCategoryName?.trim()) return c.json({ error: "categoryId or newCategoryName is required" }, 400);
    if (body.kind !== "expense" && body.kind !== "income") return c.json({ error: "kind ('expense' or 'income') is required with newCategoryName" }, 400);
    const category = await createCategory(c.env.DB, householdId, { name: body.newCategoryName.trim(), kind: body.kind });
    if (category.kind === "expense") {
      await createEnvelopeForCategory(c.env.DB, householdId, category, { groupName: "Bills" });
    }
    categoryId = category.id;
  }

  const pattern = await confirmRecurringPattern(c.env.DB, householdId, requireParam(c, "patternId"), categoryId);
  return c.json(pattern);
});

// The Spending Plan Bills row's edit modal ("Link Transaction" + "Frequency
// and date") — re-points an already-confirmed pattern's merchant match
// and/or schedule. All fields optional; only what's provided changes.
recurringPatternsRoute.patch("/:patternId", async (c) => {
  const body = await c.req.json<{
    merchantPattern?: string;
    categoryId?: string;
    expectedAmountCents?: number | null;
    endedAt?: string | null;
    frequency?: string;
    dayOfMonth?: number;
    dayOfMonth2?: number;
    dayOfWeek?: number;
    dayTolerance?: number;
  }>();

  if (body.merchantPattern !== undefined && !body.merchantPattern.trim()) {
    return c.json({ error: "merchantPattern cannot be blank" }, 400);
  }
  if (body.expectedAmountCents !== undefined && body.expectedAmountCents !== null && !Number.isInteger(body.expectedAmountCents)) {
    return c.json({ error: "expectedAmountCents must be an integer number of cents, or null to clear it" }, 400);
  }
  if (body.endedAt !== undefined && body.endedAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.endedAt)) {
    return c.json({ error: "endedAt must be 'YYYY-MM-DD', or null to un-end the series" }, 400);
  }
  if (body.frequency !== undefined) {
    const schedule = validateSchedule(body);
    if ("error" in schedule) return c.json({ error: schedule.error }, 400);
  }

  const pattern = await updateRecurringPattern(c.env.DB, requireParam(c, "householdId"), requireParam(c, "patternId"), {
    merchantPattern: body.merchantPattern,
    categoryId: body.categoryId,
    ...("expectedAmountCents" in body ? { expectedAmountCents: body.expectedAmountCents } : {}),
    ...("endedAt" in body ? { endedAt: body.endedAt } : {}),
    frequency: body.frequency as RecurringPatternFrequency | undefined,
    dayOfMonth: body.dayOfMonth,
    dayOfMonth2: body.dayOfMonth2,
    dayOfWeek: body.dayOfWeek,
    dayTolerance: body.dayTolerance,
  });
  return c.json(pattern);
});

// Removing a series outright from the Bills & Income calendar — the
// pattern and every occurrence it projected go away. Distinct from
// /dismiss (which only stops a suggestion coming back) and from PATCHing
// endedAt (which keeps matched history on the calendar).
recurringPatternsRoute.delete("/:patternId", async (c) => {
  const householdId = requireParam(c, "householdId");
  const patternId = requireParam(c, "patternId");
  const existing = await getRecurringPattern(c.env.DB, householdId, patternId);
  if (!existing) return c.json({ error: "recurring pattern not found" }, 404);
  await deleteRecurringPattern(c.env.DB, householdId, patternId);
  return c.json({ ok: true });
});

recurringPatternsRoute.post("/:patternId/dismiss", async (c) => {
  await dismissRecurringPattern(c.env.DB, requireParam(c, "householdId"), requireParam(c, "patternId"));
  return c.json({ ok: true });
});
