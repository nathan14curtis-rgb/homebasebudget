import { useMemo, useState, type FormEvent } from "react";
import { api, type Account, type AccessLevel, type Transaction, type User } from "../api";
import { currentMonth, formatCents } from "../format";

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

const ACCESS_LABEL: Record<AccessLevel, string> = { full: "full", limited: "limited", view_only: "view only" };
const ACCESS_BADGE_CLASS: Record<AccessLevel, string> = { full: "badge", limited: "badge", view_only: "badge badge--muted" };

interface EditDraft {
  role: string;
  accessLevel: AccessLevel;
  weeklyAllowance: string;
  note: string;
}

export function MembersPage({ householdId, users, accounts, transactions, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, EditDraft>>({});
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("");

  const month = currentMonth();
  const spentByUser = useMemo(() => {
    const accountOwner = new Map(accounts.map((a) => [a.id, a.owner_user_id]));
    const totals = new Map<string, number>();
    for (const t of transactions) {
      if (t.amount_cents >= 0 || t.is_transfer || t.excluded_from_budget || !t.posted_at.startsWith(month)) continue;
      const ownerId = accountOwner.get(t.account_id);
      if (!ownerId) continue;
      totals.set(ownerId, (totals.get(ownerId) ?? 0) - t.amount_cents);
    }
    return totals;
  }, [accounts, transactions, month]);

  function startEdit(u: User) {
    setEditing((prev) => ({
      ...prev,
      [u.id]: {
        role: u.role ?? "",
        accessLevel: u.access_level,
        weeklyAllowance: u.weekly_allowance_cents ? (u.weekly_allowance_cents / 100).toString() : "",
        note: u.note ?? "",
      },
    }));
  }

  async function saveEdit(userId: string) {
    const draft = editing[userId];
    if (!draft) return;
    setError(null);
    try {
      await api.updateUser(householdId, userId, {
        role: draft.role.trim() || null,
        accessLevel: draft.accessLevel,
        weeklyAllowanceCents: draft.weeklyAllowance.trim() ? Math.round(Number(draft.weeklyAllowance) * 100) : null,
        note: draft.note.trim() || null,
      });
      setEditing((prev) => {
        const { [userId]: _, ...rest } = prev;
        return rest;
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update member");
    }
  }

  async function inviteMember(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(householdId, { name: newName.trim(), role: newRole.trim() || undefined });
      setNewName("");
      setNewRole("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite member");
    }
  }

  return (
    <div className="section">
      <div className="grid-2">
        {users.map((u) => {
          const draft = editing[u.id];
          return (
            <div className="card card--padded" key={u.id} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div className="row" style={{ gap: 16, alignItems: "center" }}>
                <span className="row-avatar" style={{ width: 48, height: 48, fontSize: 16 }}>
                  {u.name
                    .split(" ")
                    .map((w) => w[0])
                    .join("")}
                </span>
                <div className="row-figure">
                  <span style={{ fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>{u.name}</span>
                  <span className="row-meta">{u.role ?? "Member"}</span>
                </div>
                <span className={ACCESS_BADGE_CLASS[u.access_level]} style={{ marginLeft: "auto" }}>
                  {ACCESS_LABEL[u.access_level]}
                </span>
              </div>

              <div className="row" style={{ gap: 32, borderTop: "1px solid var(--divider)", paddingTop: 20 }}>
                <div className="stat-tile">
                  <span className="label">Spent this month</span>
                  <span className="figure figure--small">{formatCents(spentByUser.get(u.id) ?? 0)}</span>
                </div>
                <div className="stat-tile">
                  <span className="label">Weekly allowance</span>
                  <span className="figure figure--small">{u.weekly_allowance_cents ? formatCents(u.weekly_allowance_cents) : "—"}</span>
                </div>
              </div>

              {u.note && !draft && <span style={{ fontSize: 14, color: "var(--body-text)" }}>{u.note}</span>}

              {draft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="row">
                    <input type="text" placeholder="Role (e.g. Parent · admin)" value={draft.role} onChange={(e) => setEditing((p) => ({ ...p, [u.id]: { ...draft, role: e.target.value } }))} style={{ flex: 1 }} />
                    <select value={draft.accessLevel} onChange={(e) => setEditing((p) => ({ ...p, [u.id]: { ...draft, accessLevel: e.target.value as AccessLevel } }))}>
                      <option value="full">Full access</option>
                      <option value="limited">Limited access</option>
                      <option value="view_only">View only</option>
                    </select>
                  </div>
                  <div className="row">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Weekly allowance $"
                      value={draft.weeklyAllowance}
                      onChange={(e) => setEditing((p) => ({ ...p, [u.id]: { ...draft, weeklyAllowance: e.target.value } }))}
                      style={{ width: 160 }}
                    />
                    <input
                      type="text"
                      placeholder="Note"
                      value={draft.note}
                      onChange={(e) => setEditing((p) => ({ ...p, [u.id]: { ...draft, note: e.target.value } }))}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <button className="secondary" onClick={() => saveEdit(u.id)} style={{ alignSelf: "flex-start" }}>
                    Save
                  </button>
                </div>
              ) : (
                <button className="secondary" onClick={() => startEdit(u)} style={{ alignSelf: "flex-start" }}>
                  Edit
                </button>
              )}
            </div>
          );
        })}
        {users.length === 0 && <p className="hint">No members yet — invite one below.</p>}
      </div>

      <section className="card card--padded" id="page-add-form">
        <h2>Invite member</h2>
        <form onSubmit={inviteMember}>
          <div className="row">
            <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
            <input type="text" placeholder="Role (e.g. Age 16)" value={newRole} onChange={(e) => setNewRole(e.target.value)} style={{ width: 180 }} />
            <button type="submit">Invite</button>
          </div>
        </form>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
