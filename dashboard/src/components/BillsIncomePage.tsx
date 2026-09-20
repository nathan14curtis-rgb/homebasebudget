import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Account,
  type Category,
  type Envelope,
  type RecurringPattern,
  type SeriesOccurrence,
  type Transaction,
} from "../api";
import { formatCents } from "../format";
import {
  WEEKDAY_ABBR,
  addMonths,
  cashOnHandCents,
  dateLabel,
  monthLabel,
  monthOf,
  monthsBetween,
  occurrenceAmountCents,
  occurrenceSignedCents,
  perDiemCents,
  projectDailyBalances,
  todayIso,
  weeksInMonth,
} from "../calendar";
import {
  Modal,
  ScheduleFields,
  type ScheduleState,
  defaultSchedule,
  describeRecurringPatternError,
  scheduleFromDate,
  scheduleFromPattern,
  scheduleIsValid,
  scheduleLabel,
  scheduleToApiInput,
} from "./ScheduleFields";
import { TransactionDetailModal } from "./TransactionDetailModal";
import type { Recurring } from "../useRecurring";
import { usePageAction } from "../pageAction";

interface Props {
  householdId: string;
  accounts: Account[];
  categories: Category[];
  envelopes: Envelope[];
  transactions: Transaction[];
  currentUserId: string | null;
  recurring: Recurring;
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
}

/** Everything a tile needs to draw itself, resolved once rather than
 * re-derived per render inside the grid. */
interface Tile {
  occurrence: SeriesOccurrence;
  pattern: RecurringPattern | undefined;
  category: Category | undefined;
  name: string;
  isIncome: boolean;
  amountCents: number | null;
  /** Something has actually posted against it — paid, or received. */
  settled: boolean;
  overdue: boolean;
  skipped: boolean;
}

function tileStatusLabel(tile: Tile, today: string): string {
  if (tile.skipped) return "Skipped";
  if (tile.settled) return tile.isIncome ? "Received" : "Paid";
  if (tile.occurrence.due_date < today) return tile.isIncome ? "Not received yet" : "Overdue";
  return tile.isIncome ? "Expected" : "Due";
}

function centsToInput(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

function inputToCents(value: string): number | null {
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) ? Math.abs(cents) : null;
}

/* ------------------------------------------------------------------ */
/* Add / edit a series                                                  */
/* ------------------------------------------------------------------ */

/**
 * One form for both "add a bill or paycheck" and "edit this series".
 *
 * The two were the same set of questions all along — what is it, how much,
 * how often, and which merchant on the statement is it — so they are one
 * component, and a fix to either lands on both. The name is the category's
 * name: a bill on the calendar and its envelope in the Spending Plan are
 * the same thing wearing two hats, and giving them separate names is how
 * the two pages drift apart.
 */
