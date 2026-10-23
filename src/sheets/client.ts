import { getGoogleAccessToken } from "./googleAuth";

/**
 * The handful of Sheets API calls the sync needs, behind an interface so
 * tests can run the whole read → apply → render loop against an in-memory
 * sheet (test/sheetSync.integration.test.ts) instead of Google.
 */

export type CellValue = string | number | boolean | null;

export interface SheetTabInfo {
  sheetId: number;
  title: string;
  rowCount: number;
  hidden: boolean;
  /** Ids of protected ranges this app created (description starts with
   * PROTECTION_PREFIX), so a layout refresh can replace rather than stack them. */
  ownProtectedRangeIds: number[];
}

export const PROTECTION_PREFIX = "homebase:";

export interface SheetsApi {
  listTabs(): Promise<SheetTabInfo[]>;
  /** spreadsheets.batchUpdate — structural and formatting requests. */
  batchUpdate(requests: unknown[]): Promise<void>;
  /** values.batchGet. Numbers and booleans come back as themselves; dates
   * and everything else as the displayed string. One grid per range. */
  readRanges(ranges: string[]): Promise<CellValue[][][]>;
  /** values.batchUpdate with RAW input — nothing typed by a bank (a payee
   * starting with '=' or '+') is ever interpreted as a formula. */
  writeRanges(data: Array<{ range: string; values: CellValue[][] }>): Promise<void>;
  clearRanges(ranges: string[]): Promise<void>;
}

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleSheetsApi implements SheetsApi {
  constructor(
    private readonly spreadsheetId: string,
    private readonly serviceAccountJson: string | undefined,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getGoogleAccessToken(this.serviceAccountJson);
    const response = await fetch(`${API}/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      if (response.status === 403 || response.status === 404) {
        throw new Error(
          `Google Sheets refused access (${response.status}). Share the sheet with the service account's email as an Editor. Details: ${text}`,
        );
      }
      throw new Error(`Google Sheets API ${response.status}: ${text}`);
    }
    return (await response.json()) as T;
  }

  async listTabs(): Promise<SheetTabInfo[]> {
    const body = await this.call<{
      sheets?: Array<{
        properties: { sheetId: number; title: string; hidden?: boolean; gridProperties?: { rowCount?: number } };
        protectedRanges?: Array<{ protectedRangeId: number; description?: string }>;
      }>;
    }>(`?fields=${encodeURIComponent("sheets(properties(sheetId,title,hidden,gridProperties(rowCount)),protectedRanges(protectedRangeId,description))")}`);
    return (body.sheets ?? []).map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      rowCount: s.properties.gridProperties?.rowCount ?? 1000,
      hidden: s.properties.hidden ?? false,
      ownProtectedRangeIds: (s.protectedRanges ?? [])
        .filter((p) => (p.description ?? "").startsWith(PROTECTION_PREFIX))
        .map((p) => p.protectedRangeId),
    }));
  }

  async batchUpdate(requests: unknown[]): Promise<void> {
    if (requests.length === 0) return;
    await this.call(":batchUpdate", { method: "POST", body: JSON.stringify({ requests }) });
  }

  async readRanges(ranges: string[]): Promise<CellValue[][][]> {
    if (ranges.length === 0) return [];
    const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
    for (const range of ranges) params.append("ranges", range);
    const body = await this.call<{ valueRanges?: Array<{ values?: CellValue[][] }> }>(`/values:batchGet?${params.toString()}`);
    return ranges.map((_, i) => body.valueRanges?.[i]?.values ?? []);
  }

  async writeRanges(data: Array<{ range: string; values: CellValue[][] }>): Promise<void> {
    if (data.length === 0) return;
    await this.call("/values:batchUpdate", {
      method: "POST",
      // Google treats null as "leave the cell alone"; an empty string clears it.
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: data.map((d) => ({ range: d.range, values: d.values.map((row) => row.map((v) => (v === null ? "" : v))) })),
      }),
    });
  }

  async clearRanges(ranges: string[]): Promise<void> {
    if (ranges.length === 0) return;
    await this.call("/values:batchClear", { method: "POST", body: JSON.stringify({ ranges }) });
  }
}

/** 'Tab'!A1 notation, quoting the tab name the way Sheets expects. */
export function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Pulls the spreadsheet id out of a docs.google.com URL, or accepts a
 * bare id. */
export function parseSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1]!;
  return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}
