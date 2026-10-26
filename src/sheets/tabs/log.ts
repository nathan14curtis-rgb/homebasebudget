import { listChanges } from "../../db/changeLog";
import { listAccounts } from "../../db/accounts";
import { listCategories } from "../../db/categories";
import { listEnvelopes } from "../../db/envelopes";
import { listUsers } from "../../db/users";
import { parseBool } from "../cells";
import type { CellValue } from "../client";
import { changed, runSheetTool, withSync, type SyncContext, type TabSpec } from "../layout";

/**
 * Every change anyone made — by text, by the sheet, by the bot on its own —
 * newest first, with an Undo checkbox. Ticking it is the sheet's "undo
 * that": the reversal is booked as its own change, so history still adds up.
 */
export const logTab: TabSpec = {
  name: "Log",
  headerRow: 1,
  allowsCreate: false,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "when", header: "When", type: "text", editable: false, width: 140 },
    { key: "who", header: "Who", type: "text", editable: false, width: 120 },
    { key: "what", header: "What changed", type: "text", editable: false, width: 420 },
    { key: "undo", header: "Undo", type: "bool", editable: true, width: 70, note: "Tick to reverse this change. A ticked box means it's been undone." },
  ]),

  async render(ctx) {
    const [changes, users] = await Promise.all([
      listChanges(ctx.env.DB, ctx.householdId, { limit: 150, includeReverted: true }),
      listUsers(ctx.env.DB, ctx.householdId),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    return changes.map((c) => {
      let who: string;
      if (c.tool_name.startsWith("sheet:")) who = "Sheet";
      else if (c.user_id) who = `${userName.get(c.user_id) ?? "Someone"} (text)`;
      else who = "Bot";
      const undoable = !c.undo.includes('"kind":"none"');
      return {
        id: c.id,
        cells: {
          id: c.id,
          when: formatWhen(c.created_at, ctx.timezone),
          who,
          what: `${c.summary}${c.reverted_at ? " — undone" : undoable ? "" : " (can't be undone)"}`,
          undo: c.reverted_at !== null,
        },
      };
    });
  },

  async applyEdit(ctx, id, changes) {
    const undo = changed(changes, "undo");
    // Unticking an undone change would be "redo" — that's just making the
    // change again, so the box simply goes back to ticked.
    if (undo && parseBool(undo.value) && undo.before === "false") await runSheetTool(ctx, "undo_change", { change_id: id });
  },
};

function formatWhen(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

/**
 * The hidden tab the dropdowns read from — active category names, account
 * names, envelope groups — so a dropdown always offers what exists now.
 */
export const LISTS_TAB = "_lists";

export async function renderLists(ctx: SyncContext): Promise<CellValue[][]> {
  const [categories, accounts, envelopes] = await Promise.all([
    listCategories(ctx.env.DB, ctx.householdId),
    listAccounts(ctx.env.DB, ctx.householdId),
    listEnvelopes(ctx.env.DB, ctx.householdId),
  ]);
  const categoryNames = categories.filter((c) => !c.archived_at).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const accountNames = accounts.filter((a) => a.status !== "removed").map((a) => a.name);
  const groups = [...new Set(envelopes.filter((e) => !e.archived_at).map((e) => e.group_name))];
  const length = Math.max(categoryNames.length, accountNames.length, groups.length);
  const rows: CellValue[][] = [["Categories", "Accounts", "Groups"]];
  for (let i = 0; i < length; i++) rows.push([categoryNames[i] ?? "", accountNames[i] ?? "", groups[i] ?? ""]);
  return rows;
}

export const README_TAB = "Read Me";

export const README_ROWS: string[][] = [
  ["Home Base budget — how this sheet works"],
  [""],
  ["This sheet and the texting bot edit the same budget. The sheet syncs every 5 minutes: your edits are applied, then the sheet is refreshed with the latest numbers."],
  ["Just type over a cell. Grey columns are calculated and can't be edited (Sheets will warn you)."],
  ["If an edit can't be applied, the cell goes back to what's saved and the Sync column on that row says why."],
  [""],
  ["Budget — this month's envelopes. Change the month in C1 (type 2026-11). Tick 'Fund to plan' to fill every envelope up to its target."],
  ["   Monthly target, Rollover and Goal date change the plan for every month. Carried in and Assigned change only the month shown."],
  ["   Add an envelope on an empty row at the bottom: Category name (+ Group, Monthly target). Add a Goal date to make it a savings goal."],
  ["Cash Flow — a 13-week forecast (read-only): beginning cash, recurring income and bills, your average weekly spending, ending cash."],
  ["Transactions — every charge on record. Fix category, payee, amount, date, memo, tags, flag; tick Excluded to keep a charge out of the budget."],
  ["   Split a charge by typing its parts in Split: 'Groceries 120, Household 60'. Add a cash charge on an empty row (Date, Payee, Amount, Account)."],
  ["Bills — recurring bills and paychecks. Changes apply to every month. Status: confirm or dismiss suggestions, 'ended' when a bill stops."],
  ["Bills This Month — this month's copy of each bill. Change the amount or due date for just this month, or set Status to skipped."],
  ["Categories — rename, add, or tick Archived to retire one."],
  ["Log — every change, from the sheet, a text, or the bot. Tick Undo to reverse one."],
  [""],
  ["Don't delete rows — deleted rows come back on the next sync. Use Excluded, Archived, or a bill's Status instead."],
  ["Don't rename or reorder the tabs or columns. Hidden column A on each tab is the row's id — leave it alone."],
];