function SeriesFormModal({
  householdId,
  categories,
  transactions,
  envelopes,
  pattern,
  defaultDate,
  onClose,
  onSaved,
}: {
  householdId: string;
  categories: Category[];
  transactions: Transaction[];
  envelopes: Envelope[];
  /** Set when editing; absent when adding. */
  pattern?: RecurringPattern;
  /** The square that was clicked, when adding. */
  defaultDate?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = Boolean(pattern);
  const existingCategory = pattern ? categories.find((c) => c.id === pattern.category_id) : undefined;
  const existingEnvelope = pattern ? envelopes.find((e) => e.category_id === pattern.category_id) : undefined;
  // A detected series has no category yet — "Add to calendar" is the
  // moment it gets one, which is what turns a suggestion into a bill.
  const confirming = pattern?.status === "suggested";
  // Adding, or confirming a suggestion: the name is a category to pick or
  // create. Editing a series that already has one: the name is that
  // category's, and typing a new one renames it.
  const choosingCategory = !existingCategory;

  const [kind, setKind] = useState<"expense" | "income">(pattern?.kind ?? "expense");
  const [nameMode, setNameMode] = useState<"new" | "existing">("new");
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState(existingCategory?.name ?? "");
  const [categoryId, setCategoryId] = useState(pattern?.category_id ?? "");
  const [amount, setAmount] = useState(() => {
    const cents = pattern?.expected_amount_cents ?? existingEnvelope?.monthly_target_cents ?? null;
    return cents === null ? "" : centsToInput(cents);
  });
  const [schedule, setSchedule] = useState<ScheduleState>(() =>
    pattern ? scheduleFromPattern(pattern) : defaultDate ? scheduleFromDate(defaultDate) : defaultSchedule(),
  );
  const [merchantPattern, setMerchantPattern] = useState(pattern?.merchant_pattern ?? "");
  const [merchantSearch, setMerchantSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectableCategories = useMemo(
    () => categories.filter((c) => !c.archived_at && (kind === "income" ? c.kind === "income" : c.kind === "expense")).sort((a, b) => a.name.localeCompare(b.name)),
    [categories, kind],
  );

  // Only searched, never listed unprompted: the point is to confirm which
  // line on the statement this is, and a list of every merchant ever is
  // not a confirmation.
  const merchantCandidates = useMemo(() => {
    const needle = merchantSearch.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Set<string>();
    const results: Transaction[] = [];
    for (const t of transactions) {
      if (t.is_transfer) continue;
      if (kind === "income" ? t.amount_cents <= 0 : t.amount_cents >= 0) continue;
      const merchant = t.normalized_merchant ?? t.raw_description;
      if (!merchant.toLowerCase().includes(needle) || seen.has(merchant)) continue;
      seen.add(merchant);
      results.push(t);
      if (results.length >= 6) break;
    }
    return results;
  }, [merchantSearch, transactions, kind]);

  function pickMerchant(t: Transaction) {
    setMerchantPattern(t.normalized_merchant ?? t.raw_description);
    setMerchantSearch("");
    if (!amount.trim()) setAmount(centsToInput(t.amount_cents));
  }

  async function save() {
    const noun = kind === "income" ? "deposit" : "bill";
    let name: string;
    let chosenCategoryId: string | undefined;
    if (choosingCategory) {
      name = nameMode === "new" ? newName.trim() : (selectableCategories.find((c) => c.id === categoryId)?.name ?? "");
      if (nameMode === "new" && !name) return setError(`Give this ${noun} a name`);
      if (nameMode === "existing" && !categoryId) return setError("Choose a category");
      // A typed name that is already a category is that category — a
      // second "Utilities" would never link to the charges the first
      // one already has.
      const sameName = nameMode === "new" ? selectableCategories.find((c) => c.name.trim().toLowerCase() === name.toLowerCase()) : undefined;
      chosenCategoryId = nameMode === "existing" ? categoryId : sameName?.id;
    } else {
      name = renameTo.trim();
      if (!name) return setError(`Give this ${noun} a name`);
    }
    if (!scheduleIsValid(schedule)) return setError("Fill in when it repeats");
    const amountCents = amount.trim() ? inputToCents(amount) : null;
    if (amount.trim() && amountCents === null) return setError("Enter a valid amount");
    // The merchant defaults to the name so a hand-entered bill still
    // auto-matches when it eventually shows up on a statement.
    const merchant = merchantPattern.trim() || pattern?.merchant_pattern || name;

    setSaving(true);
    setError(null);
    try {
      if (pattern && confirming) {
        // One request: confirm (which is what puts it on the calendar) with
        // the category, amount and schedule corrected here. The server
        // groups the category's envelope under Bills and mirrors the amount.
        await api.confirmRecurringPattern(householdId, pattern.id, {
          categoryId: chosenCategoryId,
          newCategoryName: chosenCategoryId ? undefined : name,
          kind,
          merchantPattern: merchant,
          expectedAmountCents: amountCents,
          ...scheduleToApiInput(schedule),
        });
      } else if (pattern) {
        await api.updateRecurringPattern(householdId, pattern.id, {
          merchantPattern: merchant,
          expectedAmountCents: amountCents,
          ...scheduleToApiInput(schedule),
        });
        if (existingCategory && name !== existingCategory.name) {
          await api.renameCategory(householdId, existingCategory.id, name);
        }
      } else {
        await api.createRecurringPattern(householdId, {
          merchantPattern: merchant,
          kind,
          categoryId: chosenCategoryId,
          newCategoryName: chosenCategoryId ? undefined : name,
          monthlyTargetCents: kind === "expense" && amountCents !== null ? amountCents : undefined,
          expectedAmountCents: amountCents ?? undefined,
          ...scheduleToApiInput(schedule),
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(describeRecurringPatternError(err, "Failed to save"));
      setSaving(false);
    }
  }

  const noun = kind === "income" ? "income" : "bill";

  return (
    <Modal
      title={confirming ? `Add ${pattern?.merchant_pattern ?? "this"} to the calendar` : editing ? `Edit ${existingCategory?.name ?? "series"}` : "Add a bill or income"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : confirming ? "Add to calendar" : editing ? "Save changes" : `Add ${noun}`}
          </button>
        </>
      }
    >
      <div className="field">
        <label id="series-kind-label">Type</label>
        <div className="segmented" role="radiogroup" aria-labelledby="series-kind-label">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "expense"}
            className={`segmented-option segmented-option--bill ${kind === "expense" ? "is-selected" : ""}`}
            disabled={editing}
            onClick={() => setKind("expense")}
          >
            Bill
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "income"}
            className={`segmented-option segmented-option--income ${kind === "income" ? "is-selected" : ""}`}
            disabled={editing}
            onClick={() => setKind("income")}
          >
            Income
          </button>
        </div>
        {editing && <p className="hint">A series can't change between a bill and income — delete it and add it the other way instead.</p>}
      </div>

      <div className="field">
        <label htmlFor="series-name">Name</label>
        {!choosingCategory ? (
          <>
            <input id="series-name" type="text" data-autofocus="true" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
            <p className="hint">Also the name of its category and envelope — renaming here renames all three.</p>
          </>
        ) : nameMode === "new" ? (
          <input
            id="series-name"
            type="text"
            data-autofocus="true"
            placeholder={kind === "income" ? "e.g. Paycheck" : "e.g. Electric"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        ) : (
          <select id="series-name" data-autofocus="true" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="" disabled>
              Choose a category…
            </option>
            {selectableCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {choosingCategory && (
          <button
            type="button"
            className="link-button"
            onClick={() => setNameMode((m) => (m === "new" ? "existing" : "new"))}
            disabled={nameMode === "new" && selectableCategories.length === 0}
          >
            {nameMode === "new" ? "Use an existing category instead" : "Create a new category instead"}
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor="series-amount">Amount</label>
        <div className="input-prefix">
          <span aria-hidden>$</span>
          <input
            id="series-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <p className="hint">What you expect it to be. A month that comes in different can be corrected on the day itself.</p>
      </div>

      <div className="field">
        <label>Repeats</label>
        <ScheduleFields value={schedule} onChange={setSchedule} idPrefix="series" />
      </div>

      <div className="field">
        <label htmlFor="series-merchant">Matches this merchant</label>
        {merchantPattern ? (
          <div className="picked-value">
            <span className="money-label">{merchantPattern}</span>
            <button type="button" className="secondary" onClick={() => setMerchantPattern("")}>
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="series-merchant"
              type="text"
              placeholder="Search your past transactions…"
              value={merchantSearch}
              onChange={(e) => setMerchantSearch(e.target.value)}
            />
            {merchantCandidates.length > 0 && (
              <div className="row-list" style={{ marginTop: 8 }}>
                {merchantCandidates.map((t) => (
                  <button type="button" className="row-item row-item--button" key={t.id} onClick={() => pickMerchant(t)}>
                    <div className="row-figure" style={{ flex: "1 1 auto" }}>
                      <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                      <span className="row-meta">{t.posted_at}</span>
                    </div>
                    <span className="money">{formatCents(t.amount_cents)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <p className="hint">Optional — it's how a real charge gets ticked off against this automatically. Left blank, the name is used.</p>
      </div>

      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One tile's detail                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a tile opens into: this one occurrence on top, the series it comes
 * from underneath.
 *
 * The split matters and the dialog says so out loud — changing "this
 * month" is a correction to one square, changing the series is a change to
 * every square it will ever produce. Getting those two confused is the
 * main way a recurring budget quietly goes wrong.
 */
function OccurrenceModal({
  householdId,
  tile,
  today,
  matchedTransaction,
  onClose,
  onSaved,
  onEditSeries,
  onOpenTransaction,
}: {
  householdId: string;
  tile: Tile;
  today: string;
  matchedTransaction: Transaction | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onEditSeries: () => void;
  onOpenTransaction: (transaction: Transaction) => void;
}) {
  const { occurrence, pattern } = tile;
  const initialAmount = useMemo(() => {
    const cents = occurrenceAmountCents(occurrence, pattern);
    return cents === null ? "" : centsToInput(cents);
  }, [occurrence, pattern]);
  const [amount, setAmount] = useState(initialAmount);
  const [dueDate, setDueDate] = useState(occurrence.due_date);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function run(work: () => Promise<unknown>, failure: string) {
    setSaving(true);
    setError(null);
    try {
      await work();
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      setSaving(false);
    }
  }

  function saveThisMonth() {
    const trimmed = amount.trim();
    const amountOverrideCents = trimmed === "" ? null : inputToCents(trimmed);
    if (trimmed !== "" && amountOverrideCents === null) {
      setError("Enter a valid amount, or clear it to go back to what the series expects");
      return;
    }
    // Only an amount the person actually changed becomes an override.
    // Sending the pre-filled figure back would pin this square to today's
    // projection, so a later series edit (or the real charge) could never
    // move it.
    const amountChanged = trimmed !== initialAmount.trim();
    void run(
      () => api.updateOccurrence(householdId, occurrence.id, { ...(amountChanged ? { amountOverrideCents } : {}), dueDate }),
      "Failed to save",
    );
  }

  return (
    <Modal
      title={tile.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={saveThisMonth} disabled={saving || tile.settled}>
            {saving ? "Saving…" : "Save this month"}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 8 }}>
        <span className={`badge badge--soft ${tile.isIncome ? "badge--positive" : "badge--muted"}`}>{tile.isIncome ? "Income" : "Bill"}</span>
        <span className="badge badge--soft badge--muted">{tileStatusLabel(tile, today)}</span>
        <span className="hint" style={{ margin: 0 }}>{dateLabel(occurrence.due_date)}</span>
      </div>

      {tile.settled ? (
        <div className="callout">
          <p style={{ margin: 0 }}>
            {tile.isIncome ? "Received" : "Paid"} — {matchedTransaction ? formatCents(Math.abs(matchedTransaction.amount_cents)) : formatCents(tile.amountCents ?? 0)}
            {matchedTransaction ? ` on ${matchedTransaction.posted_at}` : ""}.
          </p>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            {matchedTransaction && (
              <button type="button" className="secondary" onClick={() => onOpenTransaction(matchedTransaction)}>
                Open the transaction
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => void run(() => api.unlinkOccurrence(householdId, occurrence.id), "Failed to unlink")}
            >
              This isn't it — unlink
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="occ-amount">Amount this month</label>
              <div className="input-prefix">
                <span aria-hidden>$</span>
                <input
                  id="occ-amount"
                  type="text"
                  inputMode="decimal"
                  data-autofocus="true"
                  placeholder="From the series"
                  value={amount}
                  disabled={saving}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="occ-due">{tile.isIncome ? "Expected on" : "Due on"}</label>
              <input id="occ-due" type="date" value={dueDate} disabled={saving} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <p className="hint">Only this one — the series keeps expecting {pattern?.expected_amount_cents ? formatCents(Math.abs(pattern.expected_amount_cents)) : "whatever it has been"}. Clear the amount to go back to that.</p>

          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() =>
              void run(
                () => api.updateOccurrence(householdId, occurrence.id, { status: tile.skipped ? "upcoming" : "skipped" }),
                "Failed to save",
              )
            }
          >
            {tile.skipped ? "Put this one back" : `Skip just this ${tile.isIncome ? "deposit" : "bill"}`}
          </button>
        </>
      )}

      <hr className="rule" />

      <div className="section" style={{ gap: 10 }}>
        <div>
          <h4 className="subhead">The series</h4>
          <p className="hint" style={{ margin: 0 }}>
            {pattern ? scheduleLabel(pattern) : "Recurring"}
            {pattern?.merchant_pattern ? ` · matches “${pattern.merchant_pattern}”` : ""}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="secondary" onClick={onEditSeries} disabled={saving || !pattern}>
            Edit every {tile.isIncome ? "deposit" : "bill"}
          </button>
          {pattern && !confirmingDelete && (
            <button type="button" className="danger" onClick={() => setConfirmingDelete(true)} disabled={saving}>
              Delete series
            </button>
          )}
        </div>
        {confirmingDelete && pattern && (
          <div className="callout callout--danger">
            <p style={{ margin: 0 }}>
              Delete “{tile.name}” and every square it puts on the calendar? Transactions that already posted stay where they are; the
              category and its envelope stay too.
            </p>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                Keep it
              </button>
              <button
                type="button"
                className="danger"
                disabled={saving}
                onClick={() => void run(() => api.deleteRecurringPattern(householdId, pattern.id), "Failed to delete")}
              >
                Delete it
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* The page                                                             */
/* ------------------------------------------------------------------ */

export function BillsIncomePage({
  householdId,
  accounts,
  categories,
  envelopes,
  transactions,
  currentUserId,
  recurring,
  onChanged,
  onTransactionsChanged,
}: Props) {
  const today = useMemo(() => todayIso(), []);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const { patterns, occurrencesByMonth, loading } = recurring;
  const [error, setError] = useState<string | null>(null);
  const [openTile, setOpenTile] = useState<Tile | null>(null);
  const [editingPattern, setEditingPattern] = useState<RecurringPattern | null>(null);
  const [adding, setAdding] = useState<{ date?: string } | null>(null);
  const [openTransaction, setOpenTransaction] = useState<Transaction | null>(null);
  const [detecting, setDetecting] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const refresh = recurring.refresh;

  // The projection needs every month between today and the one on screen,
  // not just the visible one: a future month's estimate that skipped the
  // bills in between would start from the wrong balance.
  const neededMonths = useMemo(() => (month >= today.slice(0, 7) ? monthsBetween(today.slice(0, 7), month) : [month]), [month, today]);
  const ensureMonths = recurring.ensureMonths;
  useEffect(() => {
    ensureMonths(neededMonths);
  }, [ensureMonths, neededMonths]);

  usePageAction("Add bill or income", () => setAdding({}));

  // ← / → step months when the calendar has focus but no dialog is open,
  // the way every other calendar works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (openTile || adding || editingPattern || openTransaction) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, select, textarea")) return;
      if (e.key === "ArrowLeft") setMonth((m) => addMonths(m, -1));
      if (e.key === "ArrowRight") setMonth((m) => addMonths(m, 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTile, adding, editingPattern, openTransaction]);

  const patternById = useMemo(() => new Map(patterns.map((p) => [p.id, p])), [patterns]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const billCategoryIds = useMemo(
    () => new Set(patterns.filter((p) => p.status === "confirmed" && p.category_id).map((p) => p.category_id!)),
    [patterns],
  );
  const transactionById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);

  const occurrences = useMemo(() => occurrencesByMonth[month] ?? [], [occurrencesByMonth, month]);

  const tilesByDate = useMemo(() => {
    const byDate = new Map<string, Tile[]>();
    for (const occurrence of occurrences) {
      const pattern = patternById.get(occurrence.pattern_id);
      const category = pattern?.category_id ? categoryById.get(pattern.category_id) : undefined;
      const tile: Tile = {
        occurrence,
        pattern,
        category,
        name: category?.name ?? pattern?.merchant_pattern ?? "Untitled",
        isIncome: pattern?.kind === "income",
        amountCents: occurrenceAmountCents(occurrence, pattern),
        settled: occurrence.status === "matched",
        overdue: occurrence.status === "upcoming" && occurrence.due_date < today,
        skipped: occurrence.status === "skipped",
      };
      const bucket = byDate.get(occurrence.due_date) ?? [];
      bucket.push(tile);
      byDate.set(occurrence.due_date, bucket);
    }
    // Income first, then the largest bills — the tiles that change the
    // day's shape the most are the ones you see without expanding.
    for (const bucket of byDate.values()) {
      bucket.sort((a, b) => Number(b.isIncome) - Number(a.isIncome) || (b.amountCents ?? 0) - (a.amountCents ?? 0));
    }
    return byDate;
  }, [occurrences, patternById, categoryById, today]);

  const weeks = useMemo(() => weeksInMonth(month), [month]);

  const balances = useMemo(
    () =>
      projectDailyBalances({
        month,
        today,
        startingCashCents: cashOnHandCents(accounts),
        occurrencesByMonth,
        patternById,
        perDiemCentsForMonth: (m) => perDiemCents(envelopes, categoryById, m, billCategoryIds),
      }),
    [month, today, accounts, occurrencesByMonth, patternById, envelopes, categoryById, billCategoryIds],
  );

  const totals = useMemo(() => {
    let income = 0;
    let bills = 0;
    for (const occurrence of occurrences) {
      const signed = occurrenceSignedCents(occurrence, patternById.get(occurrence.pattern_id));
      if (signed > 0) income += signed;
      else bills += -signed;
    }
    return { income, bills, net: income - bills };
  }, [occurrences, patternById]);

  function weekNetCents(week: { date: string | null }[]): number {
    return week.reduce((sum, cell) => {
      if (!cell.date) return sum;
      return sum + (tilesByDate.get(cell.date) ?? []).reduce((s, t) => s + occurrenceSignedCents(t.occurrence, t.pattern), 0);
    }, 0);
  }

  async function refreshEverything() {
    await Promise.all([refresh(), onChanged(), onTransactionsChanged()]);
  }

  async function detect() {
    setDetecting(true);
    setError(null);
    try {
      const found = await api.detectRecurringPatterns(householdId);
      // Detection only ever *suggests*; anything it turns up still needs a
      // category before it can go on the calendar, which is what the
      // review strip below does.
      if (found.length === 0) setError("Nothing new — every repeating merchant in your history is already on the calendar.");
      await refresh();
    } catch (err) {
      setError(describeRecurringPatternError(err, "Couldn't look for recurring bills"));
    } finally {
      setDetecting(false);
    }
  }

  const suggested = useMemo(() => patterns.filter((p) => p.status === "suggested"), [patterns]);
  const isCurrentMonth = month === today.slice(0, 7);
  const perDiem = perDiemCents(envelopes, categoryById, month, billCategoryIds);

  return (
    <div className="section">
      <div className="grid-3">
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Income this month</span>
          <span className="figure money positive">{formatCents(totals.income)}</span>
          <span className="detail">Every deposit the calendar expects, received or not.</span>
        </div>
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Bills this month</span>
          <span className="figure money">{formatCents(totals.bills)}</span>
          <span className="detail">Committed before a dollar of everyday spending.</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Left over</span>
          <span className={`figure money ${totals.net < 0 ? "negative" : ""}`}>{formatCents(totals.net)}</span>
          <span className="detail">Income minus bills — what the Spending Plan has to work with.</span>
        </div>
      </div>

      {suggested.length > 0 && (
        <section className="card card--padded">
          <div className="section-head">
            <div>
              <h2>Found {suggested.length} that repeat{suggested.length === 1 ? "s" : ""}</h2>
              <p className="hint">Add one to put it on the calendar, or dismiss it if it isn't really a bill.</p>
            </div>
          </div>
          <div className="row-list">
            {suggested.map((p) => (
              <div className="row-item" key={p.id}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{p.merchant_pattern}</span>
                  <span className="row-meta">
                    {p.kind === "expense" ? "Charge" : "Deposit"} · {scheduleLabel(p)} · seen {p.sample_count} times
                  </span>
                </div>
                {p.expected_amount_cents !== null && <span className="money">{formatCents(Math.abs(p.expected_amount_cents))}</span>}
                <button type="button" onClick={() => setEditingPattern(p)}>
                  Add to calendar
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void api.dismissRecurringPattern(householdId, p.id).then(refresh)}
                >
                  Not a bill
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card calendar-card">
        <header className="calendar-head">
          <div className="calendar-nav">
            <button type="button" className="row-edit-btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
              ‹
            </button>
            <h2 className="calendar-month" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <button type="button" className="row-edit-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
              ›
            </button>
            {!isCurrentMonth && (
              <button type="button" className="secondary" onClick={() => setMonth(today.slice(0, 7))}>
                Today
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="secondary" onClick={detect} disabled={detecting}>
              {detecting ? "Looking…" : "Find repeating charges"}
            </button>
            <button type="button" ref={addButtonRef} onClick={() => setAdding({})}>
              + Add
            </button>
          </div>
        </header>

        {(error ?? recurring.error) && (
          <p className="error" style={{ padding: "0 24px 12px" }}>
            {error ?? recurring.error}
          </p>
        )}

        <div className="calendar-grid" role="grid" aria-label={`Bills and income for ${monthLabel(month)}`}>
          <div className="calendar-weekdays" role="row">
            {WEEKDAY_ABBR.map((d) => (
              <div key={d} className="calendar-weekday" role="columnheader">
                <span className="calendar-weekday-long">{d}</span>
                <span className="calendar-weekday-short" aria-hidden>
                  {d[0]}
                </span>
              </div>
            ))}
            <div className="calendar-weekday calendar-weekday--net" role="columnheader">
              Net
            </div>
          </div>

          {weeks.map((week, weekIndex) => {
            const net = weekNetCents(week);
            return (
              <div className="calendar-week" role="row" key={weekIndex}>
                {week.map((cell, cellIndex) => {
                  if (!cell.date) return <div className="calendar-day calendar-day--blank" key={cellIndex} role="gridcell" aria-hidden />;
                  // Bound to a const so the click handlers below keep the
                  // narrowing the guard above just established.
                  const date = cell.date;
                  const tiles = tilesByDate.get(date) ?? [];
                  const balance = balances.get(date);
                  const isToday = date === today;
                  return (
                    <div className={`calendar-day ${isToday ? "is-today" : ""} ${date < today ? "is-past" : ""}`} role="gridcell" key={date}>
                      {/* The whole empty area of the square is the "add
                          here" target, but it sits behind the tiles rather
                          than wrapping them — a button inside a button is
                          invalid, and nesting them is what makes a click on
                          a tile open the add form by mistake. */}
                      <button
                        type="button"
                        className="calendar-day-add"
                        aria-label={`Add a bill or income on ${dateLabel(date)}`}
                        title={`Add on ${dateLabel(date)}`}
                        onClick={() => setAdding({ date })}
                      >
                        <span className="calendar-day-plus" aria-hidden>
                          +
                        </span>
                      </button>
                      <span className="calendar-day-number">{cell.day}</span>
                      <div className="calendar-day-tiles">
                        {tiles.map((tile) => (
                          <button
                            type="button"
                            key={tile.occurrence.id}
                            className={[
                              "cal-tile",
                              tile.isIncome ? "cal-tile--income" : "cal-tile--bill",
                              tile.settled ? "is-settled" : "",
                              tile.overdue ? "is-overdue" : "",
                              tile.skipped ? "is-skipped" : "",
                            ].join(" ")}
                            title={`${tile.name} — ${tile.amountCents === null ? "no amount yet" : formatCents(tile.amountCents)} · ${tileStatusLabel(tile, today)}`}
                            onClick={() => setOpenTile(tile)}
                          >
                            <span className="cal-tile-amount">
                              {tile.amountCents === null ? "—" : formatCents(tile.amountCents)}
                              {tile.settled && (
                                <span className="cal-tile-check" aria-hidden>
                                  ✓
                                </span>
                              )}
                            </span>
                            <span className="cal-tile-name">{tile.name}</span>
                          </button>
                        ))}
                      </div>
                      {balance !== undefined && (
                        <span className={`calendar-day-balance ${balance < 0 ? "is-negative" : ""}`} title="Estimated cash on hand, projected from today">
                          {formatCents(balance)}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className={`calendar-week-net ${net < 0 ? "is-negative" : net > 0 ? "is-positive" : ""}`} role="gridcell">
                  <span className="calendar-week-net-label">Week</span>
                  <span className="money">{net === 0 ? "—" : `${net > 0 ? "+" : ""}${formatCents(net)}`}</span>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="calendar-legend">
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--income" aria-hidden /> Income
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--bill" aria-hidden /> Bill
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--settled" aria-hidden /> ✓ posted
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--overdue" aria-hidden /> Overdue
          </span>
          <span className="legend-item legend-item--balance">
            Grey figure: estimated cash that day — today's balance, less {formatCents(perDiem)}/day of everyday spending, plus income, minus
            bills. A guess, not a forecast.
          </span>
        </footer>
      </section>

      {loading && <p className="hint">Loading…</p>}
      {!loading && !recurring.error && occurrences.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">Nothing on the calendar for {monthLabel(month)}</p>
          <p className="hint">Add a bill or a paycheck, or let it look through your transactions for things that already repeat.</p>
          <div className="row" style={{ gap: 8, justifyContent: "center" }}>
            <button type="button" onClick={() => setAdding({})}>
              Add a bill or income
            </button>
            <button type="button" className="secondary" onClick={detect} disabled={detecting}>
              {detecting ? "Looking…" : "Find repeating charges"}
            </button>
          </div>
        </div>
      )}

      {openTile && (
        <OccurrenceModal
          householdId={householdId}
          tile={openTile}
          today={today}
          matchedTransaction={openTile.occurrence.matched_transaction_id ? transactionById.get(openTile.occurrence.matched_transaction_id) : undefined}
          onClose={() => setOpenTile(null)}
          onSaved={refreshEverything}
          onEditSeries={() => {
            const pattern = openTile.pattern;
            setOpenTile(null);
            if (pattern) setEditingPattern(pattern);
          }}
          onOpenTransaction={(transaction) => {
            setOpenTile(null);
            setOpenTransaction(transaction);
          }}
        />
      )}

      {(adding || editingPattern) && (
        <SeriesFormModal
          householdId={householdId}
          categories={categories}
          transactions={transactions}
          envelopes={envelopes}
          pattern={editingPattern ?? undefined}
          defaultDate={adding?.date}
          onClose={() => {
            setAdding(null);
            setEditingPattern(null);
            addButtonRef.current?.focus();
          }}
          onSaved={refreshEverything}
        />
      )}

      {openTransaction && (
        <TransactionDetailModal
          householdId={householdId}
          transaction={openTransaction}
          accounts={accounts}
          categories={categories}
          currentUserId={currentUserId}
          onClose={() => setOpenTransaction(null)}
          onSaved={refreshEverything}
        />
      )}
    </div>
  );
}
