import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import {
  allocateToEnvelope,
  applyRolloverResets,
  fundEnvelopesToTarget,
  getEnvelopeMonthSummariesForHousehold,
  getEnvelopeMonthSummary,
  listEnvelopes,
  moveMoneyBetweenEnvelopes,
  updateEnvelope,
} from "../db/envelopes";

const MONTH_RE = /^\d{4}-\d{2}$/;

export const envelopesRoute = new Hono<{ Bindings: Env }>();

envelopesRoute.get("/", async (c) => {
  const envelopes = await listEnvelopes(c.env.DB, requireParam(c, "householdId"));
  return c.json(envelopes);
});

// Registered before "/:envelopeId" — Hono's router prioritizes a literal
// path segment over a param segment regardless of registration order, but
// this is still the right place for it to live: every envelope's summary
// at once, for pages (the Overview envelope-fill chart) that need all of
// them, instead of the per-envelope N+1 pattern the dashboard used before.
envelopesRoute.get("/summary", async (c) => {
  const month = c.req.query("month");
  if (!month || !MONTH_RE.test(month)) return c.json({ error: "month query param must be 'YYYY-MM'" }, 400);
  // Envelopes set to reset their rollover are settled the moment anyone
  // looks at the month (src/db/envelopes.ts) — before the totals are read,
  // so the page never shows a carried-in figure the setting says shouldn't
  // exist.
  await applyRolloverResets(c.env.DB, requireParam(c, "householdId"), month);
  const summaries = await getEnvelopeMonthSummariesForHousehold(c.env.DB, requireParam(c, "householdId"), month);
  return c.json(summaries);
});

// group_name (which powers the dashboard's Bills view — an envelope
// grouped "Bills" instead of, say, "Everyday"), monthly_target_cents,
// target_date (turning an envelope into a goal after creation, not just
// at creation time via routes/categories.ts) and rollover_mode (whether
// leftover money survives the turn of the month) are what's worth editing
// about an envelope after creation.
envelopesRoute.patch("/:envelopeId", async (c) => {
  const body = await c.req.json<{
    groupName?: string;
    monthlyTargetCents?: number | null;
    targetDate?: string | null;
    rolloverMode?: "carry" | "reset";
  }>();
  if (body.rolloverMode !== undefined && body.rolloverMode !== "carry" && body.rolloverMode !== "reset") {
    return c.json({ error: "rolloverMode must be 'carry' or 'reset'" }, 400);
  }
  const envelope = await updateEnvelope(c.env.DB, requireParam(c, "householdId"), requireParam(c, "envelopeId"), body);
  return c.json(envelope);
});

envelopesRoute.get("/:envelopeId/summary", async (c) => {
  const month = c.req.query("month");
  if (!month || !MONTH_RE.test(month)) return c.json({ error: "month query param must be 'YYYY-MM'" }, 400);
  await applyRolloverResets(c.env.DB, requireParam(c, "householdId"), month);
  const summary = await getEnvelopeMonthSummary(c.env.DB, requireParam(c, "householdId"), requireParam(c, "envelopeId"), month);
  return c.json(summary);
});

envelopesRoute.post("/:envelopeId/allocate", async (c) => {
  const body = await c.req.json<{ month?: string; amountCents?: number; note?: string; createdByUserId?: string }>();
  if (!body.month || !MONTH_RE.test(body.month)) return c.json({ error: "month must be 'YYYY-MM'" }, 400);
  if (!Number.isInteger(body.amountCents)) return c.json({ error: "amountCents must be an integer" }, 400);

  await allocateToEnvelope(c.env.DB, requireParam(c, "householdId"), {
    envelopeId: requireParam(c, "envelopeId"),
    month: body.month,
    amountCents: body.amountCents!,
    note: body.note,
    createdByUserId: body.createdByUserId,
  });
  return c.json({ ok: true }, 201);
});

// "Fund to target": bring envelopes up to their monthly targets for the
// month as allocation rows, all of them or just the ones named. Without
// this the dashboard could set a target but never fund it, so every
// envelope read as over budget from its first purchase.
envelopesRoute.post("/fund", async (c) => {
  const body = await c.req.json<{ month?: string; envelopeIds?: string[]; topUpOnly?: boolean; createdByUserId?: string }>();
  if (!body.month || !MONTH_RE.test(body.month)) return c.json({ error: "month must be 'YYYY-MM'" }, 400);
  if (body.envelopeIds !== undefined && !Array.isArray(body.envelopeIds)) return c.json({ error: "envelopeIds must be a list" }, 400);
  const funded = await fundEnvelopesToTarget(c.env.DB, requireParam(c, "householdId"), {
    month: body.month,
    envelopeIds: body.envelopeIds,
    topUpOnly: body.topUpOnly,
    createdByUserId: body.createdByUserId,
  });
  return c.json({ funded, totalCents: funded.reduce((sum, f) => sum + f.amountCents, 0) }, 201);
});

// First-class, audited move between two envelopes (PLAN §8.1) — e.g.
// covering an overspent envelope from another one.
envelopesRoute.post("/move", async (c) => {
  const body = await c.req.json<{
    fromEnvelopeId?: string;
    toEnvelopeId?: string;
    month?: string;
    amountCents?: number;
    note?: string;
    createdByUserId?: string;
  }>();
  if (!body.fromEnvelopeId || !body.toEnvelopeId) {
    return c.json({ error: "fromEnvelopeId and toEnvelopeId are required" }, 400);
  }
  if (!body.month || !MONTH_RE.test(body.month)) return c.json({ error: "month must be 'YYYY-MM'" }, 400);
  if (!Number.isInteger(body.amountCents) || (body.amountCents ?? 0) <= 0) {
    return c.json({ error: "amountCents must be a positive integer" }, 400);
  }

  await moveMoneyBetweenEnvelopes(c.env.DB, requireParam(c, "householdId"), {
    fromEnvelopeId: body.fromEnvelopeId,
    toEnvelopeId: body.toEnvelopeId,
    month: body.month,
    amountCents: body.amountCents!,
    note: body.note,
    createdByUserId: body.createdByUserId,
  });
  return c.json({ ok: true }, 201);
});
