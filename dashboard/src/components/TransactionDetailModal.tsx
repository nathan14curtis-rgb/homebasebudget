import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  type Account,
  type Category,
  type RecurringPattern,
  type SeriesOccurrence,
  type Tag,
  type Transaction,
  type TransactionFlagColor,
} from "../api";
import { formatCents } from "../format";
import { Modal } from "./ScheduleFields";

const FLAG_COLORS: TransactionFlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

/** Dollars ("-45.23") from cents, for the amount input. The sign is part
 * of the value: an expense is negative in this codebase, and hiding that
 * from the field would make a person's correction flip the row's meaning. */
function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function inputToCents(value: string): number | null {
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) ? cents : null;
}

/**
 * The one transaction detail modal, shared by the Transactions page and
 * the Spending Plan (docs/SPENDING_PLAN_EDITING.md phase 4) — a fix to how
 * editing works lands once instead of drifting between two copies.
 *
 * Everything it shows saves in a single request (api.updateTransaction),
 * so correcting a payee, an amount, and a category is one write rather
 * than three that can half-fail. Tags and splits are their own writes
 * because they're their own resources, and both are skipped when nothing
 * about them changed.
 *
 * When `occurrence` is set, the transaction is standing in for a
 * projected occurrence of a recurring series, and the series card offers
 * the actions that belong to that relationship: unlink, skip, override
 * this month's amount.
 */
