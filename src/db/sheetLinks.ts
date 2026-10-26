import { nowIso } from "./client";

export class SheetAlreadyLinkedError extends Error {
  constructor() {
    super("That sheet is already connected to a different household — make a new sheet for this one.");
    this.name = "SheetAlreadyLinkedError";
  }
}

/** Which Google Sheet mirrors a household's budget, and the sync's own
 * bookkeeping (migration 0012, src/sheets/sync.ts). */
export interface SheetLink {
  household_id: string;
  spreadsheet_id: string;
  view_month: string | null;
  layout_version: number;
  locked_until: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getSheetLink(db: D1Database, householdId: string): Promise<SheetLink | null> {
  return db.prepare(`SELECT * FROM sheet_link WHERE household_id = ?`).bind(householdId).first<SheetLink>();
}

export async function listSheetLinks(db: D1Database): Promise<SheetLink[]> {
  const { results } = await db.prepare(`SELECT * FROM sheet_link`).all<SheetLink>();
  return results;
}

/** Connect (or reconnect) a sheet. A different spreadsheet starts over:
 * its layout is applied fresh and the old snapshots, which describe the
 * old sheet, are dropped so nothing in the new one reads as an edit. */
export async function upsertSheetLink(db: D1Database, householdId: string, spreadsheetId: string): Promise<SheetLink> {
  // Every household syncs through the same service account, so one sheet
  // linked to two households would have each overwriting the other.
  const owner = await findSheetOwner(db, spreadsheetId);
  if (owner && owner !== householdId) throw new SheetAlreadyLinkedError();
  const existing = await getSheetLink(db, householdId);
  const now = nowIso();
  if (existing && existing.spreadsheet_id === spreadsheetId) {
    await db.prepare(`UPDATE sheet_link SET layout_version = 0, last_error = NULL, updated_at = ? WHERE household_id = ?`).bind(now, householdId).run();
  } else {
    await db.batch([
      db.prepare(`DELETE FROM sheet_tab_snapshot WHERE household_id = ?`).bind(householdId),
      db
        .prepare(
          `INSERT INTO sheet_link (household_id, spreadsheet_id, view_month, layout_version, created_at, updated_at)
             VALUES (?, ?, NULL, 0, ?, ?)
           ON CONFLICT(household_id) DO UPDATE SET spreadsheet_id = excluded.spreadsheet_id, view_month = NULL,
             layout_version = 0, last_error = NULL, updated_at = excluded.updated_at`,
        )
        .bind(householdId, spreadsheetId, now, now),
    ]);
  }
  return (await getSheetLink(db, householdId))!;
}

/** Take the household's sync lock for `seconds`. Returns the lock's token,
 * or null when another pass holds it — that pass will pick up whatever this
 * one would have. The token is the expiry plus a random suffix, so it
 * still compares as a time and only its owner can release it. */
export async function acquireSheetLock(db: D1Database, householdId: string, seconds = 240): Promise<string | null> {
  const now = new Date();
  const token = `${new Date(now.getTime() + seconds * 1000).toISOString()}|${crypto.randomUUID()}`;
  const result = await db
    .prepare(`UPDATE sheet_link SET locked_until = ? WHERE household_id = ? AND (locked_until IS NULL OR locked_until < ?)`)
    .bind(token, householdId, now.toISOString())
    .run();
  return result.meta.changes === 1 ? token : null;
}

/** Releases the lock only if it's still this pass's — a pass that ran past
 * its expiry must not free a lock a newer pass now holds. */
export async function releaseSheetLock(db: D1Database, householdId: string, token: string): Promise<void> {
  await db.prepare(`UPDATE sheet_link SET locked_until = NULL WHERE household_id = ? AND locked_until = ?`).bind(householdId, token).run();
}

/** The household a spreadsheet is already linked to, if any. */
export async function findSheetOwner(db: D1Database, spreadsheetId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT household_id FROM sheet_link WHERE spreadsheet_id = ?`).bind(spreadsheetId).first<{ household_id: string }>();
  return row?.household_id ?? null;
}

export async function updateSheetLink(
  db: D1Database,
  householdId: string,
  patch: { viewMonth?: string | null; layoutVersion?: number; lastSyncedAt?: string; lastError?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.viewMonth !== undefined) {
    sets.push("view_month = ?");
    params.push(patch.viewMonth);
  }
  if (patch.layoutVersion !== undefined) {
    sets.push("layout_version = ?");
    params.push(patch.layoutVersion);
  }
  if (patch.lastSyncedAt !== undefined) {
    sets.push("last_synced_at = ?");
    params.push(patch.lastSyncedAt);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    params.push(patch.lastError);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(nowIso());
  await db
    .prepare(`UPDATE sheet_link SET ${sets.join(", ")} WHERE household_id = ?`)
    .bind(...params, householdId)
    .run();
}

export interface TabSnapshot {
  /** Normalized cells by row id, by column key. */
  rows: Record<string, Record<string, string>>;
  /** Normalized meta-row cells by column index, for tabs that have one. */
  meta?: Record<string, string>;
  /** The month a month-scoped tab was showing when this was written. */
  month?: string;
}

export interface TabErrors {
  /** Row id → why an edit to it was refused, and when. */
  rows: Record<string, { message: string; at: string }>;
  /** New rows that couldn't be created yet, kept in the sheet (as typed)
   * so a person can fix them rather than retype them. */
  pending: Array<{ cells: Record<string, string | number | boolean | null>; message: string }>;
}

export async function loadTabSnapshots(
  db: D1Database,
  householdId: string,
): Promise<Map<string, { snapshot: TabSnapshot; errors: TabErrors }>> {
  const { results } = await db
    .prepare(`SELECT tab, snapshot, errors FROM sheet_tab_snapshot WHERE household_id = ?`)
    .bind(householdId)
    .all<{ tab: string; snapshot: string; errors: string }>();
  const out = new Map<string, { snapshot: TabSnapshot; errors: TabErrors }>();
  for (const row of results) {
    const errors = JSON.parse(row.errors || "{}") as Partial<TabErrors>;
    out.set(row.tab, { snapshot: JSON.parse(row.snapshot) as TabSnapshot, errors: { rows: errors.rows ?? {}, pending: errors.pending ?? [] } });
  }
  return out;
}

export async function saveTabSnapshot(db: D1Database, householdId: string, tab: string, snapshot: TabSnapshot, errors: TabErrors): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sheet_tab_snapshot (household_id, tab, snapshot, errors, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(household_id, tab) DO UPDATE SET snapshot = excluded.snapshot, errors = excluded.errors, updated_at = excluded.updated_at`,
    )
    .bind(householdId, tab, JSON.stringify(snapshot), JSON.stringify(errors), nowIso())
    .run();
}
