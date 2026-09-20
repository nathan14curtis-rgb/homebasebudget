import { useEffect, useState } from "react";
import type { Category, RecurringPattern, SeriesOccurrence, Transaction } from "../api";
import { formatCents } from "../format";
import { NEEDS_CATEGORY } from "../copy";

/**
 * A row on the Spending Plan (docs/SPENDING_PLAN_EDITING.md phase 5).
 *
 * The plan reads forward as well as backward, so a row is one of two
 * things: a transaction that actually posted, or a projected occurrence of
 * a recurring series that nothing has paid yet. Both render identically —
 * date chip, status, category, series link, amount, ⋮ — because to the
 * person reading the plan they are the same kind of thing: money that has
 * moved or is about to.
 */
export type PlanItem =
  | { kind: "transaction"; id: string; transaction: Transaction; occurrence?: SeriesOccurrence; pattern?: RecurringPattern }
  | { kind: "occurrence"; id: string; occurrence: SeriesOccurrence; pattern: RecurringPattern | undefined };

export type PlanItemStatus = "received" | "paid" | "pending" | "upcoming" | "skipped";

export function planItemDate(item: PlanItem): string {
  return item.kind === "transaction" ? item.transaction.posted_at : item.occurrence.due_date;
}

export function planItemTitle(item: PlanItem, category: Category | undefined): string {
  if (item.kind === "transaction") return item.transaction.normalized_merchant ?? item.transaction.raw_description;
  return item.pattern?.merchant_pattern ?? category?.name ?? "Upcoming";
}

/** What a row is worth to the plan's totals. A projected occurrence falls
 * back through its override, its generated amount, then the series'
 * expected amount; the sign comes from the series' kind, since an
 * occurrence stores a magnitude. Null means "no figure yet" — the row
 * shows a dash rather than $0.00, which would read as a real zero-dollar
 * bill. */
export function planItemAmountCents(item: PlanItem): number | null {
  if (item.kind === "transaction") return item.transaction.amount_cents;
  const magnitude = item.occurrence.amount_override_cents ?? item.occurrence.amount_cents ?? item.pattern?.expected_amount_cents ?? null;
  if (magnitude === null) return null;
  return item.pattern?.kind === "income" ? Math.abs(magnitude) : -Math.abs(magnitude);
}

export function planItemStatus(item: PlanItem): PlanItemStatus {
  if (item.kind === "occurrence") return item.occurrence.status === "skipped" ? "skipped" : "upcoming";
  if (item.transaction.pending) return "pending";
  return item.transaction.amount_cents > 0 ? "received" : "paid";
}

/** A skipped occurrence is not money that will move, so it never counts —
 * excluded rows are handled by the section, which keeps them in their own
 * group. */
export function planItemCountsTowardTotal(item: PlanItem): boolean {
  if (item.kind === "transaction") return !item.transaction.excluded_from_budget;
  return item.occurrence.status !== "skipped";
}

export function planItemIsExcluded(item: PlanItem): boolean {
  return item.kind === "transaction" ? Boolean(item.transaction.excluded_from_budget) : item.occurrence.status === "skipped";
}

const STATUS_BADGE: Record<PlanItemStatus, { label: string; className: string }> = {
  received: { label: "Received", className: "badge badge--soft badge--positive" },
  paid: { label: "Paid", className: "badge badge--soft badge--muted" },
  pending: { label: "Pending", className: "badge badge--soft badge--warn" },
  upcoming: { label: "Upcoming", className: "badge badge--soft" },
  skipped: { label: "Skipped", className: "badge badge--soft badge--muted" },
};

/** The calendar chip from the mockup — month abbreviation over the day, so
 * a column of rows can be scanned by date without reading full dates. */
function DateChip({ date }: { date: string }) {
  const day = date.slice(8, 10);
  const month = new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { month: "short" });
  return (
    <span className="date-chip" title={date}>
      <span className="date-chip-month">{month}</span>
      <span className="date-chip-day">{day}</span>
    </span>
  );
}

