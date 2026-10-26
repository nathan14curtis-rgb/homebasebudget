import type { CellValue } from "./client";

/**
 * How a cell's value is compared and read back.
 *
 * The diff that decides "did a person change this?" compares normalized
 * strings, not raw cell values: Sheets hands back 120 for a cell the app
 * wrote as 120.00, "2026-10-05" for a cell someone typed as 10/5/2026, and
 * TRUE for a ticked checkbox. Normalizing both sides the same way is what
 * keeps a cosmetic difference from looking like an edit.
 */

export type ColumnType = "id" | "text" | "choice" | "money" | "date" | "bool" | "int" | "tags";

export function normalize(type: ColumnType, value: CellValue | undefined): string {
  if (value === null || value === undefined) return type === "bool" ? "false" : "";
  switch (type) {
    case "money": {
      const cents = parseMoneyCents(value);
      return cents === null ? String(value).trim() : String(cents);
    }
    case "date": {
      const date = parseDate(value);
      return date ?? String(value).trim();
    }
    case "bool":
      return parseBool(value) ? "true" : "false";
    case "int": {
      const n = parseIntCell(value);
      return n === null ? String(value).trim() : String(n);
    }
    case "choice":
      return String(value).trim().toLowerCase();
    case "tags":
      return parseTags(value)
        .map((t) => t.toLowerCase())
        .sort()
        .join(", ");
    case "id":
    case "text":
    default:
      return String(value).trim();
  }
}

export function isBlank(value: CellValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "") || value === false;
}

/** Dollars in a cell → integer cents. Accepts 120, "120", "$1,200.50", "-45", "(45)". */
export function parseMoneyCents(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value === "boolean") return null;
  let text = value.trim();
  if (text === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[$,\s]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return negative ? -cents : cents;
}

export function parseMoneyDollars(value: CellValue | undefined): number | null {
  const cents = parseMoneyCents(value);
  return cents === null ? null : cents / 100;
}

/** A date cell → 'YYYY-MM-DD'. Accepts ISO, M/D/YYYY, M/D/YY, and a
 * Sheets serial number (days since 1899-12-30) in case a cell comes back
 * unformatted. */
export function parseDate(value: CellValue | undefined): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (value < 20000 || value > 80000) return null;
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const text = value.trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDate(year, Number(m[1]), Number(m[2]));
  }
  return null;
}

function validDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' from a month cell, which Sheets may have turned into a date. */
export function parseMonth(value: CellValue | undefined): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, "0")}` : null;
  }
  const date = parseDate(value);
  if (date) return date.slice(0, 7);
  const named = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const index = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[1]!.slice(0, 3).toLowerCase());
    if (index >= 0) return `${named[2]}-${String(index + 1).padStart(2, "0")}`;
  }
  return null;
}

export function parseBool(value: CellValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "yes", "y", "x", "1", "✓"].includes(value.trim().toLowerCase());
  return false;
}

export function parseIntCell(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

export function parseTags(value: CellValue | undefined): string[] {
  if (value === null || value === undefined || typeof value === "boolean") return [];
  return String(value)
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

export function text(value: CellValue | undefined): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function centsToDollars(cents: number | null | undefined): number | null {
  return cents === null || cents === undefined ? null : Math.round(cents) / 100;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseWeekday(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value >= 0 && value <= 6 ? value : null;
  const needle = String(value).trim().slice(0, 3).toLowerCase();
  const index = WEEKDAYS.findIndex((d) => d.slice(0, 3).toLowerCase() === needle);
  return index >= 0 ? index : null;
}
