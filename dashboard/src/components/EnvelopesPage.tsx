import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  type Account,
  type Category,
  type CategorySuggestion,
  type Envelope,
  type EnvelopeMonthSummary,
  type RecurringPattern,
  type SeriesOccurrence,
  type Transaction,
} from "../api";
import { formatCents, currentMonth } from "../format";
import type { Recurring } from "../useRecurring";
import { usePageAction } from "../pageAction";
import { TransactionDetailModal } from "./TransactionDetailModal";
import { Modal } from "./ScheduleFields";
import { ConfirmDialog } from "./ConfirmDialog";
import { IncludedExcludedList, PlanRow, planItemDate, type PlanItem } from "./PlanRow";

interface Props {
  householdId: string;
  accounts: Account[];
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  currentUserId: string | null;
  recurring: Recurring;
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
  onGoToBillsIncome: () => void;
}

function EnvelopeDrilldown({
  householdId,
  envelope,
  category,
  items,
  renderRow,
  onBalanceAdjusted,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  items: PlanItem[];
  renderRow: (item: PlanItem) => React.ReactNode;
  onBalanceAdjusted: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjusting, setAdjusting] = useState(false);

  async function adjustBalance(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(adjustAmount) * 100);
    if (!Number.isFinite(cents) || cents === 0) {
      setError("Enter an amount to move — a positive number adds, a negative one takes away.");
      return;
    }
    setAdjusting(true);
    setError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, {
        month: currentMonth(),
        amountCents: cents,
        note: adjustNote.trim() || "Manual balance adjustment",
      });
      setAdjustAmount("");
      setAdjustNote("");
      await onBalanceAdjusted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adjust balance");
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="envelope-drilldown">
      <div>
        <h3 className="subhead">{category?.name ?? "Envelope"} — this month</h3>
        <p className="hint" style={{ margin: 0 }}>
          Everyday spending that landed here. Open a row to edit it, or use its ⋮ to leave it out of the plan. Bills filed under this
          category live on the Bills &amp; Income calendar instead.
        </p>
      </div>

      <IncludedExcludedList items={items} emptyLabel="Nothing spent from this envelope yet this month." renderRow={renderRow} />

      <form className="row" onSubmit={adjustBalance}>
        <div className="input-prefix" style={{ width: 200 }}>
          <span aria-hidden>$</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Adjust this envelope's balance by"
            placeholder="Move money, e.g. -25"
            value={adjustAmount}
            onChange={(e) => setAdjustAmount(e.target.value)}
          />
        </div>
        <input
          type="text"
          aria-label="Note for this adjustment"
          placeholder="Note (optional)"
          value={adjustNote}
          onChange={(e) => setAdjustNote(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="submit" disabled={adjusting}>
          {adjusting ? "Applying…" : "Apply"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface EnvelopeMenuAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon: string;
}

/** The row's "⋮" menu — a small click-away dropdown, no library needed for
 * four to five actions. Closes on an outside click via a full-viewport
 * transparent backdrop rather than a blur handler, so a click that lands on
 * another row's menu button still opens that one instead of just closing
 * this one and requiring a second click. */
function EnvelopeMenu({ actions }: { actions: EnvelopeMenuAction[] }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPos(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos]);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (pos) {
      setPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Clamped to the viewport so the menu can't hang off the right edge of
    // a narrow window, where it would be unreachable.
    setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 260, window.innerWidth - 268)) });
  }

  return (
    <div style={{ flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="envelope-menu-button" aria-label="Envelope actions" aria-expanded={pos !== null} onClick={toggle}>
        ⋮
      </button>
      {pos && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setPos(null)} />
          <div className="envelope-menu-dropdown" style={{ top: pos.top, left: pos.left }} role="menu">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className="envelope-menu-item"
                disabled={a.disabled}
                style={a.danger ? { color: "var(--red)" } : undefined}
                onClick={() => {
                  setPos(null);
                  a.onClick();
                }}
              >
                <span aria-hidden style={{ width: 16, textAlign: "center" }}>{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One envelope's full row: transaction count + group tag, a bar showing
 * this month's target alongside any rollover sitting on top of it, the
 * available-to-spend figure, and the "⋮" menu (release rollover, edit the
 * target, hand-adjust the rollover, rename the underlying category, or
 * archive it). */
function EnvelopeRow({
  householdId,
  envelope,
  category,
  summary,
  items,
  renderRow,
  isExpanded,
  onToggleExpand,
  onEdit,
  onChanged,
  onArchive,
  onAdjustRollover,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  summary: EnvelopeMonthSummary | undefined;
  items: PlanItem[];
  renderRow: (item: PlanItem) => React.ReactNode;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onArchive: () => void;
  onAdjustRollover: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);

  const target = envelope.monthly_target_cents;
  const balance = summary?.balanceCents ?? 0;
  const spent = summary?.spentCents ?? 0;
  const rolloverCents = target !== null ? balance - target : 0;
  const over = target !== null && balance < 0;

  const txnCount = items.filter((i) => i.kind === "transaction" && !i.transaction.excluded_from_budget).length;
  const isGoal = category?.kind === "savings";

  async function releaseUnspentFunds() {
    if (rolloverCents <= 0) return;
    setActionError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, {
        month: currentMonth(),
        amountCents: -rolloverCents,
        note: "Released unspent funds",
      });
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to release unspent funds");
    }
  }

  /** Whether this envelope's leftovers survive the turn of the month. The
   * per-month adjustments ("release", "change rollover amount") fix one
   * month; this is the standing answer, and the backend settles it with a
   * correction entry the next time the month is read. */
  async function toggleRolloverMode() {
    const next = envelope.rollover_mode === "reset" ? "carry" : "reset";
    setActionError(null);
    try {
      await api.updateEnvelope(householdId, envelope.id, { rolloverMode: next });
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to change rollover setting");
    }
  }

  const barTotal = Math.max(target ?? 0, balance, 1);
  const targetSegPct = target ? (target / barTotal) * 100 : 0;
  const rolloverSegPct = 100 - targetSegPct;
  const fillPct = target ? Math.max(0, Math.min(100, (balance / target) * 100)) : 0;
  const pctSpent = target ? Math.round((spent / target) * 100) : 0;

  return (
    <div>
      <div
        className="row-item"
        style={{ cursor: "pointer", flexWrap: "wrap", rowGap: 10 }}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onToggleExpand();
          }
        }}
        onClick={(ev) => {
          if ((ev.target as HTMLElement).closest("button, input, select")) return;
          onToggleExpand();
        }}
      >
        <div className="row-figure" style={{ flex: "1 1 220px", minWidth: 180 }}>
          <span className="row-title">
            <span className={`nav-caret ${isExpanded ? "is-open" : ""}`} aria-hidden style={{ marginRight: 6 }}>
              ›
            </span>
            {category?.name ?? "Unknown category"}
          </span>
          <span className="row-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {txnCount} transaction{txnCount === 1 ? "" : "s"} in:
            <span className="badge badge--soft badge--muted">{envelope.group_name}</span>
            <span
              className="badge badge--soft badge--muted"
              title={envelope.rollover_mode === "reset" ? "Starts fresh every month" : "Leftovers roll over month to month"}
            >
              {envelope.rollover_mode === "reset" ? "↺ Resets" : "⟲ Rolls over"}
            </span>
          </span>
        </div>

        <div style={{ flex: "2 1 220px", minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-mono)" }}>
            {isGoal ? (
              <span>
                Saved <strong>{formatCents(balance)}</strong>
              </span>
            ) : (
              <span>
                Spent <strong>{formatCents(spent)}</strong>
              </span>
            )}
            <span style={{ display: "flex", gap: 8 }}>
              {target !== null ? (
                <span>
                  of <strong>{formatCents(target)}</strong>
                </span>
              ) : (
                <span style={{ color: "var(--faint)" }}>no amount planned</span>
              )}
              {!isGoal && rolloverCents > 0 && <span style={{ color: "var(--teal)" }}>+{formatCents(rolloverCents)}</span>}
            </span>
          </div>
          {isGoal && target !== null ? (
            <div className="envelope-bar" role="img" aria-label={`${Math.round((balance / target) * 100)}% of this goal saved`}>
              <div
                className="envelope-bar-rollover"
                style={{ width: `${Math.max(0, Math.min(100, (balance / target) * 100))}%` }}
              />
            </div>
          ) : over ? (
            <div className="envelope-bar" role="img" aria-label={`Over budget by ${formatCents(-balance)}`}>
              <div className="envelope-bar-target-fill over" style={{ width: "100%" }} />
            </div>
          ) : target !== null ? (
            <div className="envelope-bar" role="img" aria-label={`${pctSpent}% of this month's target spent`}>
              <div className="envelope-bar-target" style={{ width: `${targetSegPct}%` }}>
                <div className="envelope-bar-target-fill" style={{ width: `${fillPct}%` }} />
              </div>
              {rolloverSegPct > 0 && <div className="envelope-bar-rollover" style={{ width: `${rolloverSegPct}%` }} />}
            </div>
          ) : (
            // No target, so nothing to fill: an empty track, not a full red
            // bar, which read as "you have blown a budget" for an envelope
            // that never had one.
            <div className="envelope-bar" />
          )}
        </div>

        <div style={{ flex: "0 0 auto", textAlign: "right", minWidth: 130 }}>
          {/* Teal means "you're fine" and red means "you're not". Money
              spent from an envelope with no planned amount is neither — it
              is just what was spent — so it stays plain ink. */}
          <div className={`money ${target === null && !isGoal ? "" : over ? "negative" : "positive"}`} style={{ fontSize: 18, fontWeight: 600 }}>
            {formatCents(isGoal || target !== null ? balance : spent)}
          </div>
          <div className="hint" style={{ margin: 0 }}>
            {isGoal
              ? "Saved so far"
              : target === null
                ? "Spent this month"
                : over
                  ? "Over budget"
                  : rolloverCents > 0
                    ? "Available with rollover"
                    : "Available to spend"}
          </div>
        </div>

        <EnvelopeMenu
          actions={[
            { label: "Edit amount", icon: "✎", onClick: onEdit },
            { label: "Release unspent funds", icon: "↩", disabled: rolloverCents <= 0, onClick: releaseUnspentFunds },
            { label: "Change rollover amount", icon: "⇄", onClick: onAdjustRollover },
            {
              label: envelope.rollover_mode === "reset" ? "Roll leftovers over each month" : "Start fresh each month",
              icon: "⟲",
              onClick: toggleRolloverMode,
            },
            { label: "Archive", icon: "🗄", danger: true, onClick: onArchive },
          ]}
        />
      </div>
      {actionError && (
        <div className="row-item">
          <p className="error" style={{ margin: 0 }}>{actionError}</p>
        </div>
      )}
      {isExpanded && (
        <EnvelopeDrilldown
          householdId={householdId}
          envelope={envelope}
          category={category}
          items={items}
          renderRow={renderRow}
          onBalanceAdjusted={onChanged}
        />
      )}
    </div>
  );
}

