import type { Env } from "../types";
import { getHousehold } from "../db/households";
import {
  acquireSheetLock,
  getSheetLink,
  loadTabSnapshots,
  releaseSheetLock,
  saveTabSnapshot,
  updateSheetLink,
  type SheetLink,
  type TabErrors,
  type TabSnapshot,
} from "../db/sheetLinks";
import { isBlank, normalize, parseMonth, type ColumnType } from "./cells";
import { a1, columnLetter, GoogleSheetsApi, PROTECTION_PREFIX, type CellValue, type SheetsApi, type SheetTabInfo } from "./client";
import { PartialCreateError, type ChangedCell, type Column, type RenderedRow, type SheetRow, type SyncContext, type TabSpec } from "./layout";
import { BUDGET_META, budgetTab } from "./tabs/budget";
import { billsTab, billsThisMonthTab } from "./tabs/bills";
import { categoriesTab } from "./tabs/categories";
import { LISTS_TAB, logTab, README_ROWS, README_TAB, renderLists } from "./tabs/log";
import { transactionsTab } from "./tabs/transactions";

/**
 * The two-way sync between the database and the household's Google Sheet.
 *
 * One pass, every five minutes (and right after a sheet is connected):
 *
 *  1. Read every tab.
 *  2. Diff each row against the snapshot of what this code last wrote
 *     there. A cell that differs is a person's edit; apply it through the
 *     same agent tools a text message uses (src/sheets/layout.ts), so it's
 *     logged, undoable, and validated the same way. A row with no id is a
 *     new thing to create.
 *  3. Render every tab fresh from the database and write it back, with
 *     anything that couldn't be applied explained in the row's Sync column.
 *  4. Save what was written as the next pass's snapshot.
 *
 * The database is the source of truth throughout. If a person and the bot
 * change the same cell inside one five-minute window, the person's edit is
 * applied last and wins; the Log tab shows both.
 */

/** Bump when columns, dropdowns or protections change, so every linked
 * sheet gets its formatting re-applied once. */
export const LAYOUT_VERSION = 1;

/** Tabs in the order their edits are applied: categories first so a new
 * category typed there can be used on any other tab in the same pass. */
export const TABS: TabSpec[] = [categoriesTab, budgetTab, billsTab, billsThisMonthTab, transactionsTab, logTab];
/** Tabs in the order they appear in the sheet. */
const DISPLAY_ORDER = [README_TAB, budgetTab.name, transactionsTab.name, billsTab.name, billsThisMonthTab.name, categoriesTab.name, logTab.name, LISTS_TAB];

const ERROR_TTL_MS = 60 * 60 * 1000;

export interface SyncResult {
  status: "synced" | "locked" | "not_linked";
  applied: number;
  failed: number;
  monthShown?: string;
}

export async function syncHouseholdSheet(env: Env, householdId: string, api?: SheetsApi): Promise<SyncResult> {
  const link = await getSheetLink(env.DB, householdId);
  if (!link) return { status: "not_linked", applied: 0, failed: 0 };
  if (!(await acquireSheetLock(env.DB, householdId))) return { status: "locked", applied: 0, failed: 0 };
  const sheets = api ?? new GoogleSheetsApi(link.spreadsheet_id, env.GOOGLE_SERVICE_ACCOUNT_JSON);
  try {
    const result = await runSync(env, link, sheets);
    await updateSheetLink(env.DB, householdId, { lastSyncedAt: new Date().toISOString(), lastError: null });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSheetLink(env.DB, householdId, { lastError: message.slice(0, 1000) });
    throw err;
  } finally {
    await releaseSheetLock(env.DB, householdId);
  }
}

