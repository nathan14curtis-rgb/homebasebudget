import { useMemo, useState, type FormEvent } from "react";
import { api, type Category } from "../api";

interface Props {
  householdId: string;
  categories: Category[];
  onChanged: () => Promise<void>;
}

const KIND_LABELS: Record<Category["kind"], string> = {
  expense: "Expense",
  income: "Income",
  savings: "Savings",
  transfer: "Transfer",
};

/**
 * Every category the household has, grouped by kind.
 *
 * Spending and savings categories are normally managed where their money
 * is — an envelope on the Spending Plan, a bill on the Bills & Income
 * calendar — so this is the back of the drawer: rename anything, archive
 * what is not used, restore what was, and create the income and transfer
 * categories that have no envelope and so appear on neither page.
 *
 * Grouped rather than listed flat because a household starts with about
 * forty seeded categories: one alphabetical run of forty rows is a wall,
 * four labelled runs of ten are a list.
 */
export function CategoriesSection({ householdId, categories, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Category["kind"]>("income");

  const [search, setSearch] = useState("");

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = categories
      .filter((c) => (showArchived ? c.archived_at : !c.archived_at))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
    const order: Category["kind"][] = ["expense", "savings", "income", "transfer"];
    return order
      .map((kind) => ({ kind, items: visible.filter((c) => c.kind === kind) }))
      .filter((g) => g.items.length > 0);
  }, [categories, showArchived, search]);
  const visibleCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  async function rename(id: string) {
    setError(null);
    try {
      await api.renameCategory(householdId, id, editName.trim());
      setEditingId(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  async function toggleArchived(category: Category) {
    setError(null);
    try {
      if (category.archived_at) await api.unarchiveCategory(householdId, category.id);
      else await api.archiveCategory(householdId, category.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createCategory(householdId, { name: newName.trim(), kind: newKind });
      setNewName("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add category");
    }
  }

  return (
    <section className="card">
      <h2>Categories</h2>
      <p className="hint">
        Spending envelopes are set up on the Spending Plan and bills on the Bills &amp; Income calendar, where their money is. Everything
        can be renamed or archived here.
      </p>

      <div className="row" style={{ margin: "12px 0" }}>
        <input
          type="text"
          aria-label="Search categories"
          placeholder="Search categories…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <label className="row" style={{ gap: "0.35rem" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
      </div>

      {groups.map((group) => (
      <div key={group.kind}>
      <p className="envelope-group-heading">{KIND_LABELS[group.kind]}</p>
      <ul className="list">
        {group.items.map((c) => (
          <li key={c.id}>
            {editingId === c.id ? (
              <span className="row" style={{ flex: 1 }}>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 160 }} />
                <button className="secondary" onClick={() => rename(c.id)}>
                  Save
                </button>
                <button className="secondary" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <span>{c.name}</span>
                <span className="row">
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditingId(c.id);
                      setEditName(c.name);
                    }}
                  >
                    Rename
                  </button>
                  <button className={c.archived_at ? "secondary" : "danger"} onClick={() => toggleArchived(c)}>
                    {c.archived_at ? "Restore" : "Archive"}
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      </div>
      ))}
      {visibleCount === 0 && <p className="hint">{search.trim() ? `Nothing matching “${search.trim()}”.` : "Nothing here."}</p>}

      <form className="row" onSubmit={addCategory} style={{ marginTop: "0.75rem" }}>
        <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as Category["kind"])}>
          <option value="income">Income</option>
          <option value="transfer">Transfer</option>
        </select>
        <button type="submit" className="secondary">
          Add
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
