import { useMemo, useState, type FormEvent } from "react";
import { api, type Asset, type AssetType } from "../api";
import { formatCents } from "../format";

interface Props {
  householdId: string;
  assets: Asset[];
  selectedAssetId?: string;
  onChanged: () => Promise<void>;
}

const TYPE_LABEL: Record<AssetType, string> = { property: "Property", vehicle: "Vehicle", appliance: "Appliance", other: "Other" };

interface EditDraft {
  valueCents: string;
  notes: string;
}

export function AssetsPage({ householdId, assets, selectedAssetId, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, EditDraft>>({});
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AssetType>("property");
  const [newValue, setNewValue] = useState("");

  const visible = useMemo(() => (selectedAssetId ? assets.filter((a) => a.id === selectedAssetId) : assets), [assets, selectedAssetId]);

  function startEdit(a: Asset) {
    setEditing((prev) => ({ ...prev, [a.id]: { valueCents: a.value_cents ? (a.value_cents / 100).toString() : "", notes: a.notes ?? "" } }));
  }

  async function saveEdit(assetId: string) {
    const draft = editing[assetId];
    if (!draft) return;
    setError(null);
    try {
      await api.updateAsset(householdId, assetId, {
        valueCents: draft.valueCents.trim() ? Math.round(Number(draft.valueCents) * 100) : null,
        notes: draft.notes.trim() || null,
      });
      setEditing((prev) => {
        const { [assetId]: _, ...rest } = prev;
        return rest;
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update asset");
    }
  }

  async function addAsset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createAsset(householdId, {
        name: newName.trim(),
        type: newType,
        valueCents: newValue.trim() ? Math.round(Number(newValue) * 100) : undefined,
      });
      setNewName("");
      setNewValue("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add asset");
    }
  }

  async function remove(assetId: string) {
    setError(null);
    try {
      await api.archiveAsset(householdId, assetId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove asset");
    }
  }

  return (
    <div className="section">
      <div className="grid-2">
        {visible.map((a) => {
          const draft = editing[a.id];
          return (
            <div className="card card--padded" key={a.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>{a.name}</span>
                <span className="badge">{TYPE_LABEL[a.type]}</span>
              </div>
              <div className="row" style={{ gap: 32, borderTop: "1px solid var(--divider)", paddingTop: 20 }}>
                <div className="stat-tile">
                  <span className="label">Value</span>
                  <span className="figure figure--small">{a.value_cents !== null ? formatCents(a.value_cents) : "—"}</span>
                </div>
                <div className="stat-tile">
                  <span className="label">Documents</span>
                  <span className="figure figure--small">{a.documentCount}</span>
                </div>
                <div className="stat-tile">
                  <span className="label">Open tasks</span>
                  <span className="figure figure--small" style={{ color: a.openTaskCount > 0 ? "var(--accent)" : "var(--ink)" }}>
                    {a.openTaskCount}
                  </span>
                </div>
              </div>
              {a.notes && !draft && <span style={{ fontSize: 14, color: "var(--body-text)" }}>{a.notes}</span>}
              {draft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="row">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Value $"
                      value={draft.valueCents}
                      onChange={(e) => setEditing((p) => ({ ...p, [a.id]: { ...draft, valueCents: e.target.value } }))}
                      style={{ width: 140 }}
                    />
                    <input
                      type="text"
                      placeholder="Note"
                      value={draft.notes}
                      onChange={(e) => setEditing((p) => ({ ...p, [a.id]: { ...draft, notes: e.target.value } }))}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <button className="secondary" onClick={() => saveEdit(a.id)} style={{ alignSelf: "flex-start" }}>
                    Save
                  </button>
                </div>
              ) : (
                <div className="row">
                  <button className="secondary" onClick={() => startEdit(a)}>
                    Edit asset
                  </button>
                  <button className="danger" onClick={() => remove(a.id)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <p className="hint">No assets yet — add one below.</p>}
      </div>

      {!selectedAssetId && (
        <section className="card card--padded" id="page-add-form">
          <h2>Add asset</h2>
          <form onSubmit={addAsset}>
            <div className="row">
              <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
              <select value={newType} onChange={(e) => setNewType(e.target.value as AssetType)}>
                <option value="property">Property</option>
                <option value="vehicle">Vehicle</option>
                <option value="appliance">Appliance</option>
                <option value="other">Other</option>
              </select>
              <input type="text" inputMode="decimal" placeholder="Value $ (optional)" value={newValue} onChange={(e) => setNewValue(e.target.value)} style={{ width: 180 }} />
              <button type="submit">Add</button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
