import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Account, type Category, type RecurringPattern, type SeriesOccurrence, type Tag, type Transaction, type TransactionFlagColor } from "../api";
import { formatCents } from "../format";
import { parseMoney, moneyToInput } from "../money";
import { NEEDS_CATEGORY, VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { MoneyInput } from "./MoneyInput";
import { Notice, useAction } from "./Notice";
import { ConfirmDialog } from "./ConfirmDialog";

const FLAG_COLORS: TransactionFlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

/**
 * The one transaction detail modal, shared by the Transactions page, the
 * Spending Plan and the Bills & Income calendar — a fix to how editing
 * works lands once instead of drifting between copies.
 *
 * Everything it shows saves in a single request (api.updateTransaction),
 * so correcting a payee, an amount, and a category is one write rather
 * than three that can half-fail. Tags and splits are their own writes
 * because they're their own resources, and both are skipped when nothing
 * about them changed.
 *
 * The amount is entered as a magnitude plus a direction (money out or
 * money in) rather than a signed number: every other amount field in the
 * app is a magnitude with a "$" in front, and "-45.23" in a box was the
 * one place a person had to know that expenses are negative.
 *
 * When `occurrence` is set, the transaction is standing in for a
 * projected occurrence of a recurring series, and the series card offers
 * the actions that belong to that relationship.
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
  const [amount, setAmount] = useState(moneyToInput(transaction.amount_cents));
  const [direction, setDirection] = useState<"out" | "in">(transaction.amount_cents > 0 ? "in" : "out");
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

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const action = useAction();
  const saving = action.busy;

  const budgetableCategories = useMemo(() => categories.filter((c) => !c.archived_at && c.kind !== "transfer"), [categories]);
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

  /** The signed amount the form currently describes, or null when the field isn't a number. */
  function signedAmountCents(): number | null {
    const magnitude = parseMoney(amount);
    if (magnitude === null) return null;
    return direction === "in" ? magnitude : -magnitude;
  }

  function startSplitting() {
    // Seeded with two halves of the current amount, which is the shape of
    // essentially every split — one line to keep, one to move.
    const cents = Math.abs(signedAmountCents() ?? transaction.amount_cents);
    const half = Math.trunc(cents / 2);
    setSplits([
      { amount: moneyToInput(half), categoryId: categoryId || budgetableCategories[0]?.id || "" },
      { amount: moneyToInput(cents - half), categoryId: budgetableCategories[0]?.id ?? "" },
    ]);
    setSplitting(true);
  }

  const splitSumCents = splits.reduce((sum, s) => sum + (parseMoney(s.amount) ?? 0), 0);
  const targetCents = Math.abs(signedAmountCents() ?? transaction.amount_cents);
  const splitRemainderCents = targetCents - splitSumCents;

  async function save(e: FormEvent) {
    e.preventDefault();
    const amountCents = signedAmountCents();
    if (amountCents === null) return action.showError(VALIDATION.amount);
    if (amountCents === 0) return action.showError("Enter an amount other than zero.");
    if (!payee.trim()) return action.showError("Enter who this was paid to.");
    if (splitting) {
      if (splits.some((s) => parseMoney(s.amount) === null)) return action.showError("Every split line needs an amount.");
      if (splits.some((s) => !s.categoryId)) return action.showError("Give every split line a category.");
      if (splitRemainderCents !== 0) return action.showError(`The splits have to add up to ${formatCents(targetCents)}. ${formatCents(Math.abs(splitRemainderCents))} is ${splitRemainderCents > 0 ? "still unassigned" : "over"}.`);
    }

    const sign = amountCents < 0 ? -1 : 1;
    const ok = await action.run(async () => {
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
          splits.map((s) => ({ amountCents: sign * (parseMoney(s.amount) ?? 0), categoryId: s.categoryId })),
        );
      }
      await onSaved();
    });
    if (ok) onClose();
  }

  const createTagAndApply = async () => {
    const name = newTagName.trim();
    if (!name) return;
    const ok = await action.run(async () => {
      const tag = await api.createTag(householdId, { name });
      setAllTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name))));
      setTagIds((prev) => (prev?.includes(tag.id) ? prev : [...(prev ?? []), tag.id]));
    });
    if (ok) setNewTagName("");
  };

  return (
    <Modal
      title="Transaction"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="danger" disabled={saving} onClick={() => setConfirmingDelete(true)} style={{ marginRight: "auto" }}>
            Delete
          </button>
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="transaction-detail-form" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: 0 }}>
        Appears on your {account?.name ?? "account"} statement as <strong>{transaction.raw_description}</strong>.
      </p>

      <form id="transaction-detail-form" className="section" style={{ gap: 12 }} onSubmit={save}>
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
            <label htmlFor="txn-payee">Payee</label>
            <input id="txn-payee" type="text" data-autofocus="true" value={payee} onChange={(e) => setPayee(e.target.value)} disabled={saving} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-date">Date</label>
            <input id="txn-date" type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} disabled={saving} />
          </div>
        </div>

        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-amount">Amount</label>
            <MoneyInput id="txn-amount" value={amount} onChange={setAmount} disabled={saving} width={140} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label id="txn-direction-label">Direction</label>
            <div className="segmented" role="radiogroup" aria-labelledby="txn-direction-label">
              <button type="button" role="radio" aria-checked={direction === "out"} className={`segmented-option ${direction === "out" ? "is-selected" : ""}`} disabled={saving} onClick={() => setDirection("out")}>
                Money out
              </button>
              <button type="button" role="radio" aria-checked={direction === "in"} className={`segmented-option ${direction === "in" ? "is-selected" : ""}`} disabled={saving} onClick={() => setDirection("in")}>
                Money in
              </button>
            </div>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-status">Status</label>
            <select id="txn-status" value={pending ? "pending" : "cleared"} onChange={(e) => setPending(e.target.value === "pending")} disabled={saving}>
              <option value="cleared">Cleared</option>
              <option value="pending">Pending</option>
            </select>
          </div>
        </div>

        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
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
          <div className="field" style={{ margin: 0, flex: "1 1 180px" }}>
            <label htmlFor="txn-category">Category</label>
            <select id="txn-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={saving || splitting}>
              <option value="">{NEEDS_CATEGORY}</option>
              {budgetableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {splitting && <p className="hint" style={{ margin: "-6px 0 0" }}>Split lines carry their own categories.</p>}

        {allTags.length > 0 || tagIds !== null ? (
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="txn-new-tag">Tags</label>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {allTags.map((tag) => {
                const on = tagIds?.includes(tag.id) ?? false;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`badge badge--soft ${on ? "" : "badge--muted"}`}
                    aria-pressed={on}
                    style={{ cursor: "pointer", border: "none" }}
                    disabled={saving}
                    onClick={() => toggleTag(tag.id)}
                  >
                    {tag.name}
                  </button>
                );
              })}
              <input
                id="txn-new-tag"
                type="text"
                placeholder="New tag, then Enter"
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
                style={{ width: 150 }}
              />
            </div>
          </div>
        ) : null}

        {splitting ? (
          <div className="section" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label>Split across categories</label>
              <button type="button" className="secondary" disabled={saving} onClick={() => setSplitting(false)}>
                Don't split
              </button>
            </div>
            {splits.map((split, i) => (
              <div className="row" style={{ gap: 8 }} key={i}>
                <MoneyInput
                  ariaLabel={`Split line ${i + 1} amount`}
                  value={split.amount}
                  disabled={saving}
                  onChange={(value) => setSplits((prev) => prev.map((s, j) => (i === j ? { ...s, amount: value } : s)))}
                  width={130}
                />
                <select
                  aria-label={`Split line ${i + 1} category`}
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
                  <button type="button" className="row-edit-btn" aria-label="Remove this line" title="Remove this line" disabled={saving} onClick={() => setSplits((prev) => prev.filter((_, j) => j !== i))}>
                    ×
                  </button>
                )}
              </div>
            ))}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="secondary" disabled={saving} onClick={() => setSplits((prev) => [...prev, { amount: moneyToInput(Math.max(0, splitRemainderCents)), categoryId: "" }])}>
                Add line
              </button>
              <span className={`money ${splitRemainderCents === 0 ? "positive" : "negative"}`}>
                {splitRemainderCents === 0 ? "Adds up" : splitRemainderCents > 0 ? `${formatCents(splitRemainderCents)} still to assign` : `${formatCents(-splitRemainderCents)} over`}
              </span>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary" style={{ alignSelf: "flex-start" }} disabled={saving} onClick={startSplitting}>
            Split across categories
          </button>
        )}

        {occurrence && pattern && (
          <div className="card card--padded" style={{ gap: 8, display: "flex", flexDirection: "column", marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <span className="row-title">Linked to a series</span>
                <p className="hint" style={{ margin: 0 }}>
                  {pattern.merchant_pattern} · due {occurrence.due_date}
                </p>
              </div>
              <button type="button" className="secondary" disabled={saving} onClick={() => setConfirmingUnlink(true)}>
                Unlink
              </button>
            </div>
          </div>
        )}

        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="txn-note">Note</label>
          <input id="txn-note" type="text" placeholder="Anything worth remembering about this one" value={memo} disabled={saving} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={excluded} disabled={saving} onChange={(e) => setExcluded(e.target.checked)} />
            Leave out of the Spending Plan
          </label>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={reviewed} disabled={saving} onChange={(e) => setReviewed(e.target.checked)} />
            Reviewed
          </label>
          <div className="row" style={{ gap: 4 }} role="group" aria-label="Flag">
            {FLAG_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`flag-dot flag-dot--${color}`}
                aria-label={`Flag ${color}`}
                aria-pressed={flagColor === color}
                title={`Flag ${color}`}
                disabled={saving}
                style={flagColor === color ? { outline: "2px solid var(--ink)", outlineOffset: 2 } : undefined}
                onClick={() => setFlagColor(color)}
              />
            ))}
            <button type="button" className="flag-dot" aria-label="No flag" title="No flag" disabled={saving} onClick={() => setFlagColor(null)} />
          </div>
        </div>

        <Notice notice={action.notice} onDismiss={action.clear} />
      </form>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this transaction?"
          body="It's gone for good, from every page and every total. If it came from your bank, the next sync won't bring it back."
          confirmLabel="Delete"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={async () => {
            await api.deleteTransaction(householdId, transaction.id);
            await onSaved();
            onClose();
          }}
        />
      )}

      {confirmingUnlink && occurrence && (
        <ConfirmDialog
          title="Unlink from the series?"
          body="The calendar goes back to expecting this bill, and the transaction stays where it is as an ordinary charge."
          confirmLabel="Unlink"
          danger={false}
          onCancel={() => setConfirmingUnlink(false)}
          onConfirm={async () => {
            await api.unlinkOccurrence(householdId, occurrence.id);
            await onSaved();
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