export function TransactionDetailModal({
  householdId,
  transaction,
  accounts,
  categories,
  currentUserId,
  occurrence,
  pattern,
  onClose,
  onSaved,
}: {
  householdId: string;
  transaction: Transaction;
  accounts: Account[];
  categories: Category[];
  currentUserId: string | null;
  occurrence?: SeriesOccurrence;
  pattern?: RecurringPattern;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [payee, setPayee] = useState(transaction.normalized_merchant ?? transaction.raw_description);
  const [postedAt, setPostedAt] = useState(transaction.posted_at);
  const [amount, setAmount] = useState(centsToInput(transaction.amount_cents));
  const [accountId, setAccountId] = useState(transaction.account_id);
  const [categoryId, setCategoryId] = useState(transaction.category_id ?? "");
  const [memo, setMemo] = useState(transaction.memo ?? "");
  const [pending, setPending] = useState(Boolean(transaction.pending));
  const [excluded, setExcluded] = useState(Boolean(transaction.excluded_from_budget));
  const [flagColor, setFlagColor] = useState<TransactionFlagColor | null>(transaction.flag_color);
  const [reviewed, setReviewed] = useState(transaction.verify_state === "me");

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[] | null>(null); // null until loaded, so a save can tell "untouched" from "cleared"
  const [newTagName, setNewTagName] = useState("");

  const [splitting, setSplitting] = useState(false);
  const [splits, setSplits] = useState<Array<{ amount: string; categoryId: string }>>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const budgetableCategories = useMemo(
    () => categories.filter((c) => !c.archived_at && c.kind !== "transfer"),
    [categories],
  );
  const account = accounts.find((a) => a.id === accountId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tags = await api.listTags(householdId);
        if (cancelled) return;
        setAllTags(tags);
      } catch {
        // A deployment without migration 0010 has no tag table; the rest
        // of the modal still works, so tags just stay empty rather than
        // taking the whole dialog down.
        if (!cancelled) setAllTags([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  // The transaction's own tags, loaded separately so the picker can tell
  // "not loaded yet" from "deliberately none".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const byTransaction = await api.listTagsByTransaction(householdId);
        if (cancelled) return;
        setTagIds((byTransaction[transaction.id] ?? []).map((t) => t.id));
      } catch {
        if (!cancelled) setTagIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId, transaction.id]);

  function toggleTag(tagId: string) {
    setTagIds((prev) => (prev === null ? [tagId] : prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  }

  function startSplitting() {
    // Seeded with two halves of the current amount, which is the shape of
    // essentially every split — one line to keep, one to move.
    const cents = inputToCents(amount) ?? transaction.amount_cents;
    const half = Math.trunc(cents / 2);
    setSplits([
      { amount: centsToInput(half), categoryId: categoryId || budgetableCategories[0]?.id || "" },
      { amount: centsToInput(cents - half), categoryId: budgetableCategories[0]?.id ?? "" },
    ]);
    setSplitting(true);
  }

  const splitSumCents = splits.reduce((sum, s) => sum + (inputToCents(s.amount) ?? 0), 0);
  const targetCents = inputToCents(amount) ?? transaction.amount_cents;
  const splitRemainderCents = targetCents - splitSumCents;

  async function save(e: FormEvent) {
    e.preventDefault();
    const amountCents = inputToCents(amount);
    if (amountCents === null || amountCents === 0) {
      setError("Enter a non-zero amount");
      return;
    }
    if (!payee.trim()) {
      setError("Enter a payee");
      return;
    }
    if (splitting) {
      if (splits.some((s) => !s.categoryId)) {
        setError("Give every split line a category");
        return;
      }
      if (splitRemainderCents !== 0) {
        setError(`Splits must add up to ${formatCents(targetCents)} — ${formatCents(splitRemainderCents)} unaccounted for`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      await api.updateTransaction(householdId, transaction.id, {
        payee: payee.trim(),
        postedAt,
        amountCents,
        accountId,
        categoryId: categoryId || undefined,
        memo: memo.trim() || null,
        pending,
        excluded,
        flagColor,
        // Saving is an explicit human confirmation of the row, which is
        // what "reviewed" means — unchecking it has to un-verify
        // separately, since the write itself can only ever verify.
        editedByUserId: reviewed ? (currentUserId ?? undefined) : undefined,
      });
      if (!reviewed && transaction.verify_state === "me") {
        await api.unverifyTransaction(householdId, transaction.id);
      }
      if (tagIds !== null) {
        await api.setTransactionTags(householdId, transaction.id, { tagIds });
      }
      if (splitting) {
        await api.splitTransaction(
          householdId,
          transaction.id,
          splits.map((s) => ({ amountCents: inputToCents(s.amount)!, categoryId: s.categoryId })),
        );
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await api.deleteTransaction(householdId, transaction.id);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setSaving(false);
    }
  }

  async function unlinkFromSeries() {
    if (!occurrence) return;
    setSaving(true);
    setError(null);
    try {
      await api.unlinkOccurrence(householdId, occurrence.id);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink");
      setSaving(false);
    }
  }

  const createTagAndApply = async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      const tag = await api.createTag(householdId, { name });
      setAllTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name))));
      setTagIds((prev) => (prev?.includes(tag.id) ? prev : [...(prev ?? []), tag.id]));
      setNewTagName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tag");
    }
  };

  return (
    <Modal title="Transaction detail" onClose={onClose} width={560}>
        <p className="hint" style={{ margin: 0 }}>
          Appears on your {account?.name ?? "account"} statement as <strong>{transaction.raw_description}</strong>.
        </p>

        <form className="section" style={{ gap: 12 }} onSubmit={save}>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
              <label htmlFor="txn-payee">Payee</label>
              <input id="txn-payee" type="text" value={payee} onChange={(e) => setPayee(e.target.value)} disabled={saving} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="txn-date">Date</label>
              <input id="txn-date" type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} disabled={saving} />
            </div>
          </div>

          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="txn-amount">Amount</label>
              <input
                id="txn-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={saving}
                style={{ width: 140 }}
              />
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 180px" }}>
              <label htmlFor="txn-account">Account</label>
              <select id="txn-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={saving}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="txn-status">Status</label>
              <select id="txn-status" value={pending ? "pending" : "cleared"} onChange={(e) => setPending(e.target.value === "pending")} disabled={saving}>
                <option value="cleared">Cleared</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-category">Category</label>
            <select id="txn-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={saving || splitting}>
              <option value="">Needs review</option>
              {budgetableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {splitting && <p className="hint" style={{ margin: "4px 0 0" }}>Split lines carry their own categories.</p>}
          </div>

          {allTags.length > 0 || tagIds !== null ? (
            <div className="field" style={{ margin: 0 }}>
              <label>Tags</label>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {allTags.map((tag) => {
                  const on = tagIds?.includes(tag.id) ?? false;
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`badge ${on ? "" : "badge--muted"}`}
                      style={{ cursor: "pointer", border: "none" }}
                      disabled={saving}
                      onClick={() => toggleTag(tag.id)}
                    >
                      {tag.name}
                    </button>
                  );
                })}
                <input
                  type="text"
                  placeholder="New tag"
                  value={newTagName}
                  disabled={saving}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter inside a form would submit the whole modal.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createTagAndApply();
                    }
                  }}
                  style={{ width: 120 }}
                />
              </div>
            </div>
          ) : null}

          {splitting ? (
            <div className="section" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label>Split</label>
                <button type="button" className="secondary" disabled={saving} onClick={() => setSplitting(false)}>
                  Cancel split
                </button>
              </div>
              {splits.map((split, i) => (
                <div className="row" style={{ gap: 8 }} key={i}>
                  <input
                    type="number"
                    step="0.01"
                    value={split.amount}
                    disabled={saving}
                    onChange={(e) => setSplits((prev) => prev.map((s, j) => (i === j ? { ...s, amount: e.target.value } : s)))}
                    style={{ width: 120 }}
                  />
                  <select
                    value={split.categoryId}
                    disabled={saving}
                    onChange={(e) => setSplits((prev) => prev.map((s, j) => (i === j ? { ...s, categoryId: e.target.value } : s)))}
                    style={{ flex: 1 }}
                  >
                    <option value="">Pick a category</option>
                    {budgetableCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {splits.length > 2 && (
                    <button type="button" className="row-edit-btn" title="Remove line" disabled={saving} onClick={() => setSplits((prev) => prev.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={() => setSplits((prev) => [...prev, { amount: centsToInput(splitRemainderCents), categoryId: "" }])}
                >
                  Add line
                </button>
                <span className={`money ${splitRemainderCents === 0 ? "positive" : "negative"}`}>
                  {splitRemainderCents === 0 ? "Balanced" : `${formatCents(splitRemainderCents)} left`}
                </span>
              </div>
            </div>
          ) : (
            <button type="button" className="secondary" style={{ alignSelf: "flex-start" }} disabled={saving} onClick={startSplitting}>
              Split this transaction
            </button>
          )}

          {occurrence && pattern && (
            <div className="card card--padded" style={{ gap: 8, display: "flex", flexDirection: "column" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <span className="row-title">Linked to series</span>
                  <p className="hint" style={{ margin: 0 }}>
                    {pattern.merchant_pattern} · due {occurrence.due_date}
                  </p>
                </div>
                <button type="button" className="secondary" disabled={saving} onClick={unlinkFromSeries}>
                  Unlink
                </button>
              </div>
            </div>
          )}

          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-note">Note</label>
            <input id="txn-note" type="text" placeholder="Add your note here" value={memo} disabled={saving} onChange={(e) => setMemo(e.target.value)} />
          </div>

          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={excluded} disabled={saving} onChange={(e) => setExcluded(e.target.checked)} />
              Exclude from Spending Plan
            </label>
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={reviewed} disabled={saving} onChange={(e) => setReviewed(e.target.checked)} />
              Reviewed
            </label>
            <div className="row" style={{ gap: 4 }}>
              {FLAG_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`flag-dot flag-dot--${color}`}
                  title={`Flag ${color}`}
                  disabled={saving}
                  style={flagColor === color ? { outline: "2px solid var(--ink)", outlineOffset: 2 } : undefined}
                  onClick={() => setFlagColor(color)}
                />
              ))}
              <button type="button" className="flag-dot" title="Clear flag" disabled={saving} onClick={() => setFlagColor(null)} />
            </div>
          </div>

          {error && <p className="error" style={{ margin: 0 }}>{error}</p>}

          <div className="row" style={{ justifyContent: "space-between" }}>
            {confirmingDelete ? (
              <div className="row" style={{ gap: 8 }}>
                <span className="hint">Delete for good?</span>
                <button type="button" className="danger" disabled={saving} onClick={remove}>
                  Delete
                </button>
                <button type="button" className="secondary" disabled={saving} onClick={() => setConfirmingDelete(false)}>
                  Keep
                </button>
              </div>
            ) : (
              <button type="button" className="danger" disabled={saving} onClick={() => setConfirmingDelete(true)}>
                Delete transaction
              </button>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="secondary" disabled={saving} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Update"}
              </button>
            </div>
          </div>
        </form>
    </Modal>
  );
}
