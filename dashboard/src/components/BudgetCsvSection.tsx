import { useState, type ChangeEvent } from "react";
import { api, type BudgetPlanRow, type BudgetPlanSummary } from "../api";

interface Props {
  householdId: string;
  onChanged: () => Promise<void>;
}

const ACTION_LABEL: Record<BudgetPlanRow["action"], string> = {
  create: "Add",
  update: "Change",
  archive: "Archive",
  unchanged: "No change",
  error: "Problem",
};

function planCount(plan: BudgetPlanSummary): number {
  return plan.creates + plan.updates + plan.archives;
}

/**
 * Bulk-edit the whole budget in a spreadsheet: download the plan as it
 * stands, change the cells, upload it back. The upload is previewed row
 * by row before anything is written, and a file with a broken row is
 * never applied (src/budget/csv.ts has the column reference).
 */
export function BudgetCsvSection({ householdId, onChanged }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [plan, setPlan] = useState<BudgetPlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const csv = await api.downloadBudgetCsv(householdId);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `budget-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't download the budget");
    } finally {
      setDownloading(false);
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPlan(null);
    setError(null);
    setBusy(true);
    try {
      const text = await file.text();
      setCsvText(text);
      setPlan(await api.previewBudgetCsv(householdId, text));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!csvText || !plan || plan.errors > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyBudgetCsv(householdId, csvText);
      setPlan(result);
      if (result.applied) {
        await onChanged();
        setCsvText("");
        setInputKey((k) => k + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply the file");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPlan(null);
    setCsvText("");
    setFileName("");
    setError(null);
    setInputKey((k) => k + 1);
  }

  const visibleRows = plan?.rows.filter((r) => showUnchanged || r.action !== "unchanged") ?? [];
  const unchangedCount = plan?.rows.filter((r) => r.action === "unchanged").length ?? 0;

  return (
    <section className="card card--padded">
      <div className="section-head">
        <div>
          <h2>Edit the whole budget in a spreadsheet</h2>
          <p className="hint">
            Download the plan as a CSV, change the cells in Excel, Numbers or Sheets, and upload it back. One row per envelope, goal, bill
            or paycheck. Rows are matched by <strong>type</strong> and <strong>name</strong>: a changed row updates, a new row creates, and
            <code> archive </code> in the action column retires one. You see every change before it is applied.
          </p>
        </div>
        <button type="button" className="secondary" onClick={download} disabled={downloading}>
          {downloading ? "Preparing…" : "Download current budget"}
        </button>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>Columns</summary>
        <table style={{ marginTop: 8, borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>type</code></td>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>envelope</code>, <code>goal</code>, <code>bill</code> or <code>income</code></td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>name</code></td>
              <td>The category's name. Not case-sensitive.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>amount</code></td>
              <td>Dollars. Envelope: each month. Goal: total needed. Bill or income: the expected amount. Blank keeps the current value; <code>none</code> clears it.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>group</code></td>
              <td>Envelopes and goals: the heading they are listed under.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>frequency</code>, <code>day</code>, <code>day2</code></td>
              <td>Bills and income: <code>monthly</code>, <code>twice-monthly</code> or <code>weekly</code>; the day of the month (or weekday name for weekly); the second day for twice-monthly.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>merchant</code></td>
              <td>Bills and income: text a statement line must contain to be matched automatically. Blank on a new row uses the name.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>goal_date</code></td>
              <td>Goals: the date to hit, as YYYY-MM-DD.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>rollover</code></td>
              <td>Envelopes: <code>carry</code> leftovers into next month, or <code>reset</code> to zero.</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 12px 4px 0", verticalAlign: "top", whiteSpace: "nowrap" }}><code>action</code></td>
              <td>Blank to add or update. <code>archive</code> retires an envelope or goal, or ends a bill or paycheck.</td>
            </tr>
          </tbody>
        </table>
      </details>

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="budget-csv-file">Upload an edited budget</label>
        <input key={inputKey} id="budget-csv-file" type="file" accept=".csv,text/csv" onChange={onFileChange} disabled={busy} />
        {fileName && plan && (
          <p className="hint">
            {fileName}: {plan.rows.length} row{plan.rows.length === 1 ? "" : "s"} read.
          </p>
        )}
      </div>

      {busy && !plan && <p className="hint">Reading…</p>}
      {error && <p className="error">{error}</p>}

      {plan && (
        <div className="section" style={{ gap: 12 }}>
          {plan.applied ? (
            <p className="callout" style={{ margin: 0 }}>
              Applied: {plan.creates} added, {plan.updates} changed, {plan.archives} archived.
            </p>
          ) : plan.errors > 0 ? (
            <p className="error" style={{ margin: 0 }}>
              {plan.errors} row{plan.errors === 1 ? " has" : "s have"} a problem. Nothing has been changed — fix the rows marked below and upload
              again.
            </p>
          ) : planCount(plan) === 0 ? (
            <p className="hint" style={{ margin: 0 }}>Everything in the file already matches the plan. Nothing to apply.</p>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              Ready to apply: {plan.creates} to add, {plan.updates} to change, {plan.archives} to archive.
            </p>
          )}

          {visibleRows.length > 0 && (
            <div className="row-list">
              {visibleRows.map((row) => (
                <div className="row-item" key={`${row.line}-${row.name}`} style={{ alignItems: "flex-start" }}>
                  <span className="row-meta" style={{ width: 56, flex: "0 0 auto" }}>
                    line {row.line}
                  </span>
                  <span
                    className={`badge badge--soft ${row.action === "error" ? "badge--danger" : row.action === "unchanged" ? "badge--muted" : "badge--positive"}`}
                    style={{ flex: "0 0 auto", minWidth: 72, textAlign: "center" }}
                  >
                    {ACTION_LABEL[row.action]}
                  </span>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">
                      {row.name || "(no name)"} {row.type && <span className="badge badge--muted">{row.type}</span>}
                    </span>
                    <span className="row-meta">{row.error ?? (row.changes.length ? row.changes.join(" · ") : "matches the plan already")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {unchangedCount > 0 && !plan.applied && (
            <button type="button" className="link-button" style={{ alignSelf: "flex-start" }} onClick={() => setShowUnchanged((v) => !v)}>
              {showUnchanged ? "Hide" : "Show"} {unchangedCount} unchanged row{unchangedCount === 1 ? "" : "s"}
            </button>
          )}

          {!plan.applied && (
            <div className="row">
              <button type="button" onClick={apply} disabled={busy || plan.errors > 0 || planCount(plan) === 0}>
                {busy ? "Applying…" : `Apply ${planCount(plan)} change${planCount(plan) === 1 ? "" : "s"}`}
              </button>
              <button type="button" className="secondary" onClick={reset} disabled={busy}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
