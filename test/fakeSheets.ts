import type { CellValue, SheetsApi, SheetTabInfo } from "../src/sheets/client";

/**
 * An in-memory spreadsheet that answers the same calls src/sheets/sync.ts
 * makes of Google. Values come back the way Google returns them for a
 * RAW-written sheet: strings, numbers and booleans as written, empty
 * trailing rows dropped.
 */
export class FakeSheets implements SheetsApi {
  tabs = new Map<string, { sheetId: number; grid: CellValue[][]; hidden: boolean; rowCount: number }>();
  private nextId = 1;
  writeCalls = 0;

  constructor() {
    this.tabs.set("Sheet1", { sheetId: 0, grid: [], hidden: false, rowCount: 1000 });
  }

  async listTabs(): Promise<SheetTabInfo[]> {
    return [...this.tabs.entries()].map(([title, t]) => ({ sheetId: t.sheetId, title, rowCount: t.rowCount, hidden: t.hidden, ownProtectedRangeIds: [] }));
  }

  async batchUpdate(requests: unknown[]): Promise<void> {
    for (const request of requests as Array<Record<string, any>>) {
      if (request.addSheet) {
        const p = request.addSheet.properties;
        this.tabs.set(p.title, { sheetId: this.nextId++, grid: [], hidden: !!p.hidden, rowCount: p.gridProperties?.rowCount ?? 1000 });
      } else if (request.deleteSheet) {
        for (const [title, t] of this.tabs) if (t.sheetId === request.deleteSheet.sheetId) this.tabs.delete(title);
      } else if (request.appendDimension) {
        for (const t of this.tabs.values()) if (t.sheetId === request.appendDimension.sheetId) t.rowCount += request.appendDimension.length;
      }
    }
  }

  async readRanges(ranges: string[]): Promise<CellValue[][][]> {
    return ranges.map((range) => {
      const { tab } = parseRange(range);
      const grid = this.tabs.get(tab)?.grid ?? [];
      const out = grid.map((row) => {
        const copy = row.slice();
        while (copy.length > 0 && (copy[copy.length - 1] === "" || copy[copy.length - 1] === null || copy[copy.length - 1] === undefined)) copy.pop();
        return copy;
      });
      while (out.length > 0 && out[out.length - 1]!.length === 0) out.pop();
      return out;
    });
  }

  async writeRanges(data: Array<{ range: string; values: CellValue[][] }>): Promise<void> {
    this.writeCalls++;
    for (const { range, values } of data) {
      const { tab, row, col } = parseRange(range);
      const t = this.tabs.get(tab);
      if (!t) throw new Error(`no tab ${tab}`);
      values.forEach((cells, r) => {
        const target = (t.grid[row + r] ??= []);
        cells.forEach((v, c) => {
          target[col + c] = v === null ? "" : v;
        });
      });
    }
  }

  async clearRanges(ranges: string[]): Promise<void> {
    for (const range of ranges) {
      const { tab, row } = parseRange(range);
      const t = this.tabs.get(tab);
      if (t) t.grid.length = Math.min(t.grid.length, row);
    }
  }

  // --- test helpers -------------------------------------------------------

  grid(tab: string): CellValue[][] {
    return this.tabs.get(tab)!.grid;
  }

  headers(tab: string, headerRow = 1): string[] {
    return (this.grid(tab)[headerRow - 1] ?? []).map(String);
  }

  /** The data row whose `match` column equals `value`, as {header: cell}. */
  findRow(tab: string, header: string, value: CellValue, headerRow = 1): { index: number; cells: Record<string, CellValue> } | null {
    const headers = this.headers(tab, headerRow);
    const col = headers.indexOf(header);
    const grid = this.grid(tab);
    for (let i = headerRow; i < grid.length; i++) {
      if (grid[i]?.[col] === value) {
        const cells: Record<string, CellValue> = {};
        headers.forEach((h, c) => (cells[h] = grid[i]?.[c] ?? ""));
        return { index: i, cells };
      }
    }
    return null;
  }

  /** What a person typing into the sheet does. */
  type(tab: string, rowIndex: number, header: string, value: CellValue, headerRow = 1): void {
    const col = this.headers(tab, headerRow).indexOf(header);
    if (col < 0) throw new Error(`no column ${header} on ${tab}`);
    const grid = this.grid(tab);
    const row = (grid[rowIndex] ??= []);
    row[col] = value;
  }

  /** Types a whole new row under the last one. */
  addRow(tab: string, values: Record<string, CellValue>, headerRow = 1): number {
    const index = Math.max(this.grid(tab).length, headerRow);
    for (const [header, value] of Object.entries(values)) this.type(tab, index, header, value, headerRow);
    return index;
  }
}

function parseRange(range: string): { tab: string; row: number; col: number } {
  const m = range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d*)/);
  if (!m) throw new Error(`bad range ${range}`);
  const letters = m[2]!;
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { tab: m[1]!.replace(/''/g, "'"), row: m[3] ? Number(m[3]) - 1 : 0, col: col - 1 };
}
