import { useEffect, useState, type FormEvent } from "react";
import { api, type Account, type User } from "../api";
import { VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { Notice, useAction } from "./Notice";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyRow } from "./EmptyState";

declare global {
  interface Window {
    Plaid?: {
      create: (config: PlaidLinkConfig) => { open: () => void };
    };
  }
}

interface PlaidLinkConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
  onExit?: (error: unknown) => void;
}

const PLAID_LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Couldn't load the bank-linking window. Check your connection and try again.")));
      return;
    }
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't load the bank-linking window. Check your connection and try again."));
    document.head.appendChild(script);
  });
}

function statusLabel(account: Account): { text: string; className: string } {
  const { status } = account;
  const isLinked = Boolean(account.plaid_item_id);
  // "connected" is a claim about a bank link, so it is only made about an
  // account that has one — a hand-added, CSV-only account is active too,
  // and calling it connected was the kind of small lie that makes people
  // stop trusting the rest of the page.
  if (status === "active") return isLinked ? { text: "Connected", className: "badge badge--soft badge--positive" } : { text: "Manual", className: "badge badge--soft badge--muted" };
  if (status === "login_required") return { text: "Needs re-link", className: "badge badge--soft badge--warn" };
  return { text: status, className: "badge badge--soft badge--muted" };
}

const ACCOUNT_TYPE_LABELS: Record<Account["type"], string> = {
  depository_checking: "Checking",
  depository_savings: "Savings",
  credit_card: "Credit card",
  other: "Other",
};

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
}

/**
 * Plaid Link (PLAN.md §4.1) needs a real browser — this is why account
 * linking lives in the dashboard rather than something scriptable via
 * curl. After a successful link, the linked account rows don't exist yet
 * (they're created by the async plaid_sync queue job, see
 * src/plaid/sync.ts), so this briefly polls for them to appear.
 */
