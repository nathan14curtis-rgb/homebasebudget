import { useMemo, useState } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary } from "../api";
import { formatCents } from "../format";
import { parseMoney } from "../money";
import { usePageAction } from "../pageAction";
import { VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { MoneyInput } from "./MoneyInput";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";
import { EditEnvelopeModal } from "./EnvelopesPage";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  onChanged: () => Promise<void>;
}

function etaLabel(targetDate: string): string {
  const months = Math.max(0, Math.round((Date.parse(targetDate) - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)));
  if (months <= 0) return `Target date ${targetDate} — due now`;
  if (months === 1) return "1 month to go";
  return `${months} months to go`;
}

/** "New goal" — a savings envelope with a date, created through the same
 * kind of dialog every other "add" in the app uses. */
function NewGoalModal({ householdId, onClose, onSaved }: { householdId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [date, setDate] = useState("");
  const action = useAction();

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return action.showError(VALIDATION.name);
    const targetCents = target.trim() ? parseMoney(target) : null;
    if (target.trim() && targetCents === null) return action.showError(VALIDATION.amount);
    if (!date) return action.showError("Pick the date you want to reach it by.");
    const ok = await action.run(async () => {
      await api.createCategory(householdId, {
        name: trimmedName,
        kind: "savings",
        groupName: "Goals",
        monthlyTargetCents: targetCents ?? undefined,
        targetDate: date,
      });
      await onSaved();
    });
    if (ok) onClose();
  }

  return (
    <Modal
      title="New goal"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={action.busy}>
            {action.busy ? "Adding…" : "Add goal"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="goal-name">Name</label>
        <input id="goal-name" type="text" data-autofocus="true" placeholder="e.g. New roof" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="goal-target">Total needed</label>
        <MoneyInput id="goal-target" value={target} onChange={setTarget} disabled={action.busy} />
        <p className="hint">What this goal needs in total. The Spending Plan works out this month's share from the date below.</p>
      </div>
      <div className="field">
        <label htmlFor="goal-date">Reach it by</label>
        <input id="goal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Notice notice={action.notice} onDismiss={action.clear} />
    </Modal>
  );
}

export function GoalsPage({ householdId, categories, envelopes, envelopeSummaries, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Envelope | null>(null);

  usePageAction("New goal", () => setAdding(true));

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // A savings goal is not a separate concept — it's a kind='savings'
  // envelope with a target_date set (PLAN.md §8.5).
  const goals = useMemo(
    () => envelopes.filter((e) => !e.archived_at && categoryById.get(e.category_id)?.kind === "savings" && e.target_date),
    [envelopes, categoryById],
  );

  return (
    <div className="section">
      {goals.length > 0 ? (
        <div className="grid-3">
          {goals.map((g) => {
            const category = categoryById.get(g.category_id);
            const summary = envelopeSummaries[g.id];
            const have = summary?.balanceCents ?? 0;
            const target = g.monthly_target_cents ?? 0;
            const barPct = target > 0 ? Math.min(100, Math.max(0, (have / target) * 100)) : 0;
            return (
              <div key={g.id} className="card card--padded" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>{category?.name}</span>
                  <button type="button" className="secondary" onClick={() => setEditing(g)}>
                    Edit
                  </button>
                </div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 48, lineHeight: 1.1, letterSpacing: "-1px", color: "var(--ink)" }}>
                  {formatCents(have)}
                </span>
                <div className="progress-track" style={{ height: 8 }} role="img" aria-label={`${Math.round(barPct)}% saved`}>
                  <div className="progress-fill" style={{ width: `${barPct}%` }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)" }}>
                  {target > 0 ? `of ${formatCents(target)} needed` : "no total set yet"}
                </span>
                <span style={{ fontSize: 14, color: "var(--body-text)" }}>{g.target_date ? etaLabel(g.target_date) : ""}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title="Nothing you're saving toward yet" hint="A goal is money set aside a little each month until a date you pick.">
          <button type="button" onClick={() => setAdding(true)}>
            New goal
          </button>
        </EmptyState>
      )}

      {adding && <NewGoalModal householdId={householdId} onClose={() => setAdding(false)} onSaved={onChanged} />}
      {editing && (
        <EditEnvelopeModal
          householdId={householdId}
          envelope={editing}
          category={categoryById.get(editing.category_id)}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