/**
 * The envelope "Edit" action's dialog: what this envelope gets each month,
 * which group it sits in, and — for a savings envelope — the date it is
 * saving toward. A bill's amount is not edited here any more; a bill is a
 * series on the Bills & Income calendar, and that is where its amount
 * lives, so there is one answer to "how much is the electric bill" rather
 * than two that can disagree.
 */
function EditEnvelopeModal({
  householdId,
  envelope,
  category,
  onClose,
  onSaved,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [amount, setAmount] = useState(envelope.monthly_target_cents !== null ? (envelope.monthly_target_cents / 100).toFixed(2) : "");
  const [groupName, setGroupName] = useState(envelope.group_name);
  const [targetDate, setTargetDate] = useState(envelope.target_date ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGoal = category?.kind === "savings";

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give this envelope a name");
      return;
    }
    if (amount.trim() && !Number.isFinite(Number(amount))) {
      setError("Enter a valid amount, or clear it to leave this envelope untargeted");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateEnvelope(householdId, envelope.id, {
        groupName: groupName.trim() || "Uncategorized",
        monthlyTargetCents: amount.trim() ? Math.round(Number(amount) * 100) : null,
        targetDate: isGoal ? targetDate || null : envelope.target_date,
      });
      if (category && trimmedName !== category.name) {
        await api.renameCategory(householdId, category.id, trimmedName);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={category?.name ?? "Edit envelope"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" type="text" data-autofocus="true" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="edit-amount">{isGoal ? "Total needed" : "Amount each month"}</label>
        <div className="input-prefix">
          <span aria-hidden>$</span>
          <input
            id="edit-amount"
            type="text"
            inputMode="decimal"
            placeholder="No target set"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <p className="hint">
          {isGoal
            ? "What this goal needs in total. The plan works out this month's share from the date below."
            : "Leave blank to track spending here without planning an amount for it."}
        </p>
      </div>

      <div className="field">
        <label htmlFor="edit-group">Group</label>
        <input
          id="edit-group"
          type="text"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="e.g. Everyday"
        />
        <p className="hint">Envelopes with the same group name are listed together.</p>
      </div>

      {isGoal && (
        <div className="field">
          <label htmlFor="edit-goal-date">Goal date</label>
          <input id="edit-goal-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/** "New envelope" — a category and its envelope in one step, which is what
 * the API already does in a single request. */
function NewEnvelopeModal({
  householdId,
  onClose,
  onSaved,
}: {
  householdId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "savings">("expense");
  const [amount, setAmount] = useState("");
  const [groupName, setGroupName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Give this envelope a name");
    const cents = amount.trim() ? Math.round(Number(amount) * 100) : undefined;
    if (cents !== undefined && !Number.isFinite(cents)) return setError("Enter a valid amount");
    setSaving(true);
    setError(null);
    try {
      await api.createCategory(householdId, {
        name: name.trim(),
        kind,
        groupName: groupName.trim() || undefined,
        monthlyTargetCents: cents,
        targetDate: kind === "savings" && targetDate ? targetDate : undefined,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the envelope");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="New envelope"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Creating…" : "Create envelope"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="new-env-name">Name</label>
        <input
          id="new-env-name"
          type="text"
          data-autofocus="true"
          placeholder="e.g. Groceries"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label id="new-env-kind-label">Kind</label>
        <div className="segmented" role="radiogroup" aria-labelledby="new-env-kind-label">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "expense"}
            className={`segmented-option ${kind === "expense" ? "is-selected" : ""}`}
            onClick={() => setKind("expense")}
          >
            Spending
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "savings"}
            className={`segmented-option ${kind === "savings" ? "is-selected" : ""}`}
            onClick={() => setKind("savings")}
          >
            Saving toward something
          </button>
        </div>
        <p className="hint">A savings envelope shows up on the Goals page with a date to hit.</p>
      </div>

      <div className="field">
        <label htmlFor="new-env-amount">{kind === "savings" ? "Total needed" : "Amount each month"}</label>
        <div className="input-prefix">
          <span aria-hidden>$</span>
          <input
            id="new-env-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>

      {kind === "savings" && (
        <div className="field">
          <label htmlFor="new-env-date">Goal date</label>
          <input id="new-env-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </div>
      )}

      <div className="field">
        <label htmlFor="new-env-group">Group (optional)</label>
        <input id="new-env-group" type="text" placeholder="e.g. Everyday" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
      </div>

      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/** Hand-move money in or out of an envelope for this month — a real dialog
 * rather than window.prompt(), which can't be styled, can't explain
 * itself, and is blocked outright by some browsers. */
function RolloverModal({
  householdId,
  envelope,
  category,
  currentRolloverCents,
  onClose,
  onSaved,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  currentRolloverCents: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [amount, setAmount] = useState((Math.max(0, currentRolloverCents) / 100).toFixed(2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const desired = Math.round(Number(amount) * 100);
    if (!Number.isFinite(desired)) return setError("Enter a valid amount");
    const delta = desired - Math.max(0, currentRolloverCents);
    if (delta === 0) return onClose();
    setSaving(true);
    setError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, { month: currentMonth(), amountCents: delta, note: "Change rollover amount" });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the rollover");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`${category?.name ?? "Envelope"} rollover`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Set rollover"}
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: 0 }}>
        Money sitting in this envelope beyond this month's target. Right now it holds {formatCents(Math.max(0, currentRolloverCents))}.
      </p>
      <div className="field">
        <label htmlFor="rollover-amount">Rollover</label>
        <div className="input-prefix">
          <span aria-hidden>$</span>
          <input
            id="rollover-amount"
            type="text"
            inputMode="decimal"
            data-autofocus="true"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/**
 * Weave posted transactions into ordered plan rows.
 *
 * The Spending Plan is now everyday, non-recurring spending only — a bill
 * and its projection belong to the Bills & Income calendar — so a
 * transaction that a recurring series already accounts for is filtered out
 * before it gets here, and nothing projected is woven in at all.
 */
function buildPlanItems(transactions: Transaction[]): PlanItem[] {
  return transactions
    .map((transaction): PlanItem => ({ kind: "transaction", id: transaction.id, transaction }))
    .sort((a, b) => planItemDate(b).localeCompare(planItemDate(a)));
}

export function EnvelopesPage({
  householdId,
  accounts,
  categories,
  envelopes,
  envelopeSummaries,
  transactions,
  currentUserId,
  recurring,
  onChanged,
  onTransactionsChanged,
  onGoToBillsIncome,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editingEnvelope, setEditingEnvelope] = useState<Envelope | null>(null);
  const [adjustingRollover, setAdjustingRollover] = useState<{ envelope: Envelope; rolloverCents: number } | null>(null);
  const [creatingEnvelope, setCreatingEnvelope] = useState(false);
  const [archiving, setArchiving] = useState<{ categoryId: string; name: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<Record<number, boolean>>({});
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const month = currentMonth();

  usePageAction("New envelope", () => setCreatingEnvelope(true));

  // The plan reads recurring data not to show it, but to know what to leave
  // out: a charge a series already accounts for is on the Bills & Income
  // calendar, and counting it here as well would double it. A deployment
  // without migrations 0006/0010 has no recurring tables at all, in which
  // case these are empty and nothing is filtered — the plan shows more
  // than it should rather than less, which is the right way round.
  const { patterns } = recurring;
  const occurrences = useMemo(() => recurring.occurrencesByMonth[month] ?? [], [recurring.occurrencesByMonth, month]);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  /** Transaction ids a recurring series has already claimed this month. */
  const recurringTransactionIds = useMemo(
    () => new Set(occurrences.map((o) => o.matched_transaction_id).filter((id): id is string => Boolean(id))),
    [occurrences],
  );
  /** Categories that exist to hold a recurring series. Their everyday
   * spending, if any, still shows under Unplanned — but they don't get an
   * envelope card here, because the calendar is where they are managed. */
  const recurringCategoryIds = useMemo(
    () => new Set(patterns.filter((p) => p.status === "confirmed" && p.category_id).map((p) => p.category_id!)),
    [patterns],
  );

  /** Every non-recurring transaction posted this month. */
  const nonRecurringTransactions = useMemo(
    () =>
      transactions.filter(
        (t) => !t.is_transfer && t.posted_at.startsWith(month) && !recurringTransactionIds.has(t.id) && categoryById.get(t.category_id ?? "")?.kind !== "income",
      ),
    [transactions, month, recurringTransactionIds, categoryById],
  );

  // Bills live on the calendar, so their envelopes are not cards here. What
  // is left splits by whether an amount has been planned for it.
  const planEnvelopes = useMemo(
    () => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() !== "bills" && !recurringCategoryIds.has(e.category_id)),
    [envelopes, recurringCategoryIds],
  );
  const plannedEnvelopes = useMemo(() => planEnvelopes.filter((e) => e.monthly_target_cents !== null), [planEnvelopes]);
  const untargetedEnvelopes = useMemo(() => planEnvelopes.filter((e) => e.monthly_target_cents === null), [planEnvelopes]);

  const allocatedForSpendCents = useMemo(
    () => plannedEnvelopes.filter((e) => categoryById.get(e.category_id)?.kind === "expense").reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0),
    [plannedEnvelopes, categoryById],
  );
  // Not the goal's total target (monthly_target_cents on a savings
  // envelope is the finish line, not a monthly figure) but what putting
  // money in *this month* actually takes to still land on the goal date:
  // the shortfall spread evenly across the months remaining.
  const allocatedForGoalsCents = useMemo(
    () =>
      plannedEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings")
        .reduce((sum, e) => {
          const target = e.monthly_target_cents ?? 0;
          if (!e.target_date) return sum + target;
          const have = envelopeSummaries[e.id]?.balanceCents ?? 0;
          const monthsRemaining = Math.max(1, Math.round((Date.parse(e.target_date) - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)));
          return sum + Math.max(0, Math.round((target - have) / monthsRemaining));
        }, 0),
    [plannedEnvelopes, categoryById, envelopeSummaries],
  );

  const patternById = useMemo(() => new Map(patterns.map((p) => [p.id, p])), [patterns]);

  // What the Bills & Income calendar says is coming in and going out this
  // month. Shown here only as the frame around "what's left to allocate" —
  // the calendar itself is where any of it is changed.
  const { incomeCents, billsCents } = useMemo(() => {
    let income = 0;
    let bills = 0;
    for (const occurrence of occurrences) {
      if (occurrence.status === "skipped") continue;
      const pattern = patternById.get(occurrence.pattern_id);
      const magnitude = Math.abs(occurrence.amount_override_cents ?? occurrence.amount_cents ?? pattern?.expected_amount_cents ?? 0);
      if (pattern?.kind === "income") income += magnitude;
      else bills += magnitude;
    }
    // Income that arrived without a series behind it still counts — a
    // one-off reimbursement is money to allocate like any other.
    for (const t of transactions) {
      if (t.is_transfer || t.excluded_from_budget || !t.posted_at.startsWith(month)) continue;
      if (categoryById.get(t.category_id ?? "")?.kind !== "income") continue;
      if (recurringTransactionIds.has(t.id)) continue;
      income += Math.abs(t.amount_cents);
    }
    return { incomeCents: income, billsCents: bills };
  }, [occurrences, patternById, transactions, month, categoryById, recurringTransactionIds]);

  const allocatedCents = allocatedForSpendCents + allocatedForGoalsCents;
  const unallocatedCents = incomeCents - billsCents - allocatedCents;

  const untargetedCategoryIds = useMemo(() => new Set(untargetedEnvelopes.map((e) => e.category_id)), [untargetedEnvelopes]);
  /** Everything that landed somewhere with no planned amount — including a
   * charge in a bill's category that the series didn't claim. */
  const unplannedItems = useMemo(
    () =>
      buildPlanItems(
        nonRecurringTransactions.filter((t) => !t.category_id || untargetedCategoryIds.has(t.category_id) || recurringCategoryIds.has(t.category_id)),
      ),
    [nonRecurringTransactions, untargetedCategoryIds, recurringCategoryIds],
  );
  const unplannedSpendCents = useMemo(
    () => unplannedItems.filter((i) => i.kind === "transaction" && !i.transaction.excluded_from_budget).reduce((sum, i) => sum + (i.kind === "transaction" ? Math.min(0, i.transaction.amount_cents) : 0), 0),
    [unplannedItems],
  );

  const plannedSpentCents = useMemo(
    () => plannedEnvelopes.reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [plannedEnvelopes, envelopeSummaries],
  );

  // A household starts with a few dozen seeded categories and will only
  // ever use some of them. Listing every one of them at $0.00 buried the
  // handful that actually have spending in them, so an untargeted envelope
  // earns a row by having activity this month; the rest are a count behind
  // a disclosure, still one click from being given an amount.
  const [showQuietEnvelopes, setShowQuietEnvelopes] = useState(false);
  const { activeUntargeted, quietUntargeted } = useMemo(() => {
    const active: Envelope[] = [];
    const quiet: Envelope[] = [];
    for (const e of untargetedEnvelopes) {
      const summary = envelopeSummaries[e.id];
      (summary && (summary.spentCents !== 0 || summary.balanceCents !== 0) ? active : quiet).push(e);
    }
    return { activeUntargeted: active, quietUntargeted: quiet };
  }, [untargetedEnvelopes, envelopeSummaries]);

  const groupedPlanned = useMemo(() => {
    const byGroup = new Map<string, Envelope[]>();
    for (const e of plannedEnvelopes) {
      const g = byGroup.get(e.group_name) ?? [];
      g.push(e);
      byGroup.set(e.group_name, g);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [plannedEnvelopes]);

  async function refreshAfterRowAction() {
    await Promise.all([onChanged(), onTransactionsChanged()]);
  }

  async function toggleExcluded(transaction: Transaction) {
    setRowError(null);
    try {
      await api.setTransactionExcluded(householdId, transaction.id, !transaction.excluded_from_budget);
      await refreshAfterRowAction();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to update the row");
    }
  }

  function renderPlanRow(item: PlanItem) {
    if (item.kind !== "transaction") return null;
    const transaction = item.transaction;
    const excluded = Boolean(transaction.excluded_from_budget);
    return (
      <PlanRow
        key={item.id}
        item={item}
        category={transaction.category_id ? categoryById.get(transaction.category_id) : undefined}
        onOpen={() => setEditingTransaction(transaction)}
        actions={[
          { label: "Edit transaction", icon: "✎", onClick: () => setEditingTransaction(transaction) },
          {
            label: excluded ? "Include in Spending Plan" : "Exclude from Spending Plan",
            icon: excluded ? "＋" : "⊘",
            onClick: () => void toggleExcluded(transaction),
          },
        ]}
      />
    );
  }

  /** One envelope's everyday spending this month. */
  function itemsForEnvelope(envelope: Envelope): PlanItem[] {
    return buildPlanItems(nonRecurringTransactions.filter((t) => t.category_id === envelope.category_id));
  }

  async function archive(categoryId: string) {
    setError(null);
    try {
      await api.archiveCategory(householdId, categoryId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive");
    }
  }

  async function loadSuggestions() {
    setSuggestError(null);
    setLoadingSuggestions(true);
    try {
      const results = await api.suggestCategories(householdId);
      setSuggestions(results);
      setSuggestChecked(Object.fromEntries(results.map((_, i) => [i, true])));
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : "Failed to get suggestions");
    } finally {
      setLoadingSuggestions(false);
    }
  }

  const rebuildArchiveTargets = useMemo(() => {
    const visibleCategoryIds = new Set(planEnvelopes.map((e) => e.category_id));
    return categories.filter((c) => visibleCategoryIds.has(c.id));
  }, [planEnvelopes, categories]);

  // A full rebuild, not "add whatever's new" — archives every envelope on
  // this page before creating the checked suggestions, so the spending
  // plan actually matches what was reviewed instead of accumulating both
  // old and new. Bills are untouched: they're the calendar's.
  async function rebuildFromSuggestions() {
    if (!suggestions) return;
    setConfirmingRebuild(false);
    setSuggestError(null);
    setRebuilding(true);
    try {
      for (const c of rebuildArchiveTargets) {
        await api.archiveCategory(householdId, c.id);
      }
      for (const s of suggestions.filter((_, i) => suggestChecked[i])) {
        await api.createCategory(householdId, {
          name: s.name,
          kind: s.kind,
          groupName: s.groupName || undefined,
          monthlyTargetCents: s.monthlyTargetCents ?? undefined,
        });
      }
      setSuggestions(null);
      await onChanged();
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : "Failed to rebuild the spending plan");
    } finally {
      setRebuilding(false);
    }
  }

  function renderEnvelope(envelope: Envelope) {
    const summary = envelopeSummaries[envelope.id];
    const target = envelope.monthly_target_cents;
    const rolloverCents = target !== null ? (summary?.balanceCents ?? 0) - target : 0;
    return (
      <EnvelopeRow
        key={envelope.id}
        householdId={householdId}
        envelope={envelope}
        category={categoryById.get(envelope.category_id)}
        summary={summary}
        items={itemsForEnvelope(envelope)}
        renderRow={renderPlanRow}
        isExpanded={expandedId === envelope.id}
        onToggleExpand={() => setExpandedId(expandedId === envelope.id ? null : envelope.id)}
        onEdit={() => setEditingEnvelope(envelope)}
        onChanged={onChanged}
        onArchive={() => setArchiving({ categoryId: envelope.category_id, name: categoryById.get(envelope.category_id)?.name ?? "this envelope" })}
        onAdjustRollover={() => setAdjustingRollover({ envelope, rolloverCents })}
      />
    );
  }

  return (
    <div className="section">
      <div className="grid-3">
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Planned for spending</span>
          <span className="figure money">{formatCents(allocatedForSpendCents)}</span>
          <span className="detail">
            {formatCents(plannedSpentCents)} of it spent so far this month.
          </span>
        </div>
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Planned for goals</span>
          <span className="figure money">{formatCents(allocatedForGoalsCents)}</span>
          <span className="detail">What this month needs to put aside to stay on track for each goal's date.</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Left to allocate</span>
          <span className={`figure money ${unallocatedCents < 0 ? "negative" : ""}`}>{formatCents(unallocatedCents)}</span>
          <span className="detail">
            {formatCents(incomeCents)} coming in, less {formatCents(billsCents)} of bills, less everything planned above.{" "}
            <button type="button" className="link-button" onClick={onGoToBillsIncome}>
              See the calendar
            </button>
          </span>
        </div>
      </div>

      <section className="section" style={{ gap: 16 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="section-title">Planned spending</h2>
            <p className="hint">
              Everyday envelopes with an amount set aside for them. Bills and paychecks aren't here — they repeat, so they live on the{" "}
              <button type="button" className="link-button" onClick={onGoToBillsIncome}>
                Bills &amp; Income calendar
              </button>
              .
            </p>
          </div>
        </div>

        {groupedPlanned.length > 0 ? (
          groupedPlanned.map(([groupName, groupEnvelopes]) => (
            <div key={groupName} className="section" style={{ gap: 10 }}>
              <p className="envelope-group-heading">{groupName}</p>
              <div className="row-list">{groupEnvelopes.map(renderEnvelope)}</div>
            </div>
          ))
        ) : (
          <div className="empty-state">
            <p className="empty-state-title">No envelopes planned yet</p>
            <p className="hint">Set an amount aside for the things you spend on every month — groceries, gas, eating out.</p>
            <button type="button" onClick={() => setCreatingEnvelope(true)}>
              Create your first envelope
            </button>
          </div>
        )}
      </section>

      <section className="section" style={{ gap: 16 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="section-title">Unplanned spending</h2>
            <p className="hint">
              {formatCents(Math.abs(unplannedSpendCents))} across {unplannedItems.length} transaction
              {unplannedItems.length === 1 ? "" : "s"} this month, in categories with no amount set aside for them. Give one an amount and
              it moves up to Planned.
            </p>
          </div>
        </div>

        {activeUntargeted.length > 0 && <div className="row-list">{activeUntargeted.map(renderEnvelope)}</div>}

        {quietUntargeted.length > 0 && (
          <div className="section" style={{ gap: 8 }}>
            <button
              type="button"
              className="secondary"
              style={{ alignSelf: "flex-start" }}
              aria-expanded={showQuietEnvelopes}
              onClick={() => setShowQuietEnvelopes((v) => !v)}
            >
              <span className={`nav-caret ${showQuietEnvelopes ? "is-open" : ""}`} aria-hidden style={{ marginRight: 6 }}>
                ›
              </span>
              {quietUntargeted.length} categor{quietUntargeted.length === 1 ? "y" : "ies"} with nothing in {quietUntargeted.length === 1 ? "it" : "them"} this month
            </button>
            {showQuietEnvelopes && <div className="row-list">{quietUntargeted.map(renderEnvelope)}</div>}
          </div>
        )}

        <div>
          <h3 className="subhead">Every unplanned transaction</h3>
          <p className="hint" style={{ marginBottom: 10 }}>Newest first. Open one to file it somewhere else.</p>
          <IncludedExcludedList
            items={unplannedItems}
            emptyLabel="Everything this month landed in a planned envelope."
            renderRow={renderPlanRow}
          />
        </div>
      </section>

      <section className="card card--padded">
        <div className="section-head">
          <div>
            <h2>Rebuild the plan with AI</h2>
            <p className="hint">Reads your recent spending and proposes a set of envelopes to replace the ones above.</p>
          </div>
          <button type="button" className="secondary" onClick={loadSuggestions} disabled={loadingSuggestions}>
            {loadingSuggestions ? "Thinking…" : "Suggest envelopes"}
          </button>
        </div>
        {suggestions && (
          <div className="section" style={{ gap: 12, marginTop: 16 }}>
            {suggestions.length === 0 ? (
              <p className="hint">Nothing to suggest — your existing envelopes already cover your recent activity.</p>
            ) : (
              <>
                <p className="hint" style={{ margin: 0 }}>
                  Rebuilding archives every envelope currently on this page and replaces it with what's checked below. Bills are not
                  affected.
                </p>
                <div className="row-list">
                  {suggestions.map((s, i) => (
                    <label className="row-item" key={`${s.name}-${i}`} style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={suggestChecked[i] ?? true}
                        onChange={(e) => setSuggestChecked((prev) => ({ ...prev, [i]: e.target.checked }))}
                      />
                      <div className="row-figure" style={{ flex: "1 1 auto" }}>
                        <span className="row-title">
                          {s.name} <span className="badge badge--muted">{s.kind}</span>
                        </span>
                        <span className="row-meta">{s.reasoning}</span>
                      </div>
                      <span className="row-meta">{s.groupName}</span>
                      <span className="money">{s.monthlyTargetCents ? formatCents(s.monthlyTargetCents) : "—"}</span>
                    </label>
                  ))}
                </div>
                <div className="row">
                  <button type="button" onClick={() => setConfirmingRebuild(true)} disabled={rebuilding}>
                    {rebuilding ? "Rebuilding…" : "Rebuild spending plan"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setSuggestions(null)} disabled={rebuilding}>
                    Discard
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {suggestError && <p className="error">{suggestError}</p>}
      </section>

      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {editingEnvelope && (
        <EditEnvelopeModal
          householdId={householdId}
          envelope={editingEnvelope}
          category={categoryById.get(editingEnvelope.category_id)}
          onClose={() => setEditingEnvelope(null)}
          onSaved={onChanged}
        />
      )}

      {creatingEnvelope && <NewEnvelopeModal householdId={householdId} onClose={() => setCreatingEnvelope(false)} onSaved={onChanged} />}

      {adjustingRollover && (
        <RolloverModal
          householdId={householdId}
          envelope={adjustingRollover.envelope}
          category={categoryById.get(adjustingRollover.envelope.category_id)}
          currentRolloverCents={adjustingRollover.rolloverCents}
          onClose={() => setAdjustingRollover(null)}
          onSaved={onChanged}
        />
      )}

      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          body="It stops showing on the plan. Transactions already filed under it keep their category, and you can bring it back from Settings."
          confirmLabel="Archive it"
          onCancel={() => setArchiving(null)}
          onConfirm={async () => {
            const categoryId = archiving.categoryId;
            setArchiving(null);
            await archive(categoryId);
          }}
        />
      )}

      {confirmingRebuild && suggestions && (
        <ConfirmDialog
          title="Replace your spending plan?"
          body={`${rebuildArchiveTargets.length} existing envelope${rebuildArchiveTargets.length === 1 ? "" : "s"} will be archived, then ${
            suggestions.filter((_, i) => suggestChecked[i]).length
          } new one${suggestions.filter((_, i) => suggestChecked[i]).length === 1 ? "" : "s"} created. Bills and income aren't affected.`}
          confirmLabel="Rebuild the plan"
          onCancel={() => setConfirmingRebuild(false)}
          onConfirm={rebuildFromSuggestions}
        />
      )}

      {editingTransaction && (
        <TransactionDetailModal
          householdId={householdId}
          transaction={editingTransaction}
          accounts={accounts}
          categories={categories}
          currentUserId={currentUserId}
          onClose={() => setEditingTransaction(null)}
          onSaved={refreshAfterRowAction}
        />
      )}
    </div>
  );
}
