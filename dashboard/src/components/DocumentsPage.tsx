import { useEffect, useState, type FormEvent } from "react";
import { api, type Asset, type Document, type DocumentCategory, type User } from "../api";

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

export function DocumentsPage({ householdId, category, users, assets }: Props) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDetail, setNewDetail] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newAssetId, setNewAssetId] = useState("");

  async function refresh() {
    setDocuments(await api.listDocuments(householdId, { category }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, category]);

  async function addDocument(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createDocument(householdId, {
        name: newName.trim(),
        category,
        assetId: newAssetId || undefined,
        ownerUserId: newOwnerId || undefined,
        detail: newDetail.trim() || undefined,
      });
      setNewName("");
      setNewDetail("");
      setNewOwnerId("");
      setNewAssetId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add document");
    }
  }

  async function archive(id: string) {
    setError(null);
    try {
      await api.archiveDocument(householdId, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove document");
    }
  }

  return (
    <div className="section">
      <div className="row-list">
        <div className="row-list-header" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
          <span>Document</span>
          <span>Category</span>
          <span>Detail</span>
          <span>Owner</span>
        </div>
        {documents.map((d) => (
          <div className="row-item--grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr", background: "var(--surface)" }} key={d.id}>
            <span className="row-title">{d.name}</span>
            <span className="badge">{CATEGORY_LABEL[d.category]}</span>
            <span className="row-meta">{d.detail ?? "—"}</span>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="row-meta">{d.owner_user_id ? (users.find((u) => u.id === d.owner_user_id)?.name ?? "—") : "Shared"}</span>
              <button className="danger" onClick={() => archive(d.id)} style={{ padding: "2px 8px", fontSize: 12 }}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {documents.length === 0 && (
          <div className="row-item">
            <span className="hint">No {CATEGORY_LABEL[category].toLowerCase()} documents yet — add one below.</span>
          </div>
        )}
      </div>

      <section className="card card--padded" id="page-add-form">
        <h2>Add document</h2>
        <form onSubmit={addDocument}>
          <div className="row">
            <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
            <input type="text" placeholder="Detail (e.g. Renews Jan 2027)" value={newDetail} onChange={(e) => setNewDetail(e.target.value)} style={{ flex: 1 }} />
          </div>
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <select value={newAssetId} onChange={(e) => setNewAssetId(e.target.value)}>
              <option value="">No linked asset</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)}>
              <option value="">Shared</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <button type="submit">Add</button>
          </div>
        </form>
        <p className="hint">Stores the document's details — file upload isn't wired up yet.</p>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
