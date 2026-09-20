import { useMemo, useState } from "react";
import { api, type Asset, type AssetType } from "../api";
import { formatCents } from "../format";
import { parseMoney, moneyToInput } from "../money";
import { usePageAction } from "../pageAction";
import { VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { MoneyInput } from "./MoneyInput";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  householdId: string;
  assets: Asset[];
  selectedAssetId?: string;
  onChanged: () => Promise<void>;
}

const TYPE_LABEL: Record<AssetType, string> = { property: "Property", vehicle: "Vehicle", appliance: "Appliance", other: "Other" };

/** Add and edit, one dialog. */
function AssetModal({ householdId, asset, onClose, onSaved }: { householdId: string; asset?: Asset; onClose: () => void; onSaved: () => Promise<void> }) {
  const editing = Boolean(asset);
  const [name, setName] = useState(asset?.name ?? "");
  const [type, setType] = useState<AssetType>(asset?.type ?? "property");
  const [value, setValue] = useState(moneyToInput(asset?.value_cents ?? null));
  const [notes, setNotes] = useState(asset?.notes ?? "");
  const action = useAction();

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return action.showError(VALIDATION.name);
    const valueCents = value.trim() ? parseMoney(value) : null;
    if (value.trim() && valueCents === null) return action.showError(VALIDATION.amount);
    const ok = await action.run(async () => {
      if (asset) {
        await api.updateAsset(householdId, asset.id, { name: trimmedName, type, valueCents, notes: notes.trim() || null });
      } else {
        await api.createAsset(householdId, { name: trimmedName, type, valueCents: valueCents ?? undefined, notes: notes.trim() || undefined });
      }
      await onSaved();
    });
    if (ok) onClose();
  }

  return (
    <Modal
      title={editing ? `Edit ${asset!.name}` : "Add asset"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={action.busy}>
            {action.busy ? "Saving…" : editing ? "Save" : "Add asset"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="asset-name">Name</label>
        <input id="asset-name" type="text" data-autofocus="true" placeholder="e.g. The house, or Honda Odyssey" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="asset-type">Type</label>
        <select id="asset-type" value={type} onChange={(e) => setType(e.target.value as AssetType)}>
          {(Object.keys(TYPE_LABEL) as AssetType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="asset-value">Value</label>
        <MoneyInput id="asset-value" value={value} onChange={setValue} disabled={action.busy} placeholder="Optional" />
      </div>
      <div className="field">
        <label htmlFor="asset-notes">Note</label>
        <input id="asset-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Notice notice={action.notice} onDismiss={action.clear} />
    </Modal>
  );
}

export function AssetsPage({ householdId, assets, selectedAssetId, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [removing, setRemoving] = useState<Asset | null>(null);
  const page = useAction();

  usePageAction("Add asset", () => setAdding(true));

  const visible = useMemo(() => (selectedAssetId ? assets.filter((a) => a.id === selectedAssetId) : assets), [assets, selectedAssetId]);

  return (
    <div className="section">
      <Notice notice={page.notice} onDismiss={page.clear} />

      {visible.length > 0 ? (
        <div className="grid-2">
          {visible.map((a) => (
            <div className="card card--padded" key={a.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ fontSize: 18, fontWeight: 500, color: "var(--ink)" }}>{a.name}</span>
                <span className="badge badge--soft badge--muted">{TYPE_LABEL[a.type]}</span>
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
              {a.notes && <span style={{ fontSize: 14, color: "var(--body-text)" }}>{a.notes}</span>}
              <div className="row">
                <button className="secondary" type="button" onClick={() => setEditing(a)}>
                  Edit
                </button>
                <button className="danger" type="button" onClick={() => setRemoving(a)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No assets yet" hint="A house, a car, an appliance — anything with documents and upkeep worth tracking.">
          <button type="button" onClick={() => setAdding(true)}>
            Add asset
          </button>
        </EmptyState>
      )}

      {adding && <AssetModal householdId={householdId} onClose={() => setAdding(false)} onSaved={onChanged} />}
      {editing && <AssetModal householdId={householdId} asset={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body="It leaves the Assets list and the sidebar. Its documents and maintenance history are kept, and it can be restored later."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const asset = removing;
            await api.archiveAsset(householdId, asset.id);
            setRemoving(null);
            await page.run(onChanged, { success: `${asset.name} removed.` });
          }}
        />
      )}
    </div>
  );
}
