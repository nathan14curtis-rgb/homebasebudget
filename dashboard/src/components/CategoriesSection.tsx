import { useMemo, useState, type FormEvent } from "react";
import { api, type Category } from "../api";
import { VALIDATION } from "../copy";
import { Notice, useAction } from "./Notice";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  householdId: string;
  categories: Category[];
  onChanged: () => Promise<void>;
}

const KIND_LABELS: Record<Category["kind"], string> = {
  expense: "Spending",
  income: "Income",
  savings: "Goals",
  transfer: "Transfers",
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Category["kind"]>("income");
  const [archiving, setArchiving] = useState<Category | null>(null);
  const [search, setSearch] = useState("");
  const action = useAction();

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = categories
      .filter((c) => (showArchived ? c.archived_at : !c.archived_at))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
    const order: Category["kind"][] = ["expense", "savings", "income", "transfer"];
    return order.map((kind) => ({ kind, items: visible.filter((c) => c.kind === kind) })).filter((g) => g.items.length > 0);
  }, [categories, showArchived, search]);
  const visibleCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  async function rename(c: Category) {
    const trimmed = editName.trim();
    if (!trimmed) return action.showError(VALIDATION.name);
    const ok = await action.run(
      async () => {
        await api.renameCategory(householdId, c.id, trimmed);
        await onChanged();
      },
      { key: c.id },
    );
    if (ok) setEditingId(null);
  }

  function restore(c: Category) {
    void action.run(
      async () => {
        await api.unarchiveCategory(householdId, c.id);
        await onChanged();
      },
      { key: c.id, success: `${c.name} restored.` },
    );
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return action.showError(VALIDATION.name);
    const ok = await action.run(
      async () => {
        await api.createCategory(householdId, { name: trimmed, kind: newKind });
        await onChanged();
      },
      { key: "add", success: `${trimmed} added.` },
    );
    if (ok) setNewName("");
  }

  return (
    <section className="card">
      <h2>Categories</h2>
      <p className="hint">
        Spending envelopes are set up on the Spending Plan and bills on the Bills &amp; Income calendar, where their money is. Everything can be
        renamed or archived here, and an archived one restored.
      </p>

      <div className="row" style={{ margin: "12px 0" }}>
        <input type="text" aria-label="Search categories" placeholder="Search categories…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <label className="row" style={{ gap: "0.35rem" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
      </div>

      {groups.map((group) => (
        <div key={group.kind}>
          <p className="envelope-group-heading">{KIND_LABELS[group.kind]}</p>
          <ul className="list">
            {group.items.map((c) => {
              const busy = action.busyKey === c.id;
              return (
                <li key={c.id}>
                  {editingId === c.id ? (
                    <span className="row" style={{ flex: 1 }}>
                      <input
                        type="text"
                        aria-label="New name"
                        value={editName}
                        disabled={busy}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void rename(c);
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        style={{ width: 160 }}
                      />
                      <button type="button" onClick={() => rename(c)} disabled={busy}>
                        {busy ? "Saving…" : "Save"}
                      </button>
                      <button className="secondary" type="button" onClick={() => setEditingId(null)} disabled={busy}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <>
                      <span>{c.name}</span>
                      <span className="row">
                        <button
                          className="secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(c.id);
                            setEditName(c.name);
                          }}
                        >
                          Rename
                        </button>
                        {c.archived_at ? (
                          <button className="secondary" type="button" disabled={busy} onClick={() => restore(c)}>
                            {busy ? "Restoring…" : "Restore"}
                          </button>
                        ) : (
                          <button className="danger" type="button" disabled={busy} onClick={() => setArchiving(c)}>
                            Archive
                          </button>
                        )}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {visibleCount === 0 && <p className="hint">{search.trim() ? `Nothing matching “${search.trim()}”.` : showArchived ? "Nothing archived." : "No categories yet."}</p>}

      <form className="row" onSubmit={addCategory} style={{ marginTop: "0.75rem", alignItems: "flex-end" }}>
        <div className="field-inline" style={{ flex: 1 }}>
          <label htmlFor="category-new-name">New category</label>
          <input id="category-new-name" type="text" value={newName} disabled={action.busy} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="field-inline">
          <label htmlFor="category-new-kind">Kind</label>
          <select id="category-new-kind" value={newKind} disabled={action.busy} onChange={(e) => setNewKind(e.target.value as Category["kind"])}>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </select>
        </div>
        <button type="submit" className="secondary" disabled={action.busy}>
          {action.busyKey === "add" ? "Adding…" : "Add category"}
        </button>
      </form>
      <p className="hint">Spending and goal categories are created on the Spending Plan, so they get an envelope.</p>

      <Notice notice={action.notice} onDismiss={action.clear} style={{ marginTop: 12 }} />

      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          body="It stops showing anywhere you pick a category. Transactions already filed under it keep it, and you can restore it here with “Show archived”."
          confirmLabel="Archive"
          onCancel={() => setArchiving(null)}
          onConfirm={async () => {
            const c = archiving;
            await api.archiveCategory(householdId, c.id);
            setArchiving(null);
            await action.run(onChanged, { success: `${c.name} archived.` });
          }}
        />
      )}
    </section>
  );
}