async function runSync(env: Env, link: SheetLink, api: SheetsApi): Promise<SyncResult> {
  const household = await getHousehold(env.DB, link.household_id);
  const timezone = household.timezone || "America/Denver";
  const today = localDate(timezone);
  const currentMonth = today.slice(0, 7);

  const tabs = await ensureLayout(api, link, env);

  // 1. Read.
  const firstRead = await readTabs(api);
  const stored = await loadTabSnapshots(env.DB, link.household_id);

  // Which month the Budget tab is on, and whether a person just changed it.
  const budgetStored = stored.get(budgetTab.name)?.snapshot;
  const shownMonth = budgetStored?.month ?? link.view_month ?? currentMonth;
  const typedMonth = parseMonth(firstRead.get(budgetTab.name)?.[0]?.[BUDGET_META.month] ?? null);
  const nextMonth = typedMonth && budgetStored && typedMonth !== budgetStored.month ? typedMonth : (link.view_month ?? currentMonth);

  const baseCtx: Omit<SyncContext, "month"> = { env, householdId: link.household_id, timezone, today };

  // 2. Apply edits, tab by tab.
  let applied = 0;
  let failed = 0;
  const errorsByTab = new Map<string, TabErrors>();
  const createsByTab = new Map<string, number>();
  const now = Date.now();
  for (const spec of TABS) {
    const previous = stored.get(spec.name);
    const errors: TabErrors = { rows: {}, pending: [] };
    for (const [id, entry] of Object.entries(previous?.errors.rows ?? {})) {
      if (now - Date.parse(entry.at) < ERROR_TTL_MS) errors.rows[id] = entry;
    }
    errorsByTab.set(spec.name, errors);
    if (!previous) continue; // first pass on this tab: nothing to diff against yet

    const grid = firstRead.get(spec.name) ?? [];
    const editMonth = previous.snapshot.month ?? shownMonth;
    const ctx: SyncContext = { ...baseCtx, month: editMonth };

    if (spec.meta && previous.snapshot.meta) {
      const metaRow = grid[0] ?? [];
      const metaChanges = spec.meta.editable
        .filter((m) => normalize(m.type, metaRow[m.index] ?? null) !== (previous.snapshot.meta?.[String(m.index)] ?? ""))
        .map((m) => ({ index: m.index, value: metaRow[m.index] ?? null }));
      if (metaChanges.length > 0) {
        try {
          await spec.meta.apply({ ...baseCtx, month: nextMonth }, metaChanges);
        } catch (err) {
          failed++;
          console.error(`[sheets] ${spec.name} header edit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    for (const row of dataRows(spec, grid)) {
      const id = typeof row.id === "string" ? row.id.trim() : row.id === null || row.id === undefined ? "" : String(row.id);
      if (id) {
        const before = previous.snapshot.rows[id];
        if (!before) continue; // an id this sheet never had — leave it for the rewrite to clear
        const changes = diffRow(spec.columns, row, before);
        if (changes.length === 0) continue;
        const createOnly = changes.find((c) => !spec.columns.find((col) => col.key === c.key)!.editable);
        try {
          if (createOnly) {
            const column = spec.columns.find((col) => col.key === createOnly.key)!;
            throw new Error(`${column.header} can't be changed once a row exists`);
          }
          if (!spec.applyEdit) throw new Error("This tab is read-only");
          await spec.applyEdit(ctx, id, changes, row);
          delete errors.rows[id];
          applied++;
        } catch (err) {
          failed++;
          errors.rows[id] = { message: errorMessage(err), at: new Date(now).toISOString() };
        }
      } else if (spec.allowsCreate && spec.applyCreate && hasContent(spec.columns, row)) {
        try {
          await spec.applyCreate(ctx, row);
          applied++;
          createsByTab.set(spec.name, (createsByTab.get(spec.name) ?? 0) + 1);
        } catch (err) {
          if (err instanceof PartialCreateError) {
            applied++;
            createsByTab.set(spec.name, (createsByTab.get(spec.name) ?? 0) + 1);
            errors.rows[err.createdId] = { message: err.message, at: new Date(now).toISOString() };
          } else {
            failed++;
            errors.pending.push({ cells: pendingCells(spec.columns, row), message: errorMessage(err) });
          }
        }
      }
    }
  }

  // The month a person picked sticks; picking the current month again
  // goes back to following the calendar.
  const viewMonth = nextMonth === currentMonth ? null : nextMonth;
  if (viewMonth !== link.view_month) await updateSheetLink(env.DB, link.household_id, { viewMonth });

  // 3. Render and write. Re-read first: anything typed while edits were
  // being applied must not be overwritten (see writeTab).
  const ctx: SyncContext = { ...baseCtx, month: nextMonth };
  const secondRead = applied + failed > 0 ? await readTabs(api) : firstRead;
  await ensureRows(api, tabs);

  const writes: Array<{ range: string; values: CellValue[][] }> = [];
  const clears: string[] = [];
  for (const spec of TABS) {
    const rendered = await spec.render(ctx);
    const errors = errorsByTab.get(spec.name)!;
    const renderedIds = new Set(rendered.map((r) => r.id));
    for (const id of Object.keys(errors.rows)) if (!renderedIds.has(id)) delete errors.rows[id];

    const meta = spec.meta ? await spec.meta.render(ctx) : null;
    const grid = buildGrid(spec, rendered, errors, meta);
    const before = firstRead.get(spec.name) ?? [];
    const now2 = secondRead.get(spec.name) ?? [];
    const editedMeanwhile = !sameGrid(spec, before, now2);

    let snapshot: TabSnapshot;
    if (editedMeanwhile && !createsByTab.get(spec.name)) {
      // Someone typed into this tab during the pass. Leave the tab as they
      // have it; snapshot what was there when the pass started, so their
      // new typing reads as an edit next time and nothing already applied
      // is applied twice.
      snapshot = snapshotFromGrid(spec, before, ctx.month);
    } else {
      if (!sameGrid(spec, grid, now2)) {
        const lastCol = columnLetter(spec.columns.length - 1);
        writes.push({ range: a1(spec.name, `A1:${lastCol}${grid.length}`), values: grid });
        if (now2.length > grid.length) clears.push(a1(spec.name, `A${grid.length + 1}:${lastCol}${now2.length}`));
      }
      snapshot = snapshotFromRendered(spec, rendered, meta, ctx.month);
    }
    await saveTabSnapshot(env.DB, link.household_id, spec.name, snapshot, errors);
  }

  const lists = await renderLists(ctx);
  writes.push({ range: a1(LISTS_TAB, `A1:C${lists.length}`), values: lists });
  clears.push(a1(LISTS_TAB, `A${lists.length + 1}:C`));

  await api.clearRanges(clears);
  await api.writeRanges(writes);
  return { status: "synced", applied, failed, monthShown: nextMonth };
}

