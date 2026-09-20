import { useMemo, useState } from "react";
import { api, type Account, type AccessLevel, type Transaction, type User } from "../api";
import { currentMonth, formatCents } from "../format";
import { parseMoney, moneyToInput } from "../money";
import { usePageAction } from "../pageAction";
import { VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { MoneyInput } from "./MoneyInput";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

const ACCESS_LABEL: Record<AccessLevel, string> = { full: "Full access", limited: "Limited", view_only: "View only" };
const ACCESS_BADGE_CLASS: Record<AccessLevel, string> = { full: "badge badge--soft", limited: "badge badge--soft", view_only: "badge badge--soft badge--muted" };

/** Add and edit are the same questions, so they are one dialog. */
function MemberModal({ householdId, user, onClose, onSaved }: { householdId: string; user?: User; onClose: () => void; onSaved: () => Promise<void> }) {
  const editing = Boolean(user);
  const [name, setName] = useState(user?.name ?? "");
  const [role, setRole] = useState(user?.role ?? "");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>(user?.access_level ?? "full");
  const [weeklyAllowance, setWeeklyAllowance] = useState(moneyToInput(user?.weekly_allowance_cents ?? null));
  const [note, setNote] = useState(user?.note ?? "");
  const action = useAction();

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return action.showError(VALIDATION.name);
    const allowanceCents = weeklyAllowance.trim() ? parseMoney(weeklyAllowance) : null;
    if (weeklyAllowance.trim() && allowanceCents === null) return action.showError(VALIDATION.amount);
    const ok = await action.run(async () => {
      if (user) {
        await api.updateUser(householdId, user.id, {
          role: role.trim() || null,
          accessLevel,
          weeklyAllowanceCents: allowanceCents,
          note: note.trim() || null,
        });
      } else {
        await api.createUser(householdId, { name: trimmedName, role: role.trim() || undefined });
      }
      await onSaved();
    });
    if (ok) onClose();
  }

  return (
    <Modal
      title={editing ? `Edit ${user!.name}` : "Add member"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={action.busy}>
            {action.busy ? "Saving…" : editing ? "Save" : "Add member"}
          </button>
        </>
      }
    >
      {!editing && (
        <div className="field">
          <label htmlFor="member-name">Name</label>
          <input id="member-name" type="text" data-autofocus="true" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor="member-role">Role</label>
        <input
          id="member-role"
          type="text"
          data-autofocus={editing ? "true" : undefined}
          placeholder="e.g. Parent, or Age 16"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </div>
      {editing && (
        <>
          <div className="field">
            <label htmlFor="member-access">What they can change by text</label>
            <select id="member-access" value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}>
              <option value="full">Full access — anything</option>
              <option value="limited">Limited — categorize and tag, but not re-plan</option>
              <option value="view_only">View only — ask anything, change nothing</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="member-allowance">Weekly allowance</label>
            <MoneyInput id="member-allowance" value={weeklyAllowance} onChange={setWeeklyAllowance} disabled={action.busy} placeholder="None" />
          </div>
          <div className="field">
            <label htmlFor="member-note">Note</label>
            <input id="member-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </>
      )}
      {!editing && <p className="hint">Access level, allowance and a note can be set once they're added. Their phone number is verified from Settings.</p>}
      <Notice notice={action.notice} onDismiss={action.clear} />
    </Modal>
  );
}

export function MembersPage({ householdId, users, accounts, transactions, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  usePageAction("Add member", () => setAdding(true));

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

  return (
    <div className="section">
      {users.length > 0 ? (
        <div className="grid-2">
          {users.map((u) => (
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

              {u.note && <span style={{ fontSize: 14, color: "var(--body-text)" }}>{u.note}</span>}

              <button className="secondary" type="button" onClick={() => setEditing(u)} style={{ alignSelf: "flex-start" }}>
                Edit
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No members yet" hint="Everyone in the household shares one ledger. Invite the first person to get started.">
          <button type="button" onClick={() => setAdding(true)}>
            Add member
          </button>
        </EmptyState>
      )}

      {adding && <MemberModal householdId={householdId} onClose={() => setAdding(false)} onSaved={onChanged} />}
      {editing && <MemberModal householdId={householdId} user={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </div>
  );
}
