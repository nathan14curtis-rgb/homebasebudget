import { useEffect, useMemo, useState } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary, type Transaction } from "../api";
import { formatCents, currentMonth } from "../format";
import { occurrenceAmountCents, todayIso } from "../calendar";
import type { Recurring } from "../useRecurring";
import { envelopeStatus, STATUS_BADGE_CLASS } from "../envelopeStatus";
import { PaceChart } from "../charts/PaceChart";
import { EnvelopePieChart, type PieSliceInput } from "../charts/EnvelopePieChart";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  recurring: Recurring;
  onGoToTransactions: () => void;
  onGoToEnvelopes: () => void;
  onGoToBillsIncome: () => void;
}

function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { fromDate: iso(start), toDate: iso(end), daysInMonth: end.getDate(), dayOfMonth: now.getDate() };
}

export function OverviewPage({
  householdId,
  categories,
  envelopes,
  envelopeSummaries,
  transactions,
  recurring,
  onGoToTransactions,
  onGoToEnvelopes,
  onGoToBillsIncome,
}: Props) {
  const [monthTransactions, setMonthTransactions] = useState<Transaction[]>([]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const activeEnvelopes = useMemo(() => envelopes.filter((e) => !e.archived_at), [envelopes]);

  useEffect(() => {
    let cancelled = false;
    const { fromDate, toDate } = monthRange();
    api.listTransactions(householdId, { fromDate, toDate, limit: 1000 }).then((rows) => {
      if (!cancelled) setMonthTransactions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  // Everyday spending only. A bill isn't paced against a month — it is due
  // on a day, and the Bills & Income calendar is where it is read — so
  // mixing bills into "spent so far of planned" made the one number this
  // page leads with answer a question nobody was asking.
  const expenseEnvelopes = useMemo(
    () =>
      activeEnvelopes.filter(
        (e) => categoryById.get(e.category_id)?.kind === "expense" && e.monthly_target_cents && e.group_name.toLowerCase() !== "bills",
      ),
    [activeEnvelopes, categoryById],
  );
  const budgetCents = useMemo(() => expenseEnvelopes.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [expenseEnvelopes]);
  const spentCents = useMemo(
    () => expenseEnvelopes.reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [expenseEnvelopes, envelopeSummaries],
  );
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 0;

  const { daysInMonth, dayOfMonth } = monthRange();
  // Budgeted-category ids only — matches budgetCents/spentCents above.
  // Previously this summed every non-transfer expense in the month
  // regardless of whether its category had a budgeted envelope, so the
  // pace line's endpoint didn't match the "spent so far" figure directly
  // above it (spend in an unbudgeted or uncategorized category inflated
  // the line but wasn't part of the number it was supposedly pacing).
  const budgetedCategoryIds = useMemo(() => new Set(expenseEnvelopes.map((e) => e.category_id)), [expenseEnvelopes]);
  const dailyCumulativeCents = useMemo(() => {
    const daily = new Array(dayOfMonth).fill(0);
    for (const t of monthTransactions) {
      if (t.amount_cents >= 0 || t.is_transfer || t.excluded_from_budget) continue;
      if (!t.category_id || !budgetedCategoryIds.has(t.category_id)) continue;
      const day = Number(t.posted_at.slice(8, 10));
      if (day >= 1 && day <= dayOfMonth) daily[day - 1] += -t.amount_cents;
    }
    let running = 0;
    return daily.map((v: number) => (running += v));
  }, [monthTransactions, dayOfMonth, budgetedCategoryIds]);

  const incomeCents = useMemo(
    () =>
      monthTransactions
        .filter((t) => t.category_id && categoryById.get(t.category_id)?.kind === "income")
        .reduce((sum, t) => sum + t.amount_cents, 0),
    [monthTransactions, categoryById],
  );
  /** This month as the Bills & Income calendar has it: what is committed,
   * how much of it has actually moved, and what is next. */
  const billsAndIncome = useMemo(() => {
    const today = todayIso();
    const occurrences = recurring.occurrencesByMonth[currentMonth()] ?? [];
    const patternById = new Map(recurring.patterns.map((p) => [p.id, p]));
    let billsTotal = 0;
    let billsPaid = 0;
    let incomeTotal = 0;
    let incomeReceived = 0;
    let overdue = 0;
    const upcoming: { name: string; dueDate: string; amountCents: number | null; isIncome: boolean }[] = [];
    for (const o of occurrences) {
      if (o.status === "skipped") continue;
      const p = patternById.get(o.pattern_id);
      const amount = occurrenceAmountCents(o, p) ?? 0;
      const isIncome = p?.kind === "income";
      if (isIncome) {
        incomeTotal += amount;
        if (o.status === "matched") incomeReceived += amount;
      } else {
        billsTotal += amount;
        if (o.status === "matched") billsPaid += amount;
      }
      if (o.status === "upcoming") {
        if (o.due_date < today) overdue += 1;
        upcoming.push({
          name: categoryById.get(p?.category_id ?? "")?.name ?? p?.merchant_pattern ?? "Untitled",
          dueDate: o.due_date,
          amountCents: occurrenceAmountCents(o, p),
          isIncome,
        });
      }
    }
    upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return { billsTotal, billsPaid, incomeTotal, incomeReceived, overdue, upcoming: upcoming.slice(0, 4) };
  }, [recurring.occurrencesByMonth, recurring.patterns, categoryById]);
  const savedCents = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings")
        .reduce((sum, e) => sum + (envelopeSummaries[e.id]?.allocatedCents ?? 0), 0),
    [activeEnvelopes, categoryById, envelopeSummaries],
  );

  const pieSlices: PieSliceInput[] = useMemo(() => {
    const countByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      if (!t.category_id || t.is_transfer || t.excluded_from_budget) continue;
      countByCategory.set(t.category_id, (countByCategory.get(t.category_id) ?? 0) + 1);
    }
    return expenseEnvelopes.map((e) => ({
      id: e.id,
      name: categoryById.get(e.category_id)?.name ?? "Envelope",
      groupName: e.group_name,
      plannedCents: e.monthly_target_cents ?? 0,
      spentCents: envelopeSummaries[e.id]?.spentCents ?? 0,
      count: countByCategory.get(e.category_id) ?? 0,
    }));
  }, [expenseEnvelopes, categoryById, envelopeSummaries, monthTransactions]);

  const envelopeCards = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => e.monthly_target_cents && e.group_name.toLowerCase() !== "bills" && categoryById.get(e.category_id)?.kind === "expense")
        // Tightest first: the envelope about to run out is the one worth
        // seeing without scrolling.
        .sort((a, b) => {
          const left = (s: EnvelopeMonthSummary | undefined, e: Envelope) => (s ? s.balanceCents / (e.monthly_target_cents || 1) : 1);
          return left(envelopeSummaries[a.id], a) - left(envelopeSummaries[b.id], b);
        }),
    [activeEnvelopes, categoryById, envelopeSummaries],
  );

  // Income & expense summary (a lightweight P&L for the month) — replaces
  // "Recent activity" per request: a running feed of the last few
  // transactions duplicated what Transactions already shows, where a
  // profit/loss breakdown by category is Overview-specific and answers "where
  // did the money actually go this month" at a glance.
  const plRows = useMemo(() => {
    const byCategory = new Map<string, { name: string; kind: Category["kind"]; cents: number }>();
    for (const t of monthTransactions) {
      if (t.is_transfer || t.excluded_from_budget || !t.category_id) continue;
      const category = categoryById.get(t.category_id);
      if (!category || (category.kind !== "income" && category.kind !== "expense")) continue;
      const existing = byCategory.get(category.id);
      const cents = (existing?.cents ?? 0) + t.amount_cents;
      byCategory.set(category.id, { name: category.name, kind: category.kind, cents });
    }
    const rows = [...byCategory.values()];
    const income = rows.filter((r) => r.kind === "income").sort((a, b) => b.cents - a.cents);
    const expenses = rows.filter((r) => r.kind === "expense").sort((a, b) => a.cents - b.cents);
    const totalIncomeCents = income.reduce((sum, r) => sum + r.cents, 0);
    const totalExpenseCents = expenses.reduce((sum, r) => sum + r.cents, 0);
    return { income, expenses, totalIncomeCents, totalExpenseCents, netCents: totalIncomeCents + totalExpenseCents };
  }, [monthTransactions, categoryById]);

  const goals = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings" && e.target_date)
        .slice(0, 3),
    [activeEnvelopes, categoryById],
  );

  return (
    <>
      <section className="grid-2" style={{ gridTemplateColumns: "1.15fr 1fr", alignItems: "stretch" }}>
        <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="label">Spent so far</span>
            <span className="badge badge--soft" style={{ background: "var(--surface)" }}>
              {pct}% of budget
            </span>
          </div>
          <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 64, lineHeight: 1, letterSpacing: "-1.5px", color: "var(--ink)" }}>
              {formatCents(spentCents)}
            </span>
            <span style={{ fontSize: 16, color: "var(--muted)", paddingBottom: 8 }}>of {formatCents(budgetCents)} planned</span>
          </div>
          <PaceChart dailyCumulativeCents={dailyCumulativeCents} budgetCents={budgetCents} daysInMonth={daysInMonth} />
          <div className="grid-3 grid-3--compact" style={{ borderTop: "1px solid var(--track)", paddingTop: 24 }}>
            <div className="stat-tile">
              <span className="label">Income</span>
              <span className="figure figure--small">{formatCents(incomeCents)}</span>
            </div>
            <div className="stat-tile">
              <span className="label">Bills</span>
              <span className="figure figure--small">{formatCents(billsAndIncome.billsTotal)}</span>
            </div>
            <div className="stat-tile">
              <span className="label">Saved</span>
              <span className="figure figure--small" style={{ color: "var(--teal)" }}>
                {formatCents(savedCents)}
              </span>
            </div>
          </div>
        </div>

        <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="label">Envelope fill · this month</span>
          </div>
          <EnvelopePieChart slices={pieSlices} />
        </div>
      </section>

      {/* What is committed before a dollar of everyday spending — the
          calendar's own figures, summarised, with a way through to it. */}
      <section className="section" style={{ gap: 16 }}>
        <div className="section-header">
          <h2 className="section-title">Bills &amp; income</h2>
          <a href="#" onClick={(e) => (e.preventDefault(), onGoToBillsIncome())}>
            Open the calendar
          </a>
        </div>
        <div className="grid-2" style={{ alignItems: "stretch" }}>
          <div className="card card--padded" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))" }}>
              <div className="stat-tile">
                <span className="label">Income expected</span>
                <span className="figure figure--small money positive">{formatCents(billsAndIncome.incomeTotal)}</span>
                <span className="detail">{formatCents(billsAndIncome.incomeReceived)} received so far.</span>
              </div>
              <div className="stat-tile">
                <span className="label">Bills committed</span>
                <span className="figure figure--small money">{formatCents(billsAndIncome.billsTotal)}</span>
                <span className="detail">{formatCents(billsAndIncome.billsPaid)} paid so far.</span>
              </div>
            </div>
            {billsAndIncome.overdue > 0 && (
              <p className="callout callout--danger" style={{ margin: 0 }}>
                {billsAndIncome.overdue} bill{billsAndIncome.overdue === 1 ? " is" : "s are"} past due.
              </p>
            )}
          </div>

          <div className="card card--padded" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="label">Next up</span>
            {billsAndIncome.upcoming.length === 0 ? (
              <span className="hint">Everything this month has landed.</span>
            ) : (
              <ul className="list">
                {billsAndIncome.upcoming.map((u) => (
                  <li key={`${u.name}-${u.dueDate}`}>
                    <span className="row-figure">
                      <span className="row-title">{u.name}</span>
                      <span className="row-meta">{u.dueDate}</span>
                    </span>
                    <span className={`money ${u.isIncome ? "positive" : ""}`}>
                      {u.amountCents === null ? "—" : `${u.isIncome ? "+" : "−"}${formatCents(u.amountCents)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2 className="section-title">Everyday envelopes</h2>
          <a href="#" onClick={(e) => (e.preventDefault(), onGoToEnvelopes())}>
            Adjust allocations
          </a>
        </div>
        <div className="grid-4" style={{ alignItems: "stretch" }}>
          {envelopeCards.map((e) => {
            const category = categoryById.get(e.category_id);
            const summary = envelopeSummaries[e.id];
            const status = envelopeStatus(e, summary);
            const used = e.monthly_target_cents && summary ? Math.min(100, Math.max(0, ((e.monthly_target_cents - summary.balanceCents) / e.monthly_target_cents) * 100)) : 0;
            return (
              <div className="card card--padded" key={e.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                  <span className="row-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {category?.name ?? "Envelope"}
                  </span>
                  <span className={STATUS_BADGE_CLASS[status]} style={{ flex: "0 0 auto" }}>
                    {status}
                  </span>
                </div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 36, letterSpacing: "-0.5px", color: "var(--ink)" }}>
                  {summary ? formatCents(summary.balanceCents) : "—"}
                </span>
                <div className="progress-track">
                  <div className={`progress-fill ${summary && summary.balanceCents < 0 ? "over" : ""}`} style={{ width: `${used}%` }} />
                </div>
                <span className="row-meta">{e.monthly_target_cents ? `left of ${formatCents(e.monthly_target_cents)}` : ""}</span>
              </div>
            );
          })}
          {envelopeCards.length === 0 && <p className="hint">No everyday envelopes with an amount planned yet.</p>}
        </div>
      </section>

      <section className="grid-2" style={{ gridTemplateColumns: "1.4fr 1fr", alignItems: "start" }}>
        <div className="section">
          <h2 className="section-title">Income &amp; expense summary</h2>
          <div className="grid-3 grid-3--compact">
            <div className="stat-tile">
              <span className="label">Income</span>
              <span className="figure figure--small" style={{ color: "var(--teal)" }}>
                {formatCents(plRows.totalIncomeCents)}
              </span>
            </div>
            <div className="stat-tile">
              <span className="label">Expenses</span>
              <span className="figure figure--small">{formatCents(plRows.totalExpenseCents)}</span>
            </div>
            <div className="stat-tile">
              <span className="label">Net</span>
              <span className="figure figure--small" style={{ color: plRows.netCents < 0 ? "var(--red)" : "var(--teal)" }}>
                {formatCents(plRows.netCents)}
              </span>
            </div>
          </div>
          <div className="row-list">
            {plRows.income.map((r) => (
              <div className="row-item" key={`income-${r.name}`}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{r.name}</span>
                  <span className="row-meta">Income</span>
                </div>
                <span className="money positive" style={{ minWidth: 96, textAlign: "right" }}>
                  {formatCents(r.cents)}
                </span>
              </div>
            ))}
            {plRows.expenses.map((r) => (
              <div className="row-item" key={`expense-${r.name}`}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{r.name}</span>
                  <span className="row-meta">Expense</span>
                </div>
                <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                  {formatCents(r.cents)}
                </span>
              </div>
            ))}
            {plRows.income.length === 0 && plRows.expenses.length === 0 && (
              <div className="row-item">
                <span className="hint">Nothing categorized this month yet.</span>
              </div>
            )}
          </div>
          {transactions.some((t) => !t.category_id && !t.is_transfer) && (
            <button className="secondary" onClick={onGoToTransactions}>
              Review uncategorized transactions
            </button>
          )}
        </div>

        <div className="section" style={{ gap: 20 }}>
          <h2 className="section-title">Goals</h2>
          <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {goals.map((g) => {
              const summary = envelopeSummaries[g.id];
              const have = summary?.balanceCents ?? 0;
              const target = g.monthly_target_cents ?? 0;
              const barPct = target > 0 ? Math.min(100, Math.max(0, (have / target) * 100)) : 0;
              return (
                <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="row-title">{categoryById.get(g.category_id)?.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)" }}>
                      {formatCents(have)} / {formatCents(target)}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${barPct}%` }} />
                  </div>
                  <span className="row-meta">Target date {g.target_date}</span>
                </div>
              );
            })}
            {goals.length === 0 && <span className="hint">No savings goals yet.</span>}
          </div>
        </div>
      </section>
    </>
  );
}