// ---------------------------------------------------------------------------
// Reading and diffing
// ---------------------------------------------------------------------------

async function readTabs(api: SheetsApi): Promise<Map<string, CellValue[][]>> {
  const ranges = TABS.map((spec) => a1(spec.name, `A1:${columnLetter(spec.columns.length - 1)}`));
  const grids = await api.readRanges(ranges);
  return new Map(TABS.map((spec, i) => [spec.name, grids[i] ?? []]));
}

function dataRows(spec: TabSpec, grid: CellValue[][]): SheetRow[] {
  return grid.slice(spec.headerRow).map((cells) => rowFromCells(spec.columns, cells));
}

function rowFromCells(columns: Column[], cells: CellValue[]): SheetRow {
  const row: SheetRow = {};
  columns.forEach((column, i) => {
    row[column.key] = cells[i] ?? null;
  });
  return row;
}

export function diffRow(columns: Column[], row: SheetRow, before: Record<string, string>): ChangedCell[] {
  const changes: ChangedCell[] = [];
  for (const column of columns) {
    if (!column.editable && !column.createOnly) continue;
    const now = normalize(column.type, row[column.key] ?? null);
    const was = before[column.key] ?? "";
    if (now !== was) changes.push({ key: column.key, before: was, value: row[column.key] ?? null });
  }
  return changes;
}

