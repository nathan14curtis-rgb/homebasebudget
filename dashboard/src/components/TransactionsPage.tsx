import { useEffect, useMemo, useState } from "react";
import { api, type Account, type Category, type Transaction, type TransactionFlagColor, type User, type VerifyState } from "../api";
import { dayLabel, formatCents } from "../format";
import { NEEDS_CATEGORY } from "../copy";
import { PencilIcon } from "./icons/PencilIcon";
import { TransactionDetailModal } from "./TransactionDetailModal";
import { RobotIcon } from "./icons/RobotIcon";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";

const FLAG_COLORS: TransactionFlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

interface Props {
  householdId: string;
  currentUserId: string | null;
  users: User[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

type VerifyFilter = "all" | "verified" | "unverified";
type SizeFilter = "all" | "under25" | "25to100" | "over100";
type DatePreset = "thisMonth" | "lastMonth" | "thisYear" | "allTime";

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  thisMonth: "This month",
  lastMonth: "Last month",
  thisYear: "This year",
  allTime: "All time",
};

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local-calendar date ranges (not UTC) for the quick filter chips — the
 * "All time" case is the only one with no bounds. */
function datePresetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case "thisMonth":
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case "lastMonth":
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case "thisYear":
      return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(new Date(now.getFullYear(), 11, 31)) };
    case "allTime":
      return { from: "", to: "" };
  }
}

const SIZE_FILTER_RANGES: Record<Exclude<SizeFilter, "all">, (cents: number) => boolean> = {
  under25: (cents) => Math.abs(cents) < 2500,
  "25to100": (cents) => Math.abs(cents) >= 2500 && Math.abs(cents) <= 10000,
  over100: (cents) => Math.abs(cents) > 10000,
};

// No glyph for 'me' — the checkbox itself already shows checked, and a
// "✓" badge next to a checked checkbox read as two checkmarks stacked on
// top of each other. The robot icon is the one case worth a badge: it's
// new information (auto-verified, not a person) the checkbox alone can't
// convey.
const VERIFY_MARK: Record<VerifyState, { className: string; label: string; content: React.ReactNode }> = {
  me: { className: "verify-mark verify-mark--me", label: "Verified by a household member", content: null },
  ai: { className: "verify-mark verify-mark--ai", label: "Auto-verified — matched to a known merchant", content: <RobotIcon size={11} /> },
  none: { className: "verify-mark verify-mark--none", label: "Unverified — no one has confirmed this yet", content: null },
};

type QuickFilter = "out" | "in" | "needsCategory" | null;

/** Two letters for the row's avatar. Statement descriptions are full of
 * store numbers and punctuation ("SAFEWAY #1290", "SQ *THE BAKERY"), so
 * words that start with neither a letter nor a digit are skipped rather
 * than contributing a "#" or a "*" that identifies nothing. */
function initials(text: string): string {
  const letters = text
    .split(/[\s\-_/]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!)
    .join("")
    .toUpperCase();
  return letters || "?";
}