export function AccountsSection({ householdId, users, accounts, onChanged, onTransactionsChanged }: Props) {
  const [linkingAsUserId, setLinkingAsUserId] = useState("");
  const [linking, setLinking] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualType, setManualType] = useState<Account["type"]>("depository_checking");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [confirmingUnlink, setConfirmingUnlink] = useState<Account | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<Account | null>(null);
  const [alsoDeleteTransactions, setAlsoDeleteTransactions] = useState(false);
  const action = useAction();

  function startEdit(a: Account) {
    setEditingId(a.id);
    setEditName(a.name);
    setEditOwnerId(a.owner_user_id ?? "");
  }

  async function saveEdit(accountId: string) {
    const trimmed = editName.trim();
    if (!trimmed) return action.showError(VALIDATION.name);
    const ok = await action.run(
      async () => {
        await api.updateAccount(householdId, accountId, { name: trimmed, ownerUserId: editOwnerId || null });
        await onChanged();
      },
      { key: accountId },
    );
    if (ok) setEditingId(null);
  }

  /** Unlinking used to be two chained window.confirm()s, the second of
   * which asked a destructive question ("delete every transaction?") whose
   * answer was OK-or-Cancel — the same two buttons that had just meant
   * yes-or-abort. One dialog, with the destructive part as an explicit
   * opt-in checkbox, is both clearer and harder to do by accident. */
  async function unlink(a: Account, deleteTransactions: boolean) {
    setConfirmingUnlink(null);
    await action.run(
      async () => {
        const result = await api.unlinkAccount(householdId, a.id, deleteTransactions);
        await onChanged();
        if (result.transactionsDeleted > 0) await onTransactionsChanged();
      },
      { key: a.id, success: deleteTransactions ? `${a.name} unlinked and its history deleted.` : `${a.name} unlinked. Its history is kept.` },
    );
  }

  useEffect(() => {
    setLinkingAsUserId((prev) => (prev && users.some((u) => u.id === prev) ? prev : users[0]?.id ?? ""));
  }, [users]);

  async function link() {
    if (!linkingAsUserId) return;
    action.clear();
    setLinking(true);
    try {
      await loadPlaidScript();
      const { link_token } = await api.createLinkToken(householdId, linkingAsUserId);
      window
        .Plaid!.create({
          token: link_token,
          onSuccess: (publicToken, metadata) => {
            void (async () => {
              const bank = metadata.institution?.name;
              await action.run(
                async () => {
                  await api.exchangePlaidToken(householdId, publicToken, bank ?? undefined);
                  for (let i = 0; i < 6; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    await onChanged();
                  }
                },
                { key: "link", success: `${bank ?? "Your bank"} is linked. Transactions will start syncing within the hour.` },
              );
              setLinking(false);
            })();
          },
          onExit: () => setLinking(false),
        })
        .open();
    } catch (err) {
      setLinking(false);
      action.showError(err instanceof Error ? err.message : "Couldn't start linking a bank.");
    }
  }

  async function addManualAccount(e: FormEvent) {
    e.preventDefault();
    const trimmed = manualName.trim();
    if (!trimmed) return action.showError(VALIDATION.name);
    const ok = await action.run(
      async () => {
        await api.createAccount(householdId, { name: trimmed, type: manualType, ownerUserId: linkingAsUserId || undefined });
        await onChanged();
      },
      { key: "manual", success: `${trimmed} added.` },
    );
    if (ok) setManualName("");
  }

  const visibleAccounts = accounts.filter((a) => a.status !== "removed");

  return (
    <section className="card">
      <h2>Bank accounts</h2>
      <ul className="list">
        {visibleAccounts.map((a) => {
          const status = statusLabel(a);
          const owner = users.find((u) => u.id === a.owner_user_id);
          const busy = action.busyKey === a.id;
          if (editingId === a.id) {
            return (
              <li key={a.id} style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <span className="row" style={{ flex: 1, alignItems: "flex-end" }}>
                  <div className="field-inline">
                    <label htmlFor={`account-name-${a.id}`}>Name</label>
                    <input id={`account-name-${a.id}`} type="text" value={editName} disabled={busy} onChange={(e) => setEditName(e.target.value)} style={{ width: 160 }} />
                  </div>
                  <div className="field-inline">
                    <label htmlFor={`account-owner-${a.id}`}>Whose</label>
                    <select id={`account-owner-${a.id}`} value={editOwnerId} disabled={busy} onChange={(e) => setEditOwnerId(e.target.value)}>
                      <option value="">Joint / no owner</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </span>
                <span className="row">
                  <button type="button" onClick={() => saveEdit(a.id)} disabled={busy}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button className="secondary" type="button" onClick={() => setEditingId(null)} disabled={busy}>
                    Cancel
                  </button>
                </span>
              </li>
            );
          }
          return (
            <li key={a.id}>
              <span>
                {a.name}
                {a.mask ? ` ····${a.mask}` : ""}
                {owner && <span className="hint"> — {owner.name}</span>}
              </span>
              <span className="row">
                <span className={status.className}>{status.text}</span>
                <button className="secondary" type="button" onClick={() => startEdit(a)} disabled={busy}>
                  Edit
                </button>
                {a.plaid_item_id ? (
                  <button
                    className="danger"
                    type="button"
                    onClick={() => {
                      setAlsoDeleteTransactions(false);
                      setConfirmingUnlink(a);
                    }}
                    disabled={busy}
                  >
                    {busy ? "Unlinking…" : "Unlink"}
                  </button>
                ) : (
                  <button className="danger" type="button" onClick={() => setConfirmingRemove(a)} disabled={busy}>
                    {busy ? "Removing…" : "Remove"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {visibleAccounts.length === 0 && (
          <li>
            <EmptyRow text="No accounts yet. Link a bank below, or add one by hand for CSV history." />
          </li>
        )}
      </ul>

      <div className="row" style={{ marginTop: "1rem", alignItems: "flex-end" }}>
        <div className="field-inline">
          <label htmlFor="link-as-user">Link as</label>
          <select id="link-as-user" value={linkingAsUserId} onChange={(e) => setLinkingAsUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={link} disabled={linking || users.length === 0}>
          {linking ? "Linking…" : "Link a bank account"}
        </button>
      </div>
      {users.length === 0 && <p className="hint">Add a person above first.</p>}

      <details style={{ marginTop: "1rem" }}>
        <summary>Or add an account by hand (for CSV-only history)</summary>
        <form className="row" onSubmit={addManualAccount} style={{ alignItems: "flex-end" }}>
          <div className="field-inline">
            <label htmlFor="manual-account-name">Account name</label>
            <input id="manual-account-name" type="text" value={manualName} disabled={action.busy} onChange={(e) => setManualName(e.target.value)} />
          </div>
          <div className="field-inline">
            <label htmlFor="manual-account-type">Type</label>
            <select id="manual-account-type" value={manualType} disabled={action.busy} onChange={(e) => setManualType(e.target.value as Account["type"])}>
              {(Object.keys(ACCOUNT_TYPE_LABELS) as Account["type"][]).map((type) => (
                <option key={type} value={type}>
                  {ACCOUNT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="secondary" disabled={action.busy}>
            {action.busyKey === "manual" ? "Adding…" : "Add account"}
          </button>
        </form>
      </details>

      <Notice notice={action.notice} onDismiss={action.clear} style={{ marginTop: 12 }} />

      {confirmingUnlink && (
        <Modal
          title={`Unlink ${confirmingUnlink.name}${confirmingUnlink.mask ? ` ····${confirmingUnlink.mask}` : ""}?`}
          onClose={() => setConfirmingUnlink(null)}
          width={460}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setConfirmingUnlink(null)}>
                Cancel
              </button>
              <button type="button" className="danger" data-autofocus="true" onClick={() => void unlink(confirmingUnlink, alsoDeleteTransactions)}>
                {alsoDeleteTransactions ? "Unlink and delete history" : "Unlink"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>Syncing stops. Re-connecting it later means going through your bank's login again.</p>
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={alsoDeleteTransactions} onChange={(e) => setAlsoDeleteTransactions(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Also delete every transaction it has ever synced.
              <span className="hint" style={{ display: "block", margin: 0 }}>
                For clearing out test data. Leave it unchecked to keep the history and only stop syncing.
              </span>
            </span>
          </label>
        </Modal>
      )}

      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${confirmingRemove.name}?`}
          body="It leaves this list and the Transactions filters. Transactions already imported for it are kept."
          confirmLabel="Remove"
          onCancel={() => setConfirmingRemove(null)}
          onConfirm={async () => {
            const account = confirmingRemove;
            await api.updateAccount(householdId, account.id, { status: "removed" });
            setConfirmingRemove(null);
            await action.run(onChanged, { success: `${account.name} removed.` });
          }}
        />
      )}
    </section>
  );
}