function hasContent(columns: Column[], row: SheetRow): boolean {
  return columns.some((c) => (c.editable || c.createOnly) && c.type !== "bool" && !isBlank(row[c.key] ?? null));
}

function pendingCells(columns: Column[], row: SheetRow): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  for (const c of columns) if ((c.editable || c.createOnly) && !isBlank(row[c.key] ?? null)) cells[c.key] = row[c.key] ?? null;
  return cells;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

// ---------------------------------------------------------------------------
// Rendering and writing
// ---------------------------------------------------------------------------

function buildGrid(spec: TabSpec, rendered: RenderedRow[], errors: TabErrors, meta: CellValue[] | null): CellValue[][] {
  const grid: CellValue[][] = [];
  if (spec.headerRow === 2) grid.push(padRow(meta ?? [], spec.columns.length));
  grid.push(spec.columns.map((c) => c.header));
  for (const row of rendered) {
    grid.push(spec.columns.map((c) => (c.key === "sync" ? (errors.rows[row.id]?.message ?? "") : (row.cells[c.key] ?? ""))));
  }
  for (const pending of errors.pending) {
    grid.push(spec.columns.map((c) => (c.key === "sync" ? `Not added yet: ${pending.message}` : (pending.cells[c.key] ?? ""))));
  }
  return grid;
}

function padRow(cells: CellValue[], length: number): CellValue[] {
  const out = cells.slice(0, length);
  while (out.length < length) out.push("");
  return out;
}

/** Two grids say the same thing, column by column, once normalized. */
function sameGrid(spec: TabSpec, a: CellValue[][], b: CellValue[][]): boolean {
  const rows = Math.max(trimmedLength(a), trimmedLength(b));
  for (let r = 0; r < rows; r++) {
    const isData = r >= spec.headerRow;
    for (let c = 0; c < spec.columns.length; c++) {
      const type: ColumnType = isData ? spec.columns[c]!.type : "text";
      if (normalize(type, a[r]?.[c] ?? null) !== normalize(type, b[r]?.[c] ?? null)) return false;
    }
  }
  return true;
}

function trimmedLength(grid: CellValue[][]): number {
  let n = grid.length;
  while (n > 0 && (grid[n - 1] ?? []).every((v) => v === null || v === "" || v === false)) n--;
  return n;
}

function snapshotFromRendered(spec: TabSpec, rendered: RenderedRow[], meta: CellValue[] | null, month: string): TabSnapshot {
  const rows: TabSnapshot["rows"] = {};
  for (const row of rendered) {
    const normalized: Record<string, string> = {};
    for (const c of spec.columns) normalized[c.key] = normalize(c.type, row.cells[c.key] ?? null);
    rows[row.id] = normalized;
  }
  return { rows, month, ...(spec.meta && meta ? { meta: metaSnapshot(spec, meta) } : {}) };
}

function snapshotFromGrid(spec: TabSpec, grid: CellValue[][], month: string): TabSnapshot {
  const rows: TabSnapshot["rows"] = {};
  for (const row of dataRows(spec, grid)) {
    const id = row.id === null || row.id === undefined ? "" : String(row.id).trim();
    if (!id) continue;
    const normalized: Record<string, string> = {};
    for (const c of spec.columns) normalized[c.key] = normalize(c.type, row[c.key] ?? null);
    rows[id] = normalized;
  }
  return { rows, month, ...(spec.meta ? { meta: metaSnapshot(spec, grid[0] ?? []) } : {}) };
}

function metaSnapshot(spec: TabSpec, cells: CellValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of spec.meta!.editable) out[String(m.index)] = normalize(m.type, cells[m.index] ?? null);
  return out;
}

/** Grow a tab before writing past its last row — the Values API won't. */
async function ensureRows(api: SheetsApi, tabs: SheetTabInfo[]): Promise<void> {
  const requests: unknown[] = [];
  for (const tab of tabs) {
    const spec = TABS.find((s) => s.name === tab.title);
    if (!spec) continue;
    const wanted = (spec.minRows ?? 1000) + spec.headerRow;
    if (tab.rowCount < wanted) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: "ROWS", length: wanted - tab.rowCount } });
  }
  await api.batchUpdate(requests);
}