export function TransactionsPage({ householdId, currentUserId, users, accounts, categories, transactions, onChanged }: Props) {
  const [memberFilter, setMemberFilter] = useState("All");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset | null>("allTime");
  const [merchantQuery, setMerchantQuery] = useState("");
  const [verifyFilter, setVerifyFilter] = useState<VerifyFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null);
  const action = useAction();
  // The pencil opens the shared transaction detail modal rather than
  // editing in place: the same dialog the Spending Plan uses, so category,
  // amount, payee, date, account, tags, splits, note, flag and exclusion
  // are all editable from one place instead of the two fields a row had
  // space for.
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [flagMenuId, setFlagMenuId] = useState<string | null>(null);
  const [flagMenuPos, setFlagMenuPos] = useState<{ top: number; left: number } | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const memberFor = (t: Transaction) => {
    const ownerId = accountById.get(t.account_id)?.owner_user_id;
    return ownerId ? (userById.get(ownerId)?.name ?? "Shared") : "Shared";
  };

  const NEEDS_CATEGORY_FILTER = "__needsCategory";
  const filters = ["All", ...users.map((u) => u.name), NEEDS_CATEGORY_FILTER];
  const filterLabel = (f: string) => (f === NEEDS_CATEGORY_FILTER ? NEEDS_CATEGORY : f);

  const filtered = useMemo(() => {
    const merchantNeedle = merchantQuery.trim().toLowerCase();
    return transactions.filter((t) => {
      if (memberFilter === "All") {
        // no-op
      } else if (memberFilter === NEEDS_CATEGORY_FILTER) {
        if (t.category_id || t.is_transfer) return false;
      } else if (memberFor(t) !== memberFilter) {
        return false;
      }
      if (fromDate && t.posted_at < fromDate) return false;
      if (toDate && t.posted_at > toDate) return false;
      if (merchantNeedle && !(t.normalized_merchant ?? t.raw_description).toLowerCase().includes(merchantNeedle)) return false;
      if (verifyFilter === "verified" && t.verify_state !== "me") return false;
      if (verifyFilter === "unverified" && t.verify_state === "me") return false;
      if (sizeFilter !== "all" && !SIZE_FILTER_RANGES[sizeFilter](t.amount_cents)) return false;
      if (quickFilter === "out" && (t.amount_cents >= 0 || t.is_transfer)) return false;
      if (quickFilter === "in" && (t.amount_cents <= 0 || t.is_transfer)) return false;
      if (quickFilter === "needsCategory" && (t.category_id || t.is_transfer)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, memberFilter, fromDate, toDate, merchantQuery, verifyFilter, sizeFilter, quickFilter, accountById, userById]);

  const groups = useMemo(() => {
    const byDate = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const list = byDate.get(t.posted_at) ?? [];
      list.push(t);
      byDate.set(t.posted_at, list);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, rows]) => ({
        date,
        rows,
        // A transfer's two legs often post on different days (e.g. a card
        // payment initiated one day, credited to the card two days later)
        // — excluded here for the same reason as outCents/inCents below:
        // a lone unmatched leg would otherwise skew that day's net even
        // though no money actually left the household.
        netCents: rows.filter((t) => !t.is_transfer).reduce((sum, t) => sum + t.amount_cents, 0),
      }));
  }, [filtered]);

  // A transfer between two of the household's own accounts (a credit card
  // payment, a savings sweep) shows up twice — once as money leaving one
  // account, once as money landing in the other — so it must never count
  // toward these headline totals or it silently doubles them (a $2,000
  // card payment reads as $2,000 more of both spend and income that never
  // actually happened).
  const nonTransferFiltered = useMemo(() => filtered.filter((t) => !t.is_transfer), [filtered]);
  const outCents = nonTransferFiltered.filter((t) => t.amount_cents < 0).reduce((sum, t) => sum - t.amount_cents, 0);
  const inCents = nonTransferFiltered.filter((t) => t.amount_cents > 0).reduce((sum, t) => sum + t.amount_cents, 0);
  const uncategorizedCount = filtered.filter((t) => !t.category_id && !t.is_transfer).length;

  // Escape closes the flag menu, the way it closes every other menu.
  useEffect(() => {
    if (!flagMenuId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFlagMenuId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flagMenuId]);

  function openFlagMenu(transactionId: string, anchor: HTMLElement) {
    if (flagMenuId === transactionId) {
      setFlagMenuId(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setFlagMenuPos({ top: rect.bottom + 4, left: rect.left });
    setFlagMenuId(transactionId);
  }

  function setFlag(transactionId: string, color: TransactionFlagColor | null) {
    setFlagMenuId(null);
    void action.run(
      async () => {
        await api.setTransactionFlag(householdId, transactionId, color);
        await onChanged();
      },
      { key: transactionId },
    );
  }

  const filtersActive = memberFilter !== "All" || Boolean(fromDate || toDate || merchantQuery) || verifyFilter !== "all" || sizeFilter !== "all" || quickFilter !== null;

  function clearFilters() {
    setMemberFilter("All");
    setFromDate("");
    setToDate("");
    setDatePreset("allTime");
    setMerchantQuery("");
    setVerifyFilter("all");
    setSizeFilter("all");
    setQuickFilter(null);
  }

  function toggleQuickFilter(next: Exclude<QuickFilter, null>) {
    setQuickFilter((f) => (f === next ? null : next));
  }

  function quickFilterKey(e: React.KeyboardEvent, next: Exclude<QuickFilter, null>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleQuickFilter(next);
    }
  }

  function selectDatePreset(preset: DatePreset) {
    const range = datePresetRange(preset);
    setFromDate(range.from);
    setToDate(range.to);
    setDatePreset(preset);
  }

  function exportCsv() {
    const header = "Date,Merchant,Account,Category,Amount\n";
    const rows = filtered.map((t) => {
      const merchant = (t.normalized_merchant ?? t.raw_description).replace(/"/g, '""');
      const account = accountById.get(t.account_id)?.name ?? "";
      const category = t.category_id ? (categoryById.get(t.category_id)?.name ?? "") : "";
      return `${t.posted_at},"${merchant}",${account},${category},${(t.amount_cents / 100).toFixed(2)}`;
    });
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transactions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="section">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ background: "var(--surface-emphasis)", borderRadius: "var(--radius-control)", padding: 4, gap: 4 }}>
          {filters.map((label) => (
            <button
              key={label}
              className={label === memberFilter ? "" : "secondary"}
              style={{ border: "none", padding: "8px 14px" }}
              onClick={() => setMemberFilter(label)}
              type="button"
              aria-pressed={label === memberFilter}
            >
              {filterLabel(label)}
            </button>
          ))}
        </div>
        <button className="secondary" onClick={exportCsv} type="button">
          Export CSV
        </button>
      </div>

      <div className="row" style={{ gap: 4 }}>
        {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((preset) => (
          <button
            key={preset}
            type="button"
            className={preset === datePreset ? "" : "secondary"}
            style={{ padding: "8px 14px", fontSize: 13 }}
            onClick={() => selectDatePreset(preset)}
          >
            {DATE_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-from">From</label>
          <input
            id="tx-filter-from"
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setDatePreset(null);
            }}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-to">To</label>
          <input
            id="tx-filter-to"
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setDatePreset(null);
            }}
          />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 180px" }}>
          <label htmlFor="tx-filter-merchant">Merchant</label>
          <input
            id="tx-filter-merchant"
            type="text"
            placeholder="Search merchant…"
            value={merchantQuery}
            onChange={(e) => setMerchantQuery(e.target.value)}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-verify">Verification</label>
          <select id="tx-filter-verify" value={verifyFilter} onChange={(e) => setVerifyFilter(e.target.value as VerifyFilter)}>
            <option value="all">All</option>
            <option value="verified">Verified</option>
            <option value="unverified">Unverified</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-size">Size</label>
          <select id="tx-filter-size" value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value as SizeFilter)}>
            <option value="all">Any amount</option>
            <option value="under25">Under $25</option>
            <option value="25to100">$25–$100</option>
            <option value="over100">Over $100</option>
          </select>
        </div>
        {filtersActive && (
          <button className="secondary" type="button" style={{ alignSelf: "flex-end" }} onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="row" style={{ justifyContent: "space-between", fontSize: 13, color: "var(--muted)" }}>
        <div className="row" style={{ gap: 24 }}>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--me" style={{ width: 18, height: 18 }}>✓</span>
            verified
          </span>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--ai" style={{ width: 18, height: 18 }}>
              <RobotIcon size={11} />
            </span>
            auto-verified
          </span>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--none" style={{ width: 18, height: 18 }} />
            unverified
          </span>
        </div>
        <span>
          {filtered.length} of {transactions.length} shown
        </span>
      </div>

      <div className="grid-3">
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "out" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          aria-pressed={quickFilter === "out"}
          onClick={() => toggleQuickFilter("out")}
          onKeyDown={(e) => quickFilterKey(e, "out")}
        >
          <span className="label">Money out, filtered</span>
          <span className="figure">{formatCents(-outCents)}</span>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "in" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          aria-pressed={quickFilter === "in"}
          onClick={() => toggleQuickFilter("in")}
          onKeyDown={(e) => quickFilterKey(e, "in")}
        >
          <span className="label">Money in</span>
          <span className="figure" style={{ color: "var(--teal)" }}>
            {formatCents(inCents)}
          </span>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "needsCategory" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          aria-pressed={quickFilter === "needsCategory"}
          onClick={() => toggleQuickFilter("needsCategory")}
          onKeyDown={(e) => quickFilterKey(e, "needsCategory")}
        >
          <span className="label">Needs a category</span>
          <span className="figure">{uncategorizedCount}</span>
        </div>
      </div>

      <Notice notice={action.notice} onDismiss={action.clear} />

      {groups.map((group) => (
        <div key={group.date} className="section" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)" }}>{dayLabel(group.date)}</span>
            <span className="money" style={{ color: "var(--faint)" }}>
              net {group.netCents >= 0 ? "+" : "−"}
              {formatCents(Math.abs(group.netCents))}
            </span>
          </div>
          <div className="row-list">
            {group.rows.map((t) => {
              const category = t.category_id ? categoryById.get(t.category_id) : null;
              const mark = VERIFY_MARK[t.verify_state];
              const isBusy = action.busyKey === t.id;
              const editable = !t.is_transfer;
              return (
                <div
                  className={`row-item ${Boolean(t.excluded_from_budget) || Boolean(t.is_transfer) ? "row-item--excluded" : ""} ${editable ? "row-item--clickable" : ""}`}
                  key={t.id}
                  onClick={(e) => {
                    if (!editable || (e.target as HTMLElement).closest("button, input, select, a")) return;
                    setEditingTransaction(t);
                  }}
                >
                  <div style={{ position: "relative", flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`flag-dot ${t.flag_color ? `flag-dot--${t.flag_color}` : ""}`}
                      title={t.flag_color ? `Flagged ${t.flag_color}` : "Flag this transaction"}
                      aria-label={t.flag_color ? `Flagged ${t.flag_color}. Change flag` : "Flag this transaction"}
                      aria-expanded={flagMenuId === t.id}
                      disabled={isBusy}
                      onClick={(e) => openFlagMenu(t.id, e.currentTarget)}
                    />
                    {flagMenuId === t.id && flagMenuPos && (
                      <>
                        <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setFlagMenuId(null)} />
                        <div className="flag-menu" style={{ top: flagMenuPos.top, left: flagMenuPos.left }} role="group" aria-label="Flag color">
                          {FLAG_COLORS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              className={`flag-dot flag-dot--${color}`}
                              title={`Flag ${color}`}
                              aria-label={`Flag ${color}`}
                              onClick={() => setFlag(t.id, color)}
                            />
                          ))}
                          {t.flag_color && (
                            <button type="button" className="flag-dot" title="Remove flag" aria-label="Remove flag" onClick={() => setFlag(t.id, null)} />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <span className="row-avatar">{initials(t.normalized_merchant ?? t.raw_description)}</span>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                    <span className="row-meta">{memberFor(t)}</span>
                  </div>
                  {t.is_transfer ? (
                    <span className="badge">transfer</span>
                  ) : (
                    <span className={`category-chip ${category ? "" : "category-chip--empty"}`}>{category?.name ?? NEEDS_CATEGORY}</span>
                  )}
                  <span className={`money ${t.amount_cents < 0 ? "" : "positive"}`} style={{ minWidth: 96, textAlign: "right" }}>
                    {formatCents(t.amount_cents)}
                  </span>
                  <span className={mark.className} title={mark.label} style={{ flex: "0 0 auto" }}>
                    {mark.content}
                  </span>
                  {!t.is_transfer && (
                    <button type="button" className="row-edit-btn" title="Edit" aria-label="Edit" disabled={isBusy} onClick={() => setEditingTransaction(t)}>
                      <PencilIcon size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {filtered.length === 0 &&
        (transactions.length === 0 ? (
          <EmptyState title="No transactions yet" hint="Link a bank account or import a CSV from Settings, and they'll show up here." />
        ) : (
          <EmptyState title="Nothing matches these filters">
            <button type="button" className="secondary" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        ))}

      {editingTransaction && (
        <TransactionDetailModal
          householdId={householdId}
          transaction={editingTransaction}
          accounts={accounts}
          categories={categories}
          currentUserId={currentUserId}
          onClose={() => setEditingTransaction(null)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
