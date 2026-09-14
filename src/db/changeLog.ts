import { newId } from "../lib/id";
import type { AgentChangeLogEntry } from "../types";
import { nowIso } from "./client";

/**
 * What the agent wrote, and how to take it back (migration 0011).
 *
 * A dashboard edit has a form to re-open and a row to look at; a text
 * message has neither. "Undo that" — or "undo the grocery change from
 * Tuesday" — is the only correction affordance the surface offers, so
 * every write an agent tool makes lands here with a before-image
 * (src/messaging/undo.ts interprets it) and a summary in the household's
 * own words, which is what a description like "the grocery change" gets
 * matched against.
 */

export interface RecordChangeInput {
  userId: string | null;
  toolName: string;
  summary: string;
  /** A {kind, ...} envelope from src/messaging/undo.ts. */
  undo: unknown;
}

export async function recordChange(db: D1Database, householdId: string, input: RecordChangeInput): Promise<AgentChangeLogEntry> {
  const id = newId("chg");
  const now = nowIso();
  const undo = JSON.stringify(input.undo ?? { kind: "none" });
  await db
    .prepare(
      `INSERT INTO agent_change_log (id, household_id, user_id, tool_name, summary, undo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.userId, input.toolName, input.summary, undo, now)
    .run();
  return {
    id,
    household_id: householdId,
    user_id: input.userId,
    tool_name: input.toolName,
    summary: input.summary,
    undo,
    reverted_at: null,
    reverted_by_id: null,
    created_at: now,
  };
}

export async function listChanges(
  db: D1Database,
  householdId: string,
  opts: { limit?: number; sinceIso?: string; includeReverted?: boolean } = {},
): Promise<AgentChangeLogEntry[]> {
  const clauses = ["household_id = ?"];
  const params: unknown[] = [householdId];
  if (opts.sinceIso) {
    clauses.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (!opts.includeReverted) clauses.push("reverted_at IS NULL");
  const { results } = await db
    .prepare(`SELECT * FROM agent_change_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .bind(...params, opts.limit ?? 25)
    .all<AgentChangeLogEntry>();
  return results;
}

export async function getChange(db: D1Database, householdId: string, id: string): Promise<AgentChangeLogEntry | null> {
  return db.prepare(`SELECT * FROM agent_change_log WHERE id = ? AND household_id = ?`).bind(id, householdId).first<AgentChangeLogEntry>();
}

/** Marks a change reversed and points at the row that reversed it, so the
 * log reads in both directions and nothing gets undone twice. */
export async function markReverted(db: D1Database, householdId: string, id: string, revertedById: string): Promise<void> {
  await db
    .prepare(`UPDATE agent_change_log SET reverted_at = ?, reverted_by_id = ? WHERE id = ? AND household_id = ? AND reverted_at IS NULL`)
    .bind(nowIso(), revertedById, id, householdId)
    .run();
}