// ---------------------------------------------------------------------------
// Layout: tabs, formats, dropdowns, protection
// ---------------------------------------------------------------------------

const HEADER_BG = { red: 0.2, green: 0.24, blue: 0.3 };
const HEADER_FG = { red: 1, green: 1, blue: 1 };
const READONLY_BG = { red: 0.95, green: 0.95, blue: 0.95 };
const META_BG = { red: 0.91, green: 0.95, blue: 1 };
const MONEY_PATTERN = '"$"#,##0.00;[Red]-"$"#,##0.00';

/** Create missing tabs and (when the layout version moved) re-apply every
 * tab's formatting. Cheap when nothing needs doing: one listTabs call. */
export async function ensureLayout(api: SheetsApi, link: SheetLink, env: Env): Promise<SheetTabInfo[]> {
  let tabs = await api.listTabs();
  const missing = DISPLAY_ORDER.filter((name) => !tabs.some((t) => t.title === name));
  if (missing.length === 0 && link.layout_version >= LAYOUT_VERSION) return tabs;

  if (missing.length > 0) {
    await api.batchUpdate(
      missing.map((name) => {
        const spec = TABS.find((s) => s.name === name);
        return {
          addSheet: {
            properties: {
              title: name,
              index: DISPLAY_ORDER.indexOf(name),
              hidden: name === LISTS_TAB,
              gridProperties: {
                rowCount: (spec?.minRows ?? 1000) + (spec?.headerRow ?? 1),
                columnCount: Math.max(spec?.columns.length ?? 3, 3),
                frozenRowCount: spec?.headerRow ?? (name === README_TAB ? 1 : 0),
              },
            },
          },
        };
      }),
    );
    tabs = await api.listTabs();
    // A new spreadsheet comes with an empty "Sheet1"; ours replace it.
    const stray = tabs.find((t) => /^Sheet1$/i.test(t.title));
    if (stray && tabs.length > 1) {
      await api.batchUpdate([{ deleteSheet: { sheetId: stray.sheetId } }]);
      tabs = await api.listTabs();
    }
  }

  const requests: unknown[] = [];
  for (const tab of tabs) {
    for (const id of tab.ownProtectedRangeIds) requests.push({ deleteProtectedRange: { protectedRangeId: id } });
  }
  const byName = new Map(tabs.map((t) => [t.title, t]));
  for (const spec of TABS) {
    const tab = byName.get(spec.name);
    if (tab) requests.push(...tabFormatRequests(spec, tab.sheetId));
  }
  const readme = byName.get(README_TAB);
  if (readme) {
    requests.push(
      { updateDimensionProperties: { range: { sheetId: readme.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 1000 }, fields: "pixelSize" } },
      {
        repeatCell: {
          range: { sheetId: readme.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
          fields: "userEnteredFormat.textFormat",
        },
      },
      { addProtectedRange: { protectedRange: { range: { sheetId: readme.sheetId }, warningOnly: true, description: `${PROTECTION_PREFIX}readme` } } },
    );
  }
  const lists = byName.get(LISTS_TAB);
  if (lists && !lists.hidden) requests.push({ updateSheetProperties: { properties: { sheetId: lists.sheetId, hidden: true }, fields: "hidden" } });
  await api.batchUpdate(requests);
  await api.writeRanges([{ range: a1(README_TAB, `A1:A${README_ROWS.length}`), values: README_ROWS }]);

  await updateSheetLink(env.DB, link.household_id, { layoutVersion: LAYOUT_VERSION });
  return api.listTabs();
}

function tabFormatRequests(spec: TabSpec, sheetId: number): unknown[] {
  const requests: unknown[] = [];
  const headerIndex = spec.headerRow - 1;
  const width = spec.columns.length;

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: spec.headerRow, frozenColumnCount: 0 } },
      fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: headerIndex, endRowIndex: headerIndex + 1, startColumnIndex: 0, endColumnIndex: width },
      cell: { userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true, foregroundColor: HEADER_FG }, wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
    },
  });
  // Header notes: how to use each column.
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: headerIndex, endRowIndex: headerIndex + 1, startColumnIndex: 0, endColumnIndex: width },
      rows: [{ values: spec.columns.map((c) => ({ note: c.note ?? "" })) }],
      fields: "note",
    },
  });

  spec.columns.forEach((column, index) => {
    const columnRange = { sheetId, startRowIndex: spec.headerRow, startColumnIndex: index, endColumnIndex: index + 1 };
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: column.width ?? 120, hiddenByUser: column.type === "id" },
        fields: "pixelSize,hiddenByUser",
      },
    });

    const readOnly = !column.editable && !column.createOnly;
    const background = readOnly ? READONLY_BG : { red: 1, green: 1, blue: 1 };
    const format = numberFormat(column.type);
    requests.push({
      repeatCell: {
        range: columnRange,
        cell: { userEnteredFormat: format ? { numberFormat: format, backgroundColor: background } : { backgroundColor: background } },
        fields: format ? "userEnteredFormat(numberFormat,backgroundColor)" : "userEnteredFormat.backgroundColor",
      },
    });

    requests.push({ setDataValidation: { range: columnRange, ...(validationRule(column) ? { rule: validationRule(column) } : {}) } });

    if (readOnly) {
      requests.push({
        addProtectedRange: {
          protectedRange: { range: columnRange, warningOnly: true, description: `${PROTECTION_PREFIX}${spec.name}:${column.key}` },
        },
      });
    }
  });

  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, startRowIndex: headerIndex, endRowIndex: headerIndex + 1 },
        warningOnly: true,
        description: `${PROTECTION_PREFIX}${spec.name}:header`,
      },
    },
  });

  if (spec.meta) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
        cell: { userEnteredFormat: { backgroundColor: META_BG, textFormat: { bold: true } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
    const cell = (index: number) => ({ sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1 });
    requests.push(
      { repeatCell: { range: cell(BUDGET_META.month), cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } }, fields: "userEnteredFormat.numberFormat" } },
      { repeatCell: { range: cell(BUDGET_META.ready), cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: MONEY_PATTERN } } }, fields: "userEnteredFormat.numberFormat" } },
      { setDataValidation: { range: cell(BUDGET_META.fund), rule: { condition: { type: "BOOLEAN" } } } },
    );
    for (const index of [BUDGET_META.monthLabel, BUDGET_META.fundLabel, BUDGET_META.readyLabel, BUDGET_META.ready]) {
      requests.push({ addProtectedRange: { protectedRange: { range: cell(index), warningOnly: true, description: `${PROTECTION_PREFIX}${spec.name}:meta${index}` } } });
    }
  }
  return requests;
}

/** Null for checkboxes, which carry their own type. */
function numberFormat(type: ColumnType): Record<string, string> | null {
  switch (type) {
    case "money":
      return { type: "CURRENCY", pattern: MONEY_PATTERN };
    case "date":
      return { type: "DATE", pattern: "yyyy-mm-dd" };
    case "int":
      return { type: "NUMBER", pattern: "0" };
    case "bool":
      return null;
    default:
      return { type: "TEXT" };
  }
}

function validationRule(column: Column): Record<string, unknown> | null {
  if (column.type === "bool") return { condition: { type: "BOOLEAN" } };
  if (column.options) {
    return { condition: { type: "ONE_OF_LIST", values: column.options.map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true };
  }
  if (column.dropdown) {
    const col = { categories: "A", accounts: "B", groups: "C" }[column.dropdown];
    return {
      condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `='${LISTS_TAB}'!$${col}$2:$${col}$500` }] },
      strict: false,
      showCustomUi: true,
    };
  }
  return null;
}

function localDate(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
