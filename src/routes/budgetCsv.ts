import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { applyBudgetCsv, exportBudgetCsv, previewBudgetCsv } from "../budget/csv";

export const budgetRoute = new Hono<{ Bindings: Env }>();

// The household's plan as a spreadsheet, in the shape the POST below reads
// back — download, edit, upload (src/budget/csv.ts documents the columns).
budgetRoute.get("/csv", async (c) => {
  const csv = await exportBudgetCsv(c.env.DB, requireParam(c, "householdId"));
  return c.body(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="budget-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

// Body is JSON so the file travels with the flag: `apply: false` (the
// default) previews what would change, `apply: true` does it. A file with
// any bad row is never applied, whichever flag is sent.
budgetRoute.post("/csv", async (c) => {
  const body = await c.req.json<{ csv?: string; apply?: boolean }>();
  if (typeof body.csv !== "string" || !body.csv.trim()) return c.json({ error: "csv is required" }, 400);
  try {
    const summary = body.apply ? await applyBudgetCsv(c.env.DB, requireParam(c, "householdId"), body.csv) : await previewBudgetCsv(c.env.DB, requireParam(c, "householdId"), body.csv);
    return c.json(summary, body.apply && summary.applied ? 201 : 200);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "failed to read the file" }, 400);
  }
});
