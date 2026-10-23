import { getSheetLink, upsertSheetLink } from "../db/sheetLinks";
import { parseSpreadsheetId } from "../sheets/client";
import { serviceAccountEmail } from "../sheets/googleAuth";
import { AgentToolError, required, type AgentTool } from "./agentToolKit";

/**
 * Connecting the household's Google Sheet by text — "here's our budget
 * sheet: https://docs.google.com/spreadsheets/d/…". The sheet then fills
 * itself in on the next sync and stays two-way from there (src/sheets/).
 */

const connectSheet: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "connect_google_sheet",
    description:
      "Connect the Google Sheet the household edits their budget in, or re-sync the one already connected. Pass the sheet's link. It fills in within a minute and syncs every 5 minutes after. The sheet must be shared (Editor) with the service-account email this returns — tell them that if it's the first time.",
    input_schema: {
      type: "object",
      properties: { sheet_url: { type: "string", description: "The docs.google.com/spreadsheets link, or the bare spreadsheet id." } },
      required: ["sheet_url"],
    },
  },
  async run(env, ctx, input) {
    const spreadsheetId = parseSpreadsheetId(required(input, "sheet_url"));
    if (!spreadsheetId) throw new AgentToolError("That doesn't look like a Google Sheets link — it should contain /spreadsheets/d/…");
    const email = serviceAccountEmail(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!email) throw new AgentToolError("The Google service account isn't set up on the server yet (GOOGLE_SERVICE_ACCOUNT_JSON), so the sheet can't be connected.");

    const before = await getSheetLink(env.DB, ctx.householdId);
    await upsertSheetLink(env.DB, ctx.householdId, spreadsheetId);
    await env.TRANSACTION_QUEUE.send({ type: "sheet_sync", householdId: ctx.householdId });
    ctx.record({
      summary: before && before.spreadsheet_id !== spreadsheetId ? "switched the budget to a different Google Sheet" : "connected the budget's Google Sheet",
      undo: { kind: "none", reason: "connect the previous sheet's link again to switch back" },
    });
    return {
      connected: spreadsheetId,
      share_with: email,
      note: "Share the sheet with share_with as an Editor if it isn't already. It fills in within a minute.",
    };
  },
};

export const SHEET_TOOLS: AgentTool[] = [connectSheet];
