import { useEffect, useState } from "react";
import { api, errorMessage, type Asset, type Document, type DocumentCategory, type User } from "../api";
import { usePageAction } from "../pageAction";
import { VALIDATION } from "../copy";
import { Modal } from "./ScheduleFields";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  householdId: string;
  category: DocumentCategory;
  users: User[];
  assets: Asset[];
}

const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  insurance: "Insurance",
  warranty: "Warranty",
  identification: "Identification",
  passwords: "Passwords",
};

/** Add and edit, one dialog. */
function DocumentModal({
  householdId,
  category,
  users,
  assets,
  document,
  onClose,
  onSaved,
}: {
  householdId: string;
  category: DocumentCategory;
  users: User[];
  assets: Asset[];
  document?: Document;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = Boolean(document);
  const [name, setName] = useState(document?.name ?? "");
  const [detail, setDetail] = useState(document?.detail ?? "");
  const [ownerId, setOwnerId] = useState(document?.owner_user_id ?? "");
  const [assetId, setAssetId] = useState(document?.asset_id ?? "");
  const action = useAction();

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return action.showError(VALIDATION.name);
    const ok = await action.run(async () => {
      if (document) {
        await api.updateDocument(householdId, document.id, {
          name: trimmedName,
          detail: detail.trim() || null,
          ownerUserId: ownerId || null,
          assetId: assetId || null,
        });
      } else {
        await api.createDocument(householdId, {
          name: trimmedName,
          category,
          assetId: assetId || undefined,
          ownerUserId: ownerId || undefined,
          detail: detail.trim() || undefined,
        });
      }
      await onSaved();
    });
    if (ok) onClose();
  }

  return (
    <Modal
      title={editing ? `Edit ${document!.name}` : `Add ${CATEGORY_LABEL[category].toLowerCase()} document`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={action.busy}>
            {action.busy ? "Saving…" : editing ? "Save" : "Add document"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="doc-name">Name</label>
        <input id="doc-name" type="text" data-autofocus="true" placeholder="e.g. Home insurance policy" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="doc-detail">Detail</label>
        <input id="doc-detail" type="text" placeholder="e.g. Renews Jan 2027, policy #12345" value={detail} onChange={(e) => setDetail(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="doc-asset">Linked asset</label>
          <select id="doc-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">None</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="doc-owner">Belongs to</label>
          <select id="doc-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">The household</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="hint">This keeps the document's details. Uploading the file itself isn't available yet.</p>
      <Notice notice={action.notice} onDismiss={action.clear} />
    </Modal>
  );
}

export function DocumentsPage({ householdId, category, users, assets }: Props) {
  const [documents, setDocuments] = useState<Document[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [removing, setRemoving] = useState<Document | null>(null);
  const page = useAction();

  usePageAction("Add document", () => setAdding(true));

  async function refresh() {
    try {
      setDocuments(await api.listDocuments(householdId, { category }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load these documents."));
    }
  }

  useEffect(() => {
    setDocuments(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, category]);

  const label = CATEGORY_LABEL[category].toLowerCase();

  return (
    <div className="section">
      <Notice notice={page.notice} onDismiss={page.clear} />
      {loadError && <Notice notice={{ kind: "error", text: loadError }} />}

      {documents === null && !loadError ? (
        <p className="hint">Loading…</p>
      ) : documents && documents.length > 0 ? (
        <div className="row-list">
          <div className="row-list-header" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
            <span>Document</span>
            <span>Category</span>
            <span>Detail</span>
            <span>Belongs to</span>
          </div>
          {documents.map((d) => (
            <div className="row-item--grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr", background: "var(--surface)" }} key={d.id}>
              <span className="row-title">{d.name}</span>
              <span className="badge badge--soft badge--muted">{CATEGORY_LABEL[d.category]}</span>
              <span className="row-meta">{d.detail ?? "—"}</span>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="row-meta">{d.owner_user_id ? (users.find((u) => u.id === d.owner_user_id)?.name ?? "—") : "Household"}</span>
                <span className="row" style={{ gap: 4 }}>
                  <button className="secondary" type="button" onClick={() => setEditing(d)} style={{ padding: "2px 8px", fontSize: 12 }}>
                    Edit
                  </button>
                  <button className="danger" type="button" onClick={() => setRemoving(d)} style={{ padding: "2px 8px", fontSize: 12 }}>
                    Remove
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : documents ? (
        <EmptyState title={`No ${label} documents yet`} hint="Keep the details of each one here so the whole household can find them.">
          <button type="button" onClick={() => setAdding(true)}>
            Add document
          </button>
        </EmptyState>
      ) : null}

      {adding && <DocumentModal householdId={householdId} category={category} users={users} assets={assets} onClose={() => setAdding(false)} onSaved={refresh} />}
      {editing && (
        <DocumentModal householdId={householdId} category={category} users={users} assets={assets} document={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body="It leaves this list. Nothing else changes."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const doc = removing;
            await api.archiveDocument(householdId, doc.id);
            setRemoving(null);
            await page.run(refresh, { success: `${doc.name} removed.` });
          }}
        />
      )}
    </div>
  );
}
