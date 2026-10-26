import { Hono } from "hono";
import { requireParam } from "../lib/http";
import { getSheetLink, SheetAlreadyLinkedError, upsertSheetLink } from "../db/sheetLinks";
import { parseSpreadsheetId } from "../sheets/client";
import { serviceAccountEmail } from "../sheets/googleAuth";
import type { Env } from "../types";

export const sheetRoute = new Hono<{ Bindings: Env }>();

/** Which sheet is connected, when it last synced, and the last error —
 * the first thing to check when the sheet stops updating. */
sheetRoute.get("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const link = await getSheetLink(c.env.DB, householdId);
  return c.json({
    connected: link !== null,
    spreadsheetId: link?.spreadsheet_id ?? null,
    url: link ? `https://docs.google.com/spreadsheets/d/${link.spreadsheet_id}/edit` : null,
    viewMonth: link?.view_month ?? null,
    lastSyncedAt: link?.last_synced_at ?? null,
    lastError: link?.last_error ?? null,
    shareWith: serviceAccountEmail(c.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  });
});

/** Connect a sheet ({ "url": "https://docs.google.com/spreadsheets/d/…" }). */
sheetRoute.post("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const spreadsheetId = body.url ? parseSpreadsheetId(body.url) : null;
  if (!spreadsheetId) return c.json({ error: "url must be a Google Sheets link" }, 400);
  try {
    await upsertSheetLink(c.env.DB, householdId, spreadsheetId);
  } catch (err) {
    if (err instanceof SheetAlreadyLinkedError) return c.json({ error: err.message }, 409);
    throw err;
  }
  await c.env.TRANSACTION_QUEUE.send({ type: "sheet_sync", householdId });
  return c.json({ connected: spreadsheetId, shareWith: serviceAccountEmail(c.env.GOOGLE_SERVICE_ACCOUNT_JSON) }, 201);
});

/** Run a sync now instead of waiting for the next five-minute tick. */
sheetRoute.post("/sync", async (c) => {
  const householdId = requireParam(c, "householdId");
  if (!(await getSheetLink(c.env.DB, householdId))) return c.json({ error: "no sheet connected" }, 404);
  await c.env.TRANSACTION_QUEUE.send({ type: "sheet_sync", householdId });
  return c.json({ queued: true }, 202);
});
