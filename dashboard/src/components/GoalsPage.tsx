import { useMemo, useState, type FormEvent } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary } from "../api";
import { formatCents } from "../format";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  onChanged: () => Promise<void>;
}

const TAGS = ["Priority", "Near term", "Long game"];

function etaLabel(targetDate: string): string {
  const months = Math.max(
    0,
    Math.round((Date.parse(targetDate) - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)),
  );
  if (months <= 0) return `Target date ${targetDate} — due now`;
  if (months === 1) return "1 month to go";
  return `${months} months to go`;
}

export function GoalsPage({ householdId, categories, envelopes, envelopeSummaries, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [newDate, setNewDate] = useState("");

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // A savings goal is not a separate concept — it's a kind='savings'
  // envelope with a target_date set (PLAN.md §8.5).
  const goals = useMemo(
    () => envelopes.filter((e) => !e.archived_at && categoryById.get(e.category_id)?.kind === "savings" && e.target_date),
    [envelopes, categoryById],
  );

  async function addGoal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createCategory(householdId, {
        name: newName.trim(),
        kind: "savings",
        groupName: "Goals",
        monthlyTargetCents: newTarget.trim() ? Math.round(Number(newTarget) * 100) : undefined,
        targetDate: newDate || undefined,
      });
      setNewName("");
      setNewTarget("");
      setNewDate("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add goal");
    }
  }

  return (
    <div className="section">
      <div className="grid-3">
        {goals.map((g, i) => {
          const category = categoryById.get(g.category_id);
          const summary = envelopeSummaries[g.id];
          const have = summary?.balanceCents ?? 0;
          const target = g.monthly_target_cents ?? 0;
          const barPct = target > 0 ? Math.min(100, Math.max(0, (have / target) * 100)) : 0;
          const dark = i === 1;
          return (
            <div key={g.id} className={`card ${dark ? "card--emphasis" : ""} card--padded`} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--muted)" }}>
                {TAGS[i % TAGS.length]}
              </span>
              <span style={{ fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>{category?.name}</span>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 48, lineHeight: 1.1, letterSpacing: "-1px", color: "var(--ink)" }}>
                {formatCents(have)}
              </span>
              <div className="progress-track" style={{ height: 8 }}>
                <div className="progress-fill" style={{ width: `${barPct}%` }} />
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)" }}>of {formatCents(target)} target</span>
              <span style={{ fontSize: 14, color: "var(--body-text)" }}>{g.target_date ? etaLabel(g.target_date) : ""}</span>
            </div>
          );
        })}
        {goals.length === 0 && <p className="hint">No savings goals yet — add one below.</p>}
      </div>

      <section className="card card--padded" id="page-add-form">
        <h2>New goal</h2>
        <form onSubmit={addGoal}>
          <div className="row">
            <input type="text" placeholder="Name (e.g. New roof)" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Target $"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              style={{ width: 140 }}
            />
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
            <button type="submit">Add</button>
          </div>
        </form>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
