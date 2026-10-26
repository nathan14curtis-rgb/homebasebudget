import { listCategories } from "../../db/categories";
import { isBlank, parseBool, text } from "../cells";
import { changed, runSheetTool, SheetEditError, withSync, type TabSpec } from "../layout";

/**
 * The whole taxonomy, including the income and transfer categories that
 * have no envelope on the Budget tab. Rename by typing over a name, retire
 * one with Archived, add one on an empty row.
 */
export const categoriesTab: TabSpec = {
  name: "Categories",
  headerRow: 1,
  allowsCreate: true,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "name", header: "Category", type: "text", editable: true, width: 200 },
    {
      key: "kind",
      header: "Kind",
      type: "choice",
      editable: false,
      createOnly: true,
      options: ["expense", "savings", "income"],
      width: 100,
      note: "expense and savings categories get an envelope on the Budget tab. Set when adding; can't be changed later.",
    },
    { key: "archived", header: "Archived", type: "bool", editable: true, width: 90, note: "Ticked = retired: kept for history, no longer offered." },
  ]),

  async render(ctx) {
    const categories = await listCategories(ctx.env.DB, ctx.householdId);
    const kindOrder = { expense: 0, savings: 1, income: 2, transfer: 3 } as const;
    return categories
      .slice()
      .sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || kindOrder[a.kind] - kindOrder[b.kind] || a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, cells: { id: c.id, name: c.name, kind: c.kind, archived: c.archived_at !== null } }));
  },

  async applyEdit(ctx, id, changes) {
    const name = changed(changes, "name");
    if (name) {
      if (isBlank(name.value)) throw new SheetEditError("A category needs a name — tick Archived to retire it instead");
      await runSheetTool(ctx, "rename_category", { category: id, new_name: text(name.value) });
    }
    const archived = changed(changes, "archived");
    if (archived) {
      if (parseBool(archived.value)) await runSheetTool(ctx, "archive_category", { category: id, confirmed: true });
      else await runSheetTool(ctx, "unarchive_category", { category: id });
    }
  },

  async applyCreate(ctx, row) {
    const name = text(row.name);
    if (!name) throw new SheetEditError("Give the new category a name");
    const kind = isBlank(row.kind) ? "expense" : text(row.kind).toLowerCase();
    if (kind !== "expense" && kind !== "savings" && kind !== "income") throw new SheetEditError("Kind is expense, savings or income");
    const created = await runSheetTool(ctx, "create_category", { name, kind });
    return String((created.created as { category_id: string }).category_id);
  },
};
