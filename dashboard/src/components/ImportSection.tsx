import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { api, type Account, type CsvImportSummary } from "../api";
import { Notice, useAction } from "./Notice";

interface Props {
  householdId: string;
  accounts: Account[];
  onChanged: () => Promise<void>;
}

type MappedField = "date" | "description" | "amount" | "category" | "memo";

const FIELD_LABELS: Record<MappedField, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category (optional)",
  memo: "Memo (optional)",
};

const FIELD_GUESSES: Record<MappedField, string[]> = {
  date: ["date", "transaction date", "posted date"],
  description: ["description", "payee", "name", "merchant"],
  amount: ["amount", "amount ($)", "value"],
  category: ["category"],
  memo: ["notes", "memo", "note"],
};

function guessColumn(headers: string[], field: MappedField): string {
  const candidates = FIELD_GUESSES[field];
  return headers.find((h) => candidates.includes(h.trim().toLowerCase())) ?? "";
}

/** Header-only preview parse — the authoritative parse (quoted fields,
 * embedded commas, etc.) happens server-side in src/import/csvImport.ts
 * once this is submitted. Good enough for picking column names. */
function parseHeaderRow(text: string): string[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
}

const MAPPED_FIELDS: MappedField[] = ["date", "description", "amount", "category", "memo"];

/**
 * CSV import (PLAN.md §12 Phase 0 milestone: "your Simplifi history is
 * queryable in your own database"). Column names are detected from the
 * file's own header row rather than assumed, since the real Simplifi
 * export format is data only the household has.
 */
export function ImportSection({ householdId, accounts, onChanged }: Props) {
  const [accountId, setAccountId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<MappedField, string>>({
    date: "",
    description: "",
    amount: "",
    category: "",
    memo: "",
  });
  const [summary, setSummary] = useState<CsvImportSummary | null>(null);
  const action = useAction();
  const busy = action.busy;

  useEffect(() => {
    setAccountId((prev) => (prev && accounts.some((a) => a.id === prev) ? prev : accounts[0]?.id ?? ""));
  }, [accounts]);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setSummary(null);
    action.clear();
    const text = await file.text();
    setCsvText(text);
    const detected = parseHeaderRow(text);
    setHeaders(detected);
    setMapping({
      date: guessColumn(detected, "date"),
      description: guessColumn(detected, "description"),
      amount: guessColumn(detected, "amount"),
      category: guessColumn(detected, "category"),
      memo: guessColumn(detected, "memo"),
    });
  }

  const canSubmit = useMemo(
    () => Boolean(accountId && csvText && mapping.date && mapping.description && mapping.amount) && !busy,
    [accountId, csvText, mapping, busy],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSummary(null);
    let result: CsvImportSummary | null = null;
    const ok = await action.run(async () => {
      result = await api.importCsv(householdId, {
        accountId,
        csv: csvText,
        columnMapping: {
          date: mapping.date,
          description: mapping.description,
          amount: mapping.amount,
          category: mapping.category || undefined,
          memo: mapping.memo || undefined,
        },
      });
      await onChanged();
    });
    if (ok) setSummary(result);
  }

  return (
    <section className="card">
      <h2>Import history</h2>
      <p className="hint">
        Export your transaction history from Simplifi as a CSV, then import it here — one account at a time. Running
        the same file twice is safe; duplicates are skipped.
      </p>

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="import-account">Account</label>
          <select id="import-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {accounts.length === 0 && <p className="hint">Add or link an account above first.</p>}
        </div>

        <div className="field">
          <label htmlFor="import-file">CSV file</label>
          <input id="import-file" type="file" accept=".csv,text/csv" onChange={onFileChange} />
          {fileName && (
            <p className="hint">
              {fileName} — {headers.length} column{headers.length === 1 ? "" : "s"} detected
            </p>
          )}
        </div>

        {headers.length > 0 && (
          <details open>
            <summary>Column mapping</summary>
            <div className="mapping-grid">
              {MAPPED_FIELDS.map((field) => (
                <div className="field" key={field}>
                  <label htmlFor={`map-${field}`}>{FIELD_LABELS[field]}</label>
                  <select
                    id={`map-${field}`}
                    value={mapping[field]}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                  >
                    <option value="">— none —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </details>
        )}

        <button type="submit" disabled={!canSubmit} style={{ marginTop: "1rem" }}>
          {busy ? "Importing…" : "Import"}
        </button>
      </form>

      <Notice notice={action.notice} onDismiss={action.clear} style={{ marginTop: 12 }} />
      {summary && (
        <Notice
          style={{ marginTop: 12 }}
          notice={{
            kind: "success",
            text: `Imported ${summary.imported} transaction${summary.imported === 1 ? "" : "s"} and skipped ${summary.skippedDuplicates} duplicate${
              summary.skippedDuplicates === 1 ? "" : "s"
            }.${summary.unmatchedCategoryNames.length > 0 ? ` No category matched: ${summary.unmatchedCategoryNames.join(", ")}.` : ""}`,
          }}
          onDismiss={() => setSummary(null)}
        />
      )}
    </section>
  );
}
