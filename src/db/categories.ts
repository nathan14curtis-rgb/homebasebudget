import { newId } from "../lib/id";
import { DEFAULT_CATEGORIES } from "../lib/defaultCategories";
import type { Category, CategoryKind, Envelope, RolloverMode } from "../types";
import { getScoped, listScoped, NotFoundError, nowIso } from "./client";
import { archiveEnvelopeForCategory, unarchiveEnvelopeForCategory } from "./envelopes";

export async function listCategories(db: D1Database, householdId: string): Promise<Category[]> {
  return listScoped<Category>(db, "category", householdId, "sort_order, name");
}

export async function getCategory(db: D1Database, householdId: string, id: string): Promise<Category> {
  return getScoped<Category>(db, "category", householdId, id);
}

/** The category a positive-amount transaction should default to when
 * nothing more specific matches (src/categorization/defaultIncomeRule.ts).
 * Prefers the seeded "Other Income" by name since it's the generic catch-
 * all; falls back to whatever income-kind category exists if the
 * household renamed or replaced its taxonomy, and to null only if there's
 * no income category at all to file under. */
export async function getDefaultIncomeCategory(db: D1Database, householdId: string): Promise<Category | null> {
  const categories = await listCategories(db, householdId);
  const income = categories.filter((c) => c.kind === "income" && !c.archived_at);
  if (income.length === 0) return null;
  return income.find((c) => c.name.toLowerCase() === "other income") ?? income[0]!;
}

export async function createCategory(
  db: D1Database,
  householdId: string,
  input: { name: string; kind: CategoryKind; parentId?: string | null; sortOrder?: number },
): Promise<Category> {
  const id = newId("cat");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO category (id, household_id, parent_id, name, kind, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.parentId ?? null, input.name, input.kind, input.sortOrder ?? 0, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    parent_id: input.parentId ?? null,
    name: input.name,
    kind: input.kind,
    sort_order: input.sortOrder ?? 0,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Every expense/savings category is also an envelope (PLAN.md §3: "One
 * concept, less code"). Income and transfer categories are never funded. */
export async function createEnvelopeForCategory(
  db: D1Database,
  householdId: string,
  category: Category,
  opts: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null; rolloverMode?: RolloverMode } = {},
): Promise<Envelope> {
  if (category.kind !== "expense" && category.kind !== "savings") {
    throw new Error(`category kind '${category.kind}' is not funded and has no envelope`);
  }
  const id = newId("env");
  const now = nowIso();
  const groupName = opts.groupName ?? "Uncategorized";
  const rolloverMode = opts.rolloverMode ?? "carry";
  await db
    .prepare(
      `INSERT INTO envelope (id, household_id, category_id, group_name, sort_order, monthly_target_cents, target_date, rollover_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      householdId,
      category.id,
      groupName,
      0,
      opts.monthlyTargetCents ?? null,
      opts.targetDate ?? null,
      rolloverMode,
      now,
      now,
    )
    .run();
  return {
    id,
    household_id: householdId,
    category_id: category.id,
    group_name: groupName,
    sort_order: 0,
    monthly_target_cents: opts.monthlyTargetCents ?? null,
    target_date: opts.targetDate ?? null,
    rollover_mode: rolloverMode,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Rename only — kind is fixed at creation (changing it would orphan the
 * envelope/no-envelope relationship the dashboard and cascade both rely
 * on), so editing that means archiving this category and creating a new
 * one instead. */
export async function renameCategory(db: D1Database, householdId: string, id: string, name: string): Promise<Category> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE category SET name = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(name, now, id, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("category", id);
  return getCategory(db, householdId, id);
}

/** Archive, never delete (historical transactions reference it) — hides it
 * from the taxonomy the categorization cascade and dashboard offer, but a
 * transaction already filed under it keeps working. Archives its envelope
 * too, since one can't be archived without the other going stale. */
export async function archiveCategory(db: D1Database, householdId: string, id: string): Promise<Category> {
  const category = await getCategory(db, householdId, id);
  const now = nowIso();
  await db.prepare(`UPDATE category SET archived_at = ?, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, now, id, householdId).run();
  if (category.kind === "expense" || category.kind === "savings") {
    await archiveEnvelopeForCategory(db, householdId, id);
  }
  return { ...category, archived_at: now, updated_at: now };
}

export async function unarchiveCategory(db: D1Database, householdId: string, id: string): Promise<Category> {
  const category = await getCategory(db, householdId, id);
  const now = nowIso();
  await db.prepare(`UPDATE category SET archived_at = NULL, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, id, householdId).run();
  if (category.kind === "expense" || category.kind === "savings") {
    await unarchiveEnvelopeForCategory(db, householdId, id);
  }
  return { ...category, archived_at: null, updated_at: now };
}

export async function seedDefaultCategories(db: D1Database, householdId: string): Promise<void> {
  let sortOrder = 0;
  for (const def of DEFAULT_CATEGORIES) {
    const category = await createCategory(db, householdId, {
      name: def.name,
      kind: def.kind,
      sortOrder: sortOrder++,
    });
    if (def.kind === "expense" || def.kind === "savings") {
      await createEnvelopeForCategory(db, householdId, category, {
        groupName: def.group,
        monthlyTargetCents: def.monthlyTargetCents ?? null,
      });
    }
  }
}