export interface PlanRowAction {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** The row's "⋮" — same click-away behavior as the envelope menu: a
 * full-viewport transparent backdrop rather than a blur handler, so a
 * click on another row's button opens that one instead of merely closing
 * this one. Positioned fixed from the button's rect, since .row-list clips
 * overflow for its rounded corners. */
function PlanRowMenu({ actions }: { actions: PlanRowAction[] }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPos(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos]);

  return (
    <div style={{ flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="envelope-menu-button"
        aria-label="Row actions"
        onClick={(e) => {
          if (pos) {
            setPos(null);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setPos({ top: rect.bottom + 4, left: rect.right - 260 });
        }}
      >
        ⋮
      </button>
      {pos && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setPos(null)} />
          <div className="envelope-menu-dropdown" style={{ top: pos.top, left: pos.left }}>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="envelope-menu-item"
                disabled={a.disabled}
                style={a.danger ? { color: "var(--red)" } : undefined}
                onClick={() => {
                  setPos(null);
                  a.onClick();
                }}
              >
                <span aria-hidden style={{ width: 16, textAlign: "center" }}>
                  {a.icon}
                </span>
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function PlanRow({
  item,
  category,
  onOpen,
  actions,
}: {
  item: PlanItem;
  category: Category | undefined;
  onOpen: () => void;
  actions: PlanRowAction[];
}) {
  const status = planItemStatus(item);
  const badge = STATUS_BADGE[status];
  const amountCents = planItemAmountCents(item);
  const excluded = planItemIsExcluded(item);
  const linkedToSeries = item.kind === "occurrence" || Boolean(item.occurrence);

  return (
    <div
      className={`row-item row-item--clickable ${excluded ? "row-item--excluded" : ""}`}
      style={{ flexWrap: "wrap", rowGap: 8 }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, select")) return;
        onOpen();
      }}
    >
      <div className="row-figure" style={{ flex: "1 1 200px", minWidth: 160 }}>
        <span className="row-title">{planItemTitle(item, category)}</span>
        <span className="row-meta">{category?.name ?? NEEDS_CATEGORY}</span>
      </div>

      <DateChip date={planItemDate(item)} />
      <span className={badge.className}>{badge.label}</span>

      {linkedToSeries && (
        <span aria-hidden title="Linked to a recurring series" style={{ color: "var(--faint)", flex: "0 0 auto" }}>
          ⇄
        </span>
      )}

      <span
        className={`money ${amountCents !== null && amountCents > 0 ? "positive" : ""}`}
        style={{ minWidth: 110, textAlign: "right", flex: "0 0 auto" }}
      >
        {amountCents === null ? "—" : `${amountCents > 0 ? "+" : ""}${formatCents(amountCents)}`}
      </span>

      <PlanRowMenu actions={actions} />
    </div>
  );
}

/**
 * A section's rows, split the way Simplifi splits them: what counts toward
 * this month, and — folded away behind a count — what a person has
 * deliberately taken out of it. Keeping the excluded rows visible but
 * collapsed is the point: "excluded" should be recoverable, not a hole
 * where a transaction used to be.
 */
export function IncludedExcludedList({
  items,
  emptyLabel,
  renderRow,
}: {
  items: PlanItem[];
  emptyLabel: string;
  renderRow: (item: PlanItem) => React.ReactNode;
}) {
  const [showExcluded, setShowExcluded] = useState(false);
  const included = items.filter((i) => !planItemIsExcluded(i));
  const excluded = items.filter(planItemIsExcluded);

  return (
    <div className="section" style={{ gap: 12 }}>
      <div className="row-list">
        {included.map(renderRow)}
        {included.length === 0 && (
          <div className="row-item">
            <span className="hint">{emptyLabel}</span>
          </div>
        )}
      </div>

      {excluded.length > 0 && (
        <div className="section" style={{ gap: 8 }}>
          <button
            type="button"
            className="secondary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setShowExcluded((v) => !v)}
          >
            <span className={`nav-caret ${showExcluded ? "is-open" : ""}`} aria-hidden style={{ marginRight: 6 }}>
              ›
            </span>
            Excluded this month ({excluded.length})
          </button>
          {showExcluded && <div className="row-list">{excluded.map(renderRow)}</div>}
        </div>
      )}
    </div>
  );
}
