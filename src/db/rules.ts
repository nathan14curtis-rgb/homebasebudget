import { newId } from "../lib/id";
import type { Condition, Action } from "../categorization/rules";
import type { Rule, RuleSource } from "../types";
import { listScoped, nowIso } from "./client";

export async function listRules(db: D1Database, householdId: string): Promise<Rule[]> {
  return listScoped<Rule>(db, "rule", householdId, "priority, created_at");
}

export async function createRule(
  db: D1Database,
  householdId: string,
  input: { priority?: number; conditions: Condition; actions: Action[]; source?: RuleSource },
): Promise<Rule> {
  const id = newId("rul");
  const now = nowIso();
  const priority = input.priority ?? 100;
  const conditions = JSON.stringify(input.conditions);
  const actions = JSON.stringify(input.actions);
  const source = input.source ?? "user";
  await db
    .prepare(
      `INSERT INTO rule (id, household_id, priority, conditions, actions, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, priority, conditions, actions, source, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    priority,
    conditions,
    actions,
    source,
    match_count: 0,
    enabled: 1,
    created_at: now,
    updated_at: now,
  };
}

export async function incrementRuleMatchCount(db: D1Database, householdId: string, ruleId: string): Promise<void> {
  await db
    .prepare(`UPDATE rule SET match_count = match_count + 1, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(nowIso(), ruleId, householdId)
    .run();
}

/** Removing a standing rule — "stop always filing Amazon as shopping".
 * Rules are advisory: deleting one changes nothing about the transactions
 * it already categorized, only what happens to the next charge. */
export async function deleteRule(db: D1Database, householdId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM rule WHERE id = ? AND household_id = ?`).bind(id, householdId).run();
}
