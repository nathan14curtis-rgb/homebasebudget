import type { Env } from "../types";
import { runAgentTool, type AgentToolContext } from "../messaging/agentTools";
import type { CellValue } from "./client";
import type { ColumnType } from "./cells";

/**
 * The shape every tab in the household's sheet shares.
 *
 * A tab is a header row, then one row per thing (a charge, an envelope, a
 * bill), keyed by a hidden id in column A. Each column says how its cells
 * compare (cells.ts) and whether a person may edit it. A tab knows how to
 * render itself from the database and how to apply a person's edits to a
 * row, and nothing else — the read/diff/write loop is sync.ts's job.
 */

export type Dropdown = "categories" | "accounts" | "groups";

export interface Column {
  key: string;
  header: string;
  type: ColumnType;
  /** A person may change this on an existing row. */
  editable: boolean;
  /** May be filled in on a new row, but not changed afterwards. */
  createOnly?: boolean;
  /** Fixed options, shown as a dropdown. */
  options?: string[];
  /** Options read from the hidden _lists tab, so they track the data. */
  dropdown?: Dropdown;
  width?: number;
  /** Shown as the header cell's note — how to use the column. */
  note?: string;
}

export const SYNC_COLUMN: Column = {
  key: "sync",
  header: "Sync",
  type: "text",
  editable: false,
  width: 260,
  note: "If an edit on this row couldn't be applied, why — the cell goes back to what's saved. Clears itself within the hour.",
};

export interface RenderedRow {
  id: string;
  cells: Record<string, CellValue>;
}

/** One row as read from the sheet, by column key. */
export type SheetRow = Record<string, CellValue>;

export interface ChangedCell {
  key: string;
  /** What the app last wrote (normalized). */
  before: string;
  /** What's there now, raw. */
  value: CellValue;
}

export interface SyncContext {
  env: Env;
  householdId: string;
  timezone: string;
  /** The month the Budget and Bills This Month tabs are about. */
  month: string;
  /** Today in the household's timezone, 'YYYY-MM-DD'. */
  today: string;
}

/** The row-level header area some tabs put above their table (Budget's
 * month picker). Rendered and diffed like a row, keyed by column letter. */
export interface MetaSpec {
  render(ctx: SyncContext): Promise<CellValue[]>;
  /** Column indexes (0-based) a person may edit, with their types. */
  editable: Array<{ index: number; type: ColumnType }>;
  apply(ctx: SyncContext, changed: Array<{ index: number; value: CellValue }>): Promise<void>;
}

export interface TabSpec {
  name: string;
  /** 1-based row the column headers sit on; data starts on the next row. */
  headerRow: number;
  /** Including the trailing Sync column (use withSync). */
  columns: Column[];
  meta?: MetaSpec;
  render(ctx: SyncContext): Promise<RenderedRow[]>;
  applyEdit?(ctx: SyncContext, id: string, changes: ChangedCell[], row: SheetRow): Promise<void>;
  /** A row with no id and something typed in it. */
  applyCreate?(ctx: SyncContext, row: SheetRow): Promise<void>;
  /** Rows that may be filled at the bottom to add something new. */
  allowsCreate: boolean;
  /** Rows Google should reserve, beyond what's rendered. */
  minRows?: number;
}

/** A new row whose main record was created, but a follow-up step (tags,
 * a flag) failed. The row now exists, so the error belongs to its id —
 * treating it as a failed create would create it again next sync. */
export class PartialCreateError extends Error {
  constructor(
    readonly createdId: string,
    message: string,
  ) {
    super(message);
    this.name = "PartialCreateError";
  }
}

/** Runs a created row's follow-up steps, re-throwing any failure as a
 * PartialCreateError tied to the new id. */
export async function afterCreate(createdId: string, steps: () => Promise<void>): Promise<void> {
  try {
    await steps();
  } catch (err) {
    throw new PartialCreateError(createdId, `Added, but ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function withSync(columns: Column[]): Column[] {
  return [...columns, SYNC_COLUMN];
}

/** An edit the sheet asked for that the app refused, phrased for the Sync
 * column. */
export class SheetEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetEditError";
  }
}

/** Sheet edits run as the household with full access: the sheet is only
 * shared with the people who run the budget. `via: "sheet"` marks the
 * change log so the Log tab can say where an edit came from. */
export function sheetToolContext(householdId: string): AgentToolContext {
  return { householdId, userId: null, accessLevel: "full", via: "sheet" };
}

/** Calls an agent tool the way the bot would, and turns its refusal into
 * a SheetEditError carrying the tool's own explanation. */
export async function runSheetTool(ctx: SyncContext, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await runAgentTool(ctx.env, sheetToolContext(ctx.householdId), name, input);
  if (outcome.isError) throw new SheetEditError(plainError(outcome.content));
  try {
    return JSON.parse(outcome.content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Tool errors are written for the bot to read ("Tell them that plainly",
 * "use the exact name"); trim the parts addressed to a model. */
function plainError(message: string): string {
  return message
    .replace(/\s*Say so plainly[^.]*\./g, "")
    .replace(/\s*Tell them that plainly\./g, "")
    .replace(/\s*Ask them to confirm[^.]*\./g, "")
    .replace(/call list_[a-z_]+ (to get|for) [^.—]*/g, "check the row")
    .trim();
}

export function changed(changes: ChangedCell[], key: string): ChangedCell | undefined {
  return changes.find((c) => c.key === key);
}
