import { useEffect, useState, type FormEvent } from "react";
import { api, type Asset, type AssetType, type MaintenanceStatus, type MaintenanceTask } from "../api";

interface Props {
  householdId: string;
  assetType: AssetType;
  assets: Asset[];
}

const STATUS_BADGE_CLASS: Record<MaintenanceStatus, string> = {
  scheduled: "badge",
  due_soon: "badge badge--warn",
  overdue: "badge badge--danger",
  done: "badge badge--positive",
};
const STATUS_LABEL: Record<MaintenanceStatus, string> = { scheduled: "scheduled", due_soon: "due soon", overdue: "overdue", done: "done" };

export function MaintenancePage({ householdId, assetType, assets }: Props) {
  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTask, setNewTask] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newAssetId, setNewAssetId] = useState("");

  const assetsOfType = assets.filter((a) => a.type === assetType);

  async function refresh() {
    setTasks(await api.listMaintenanceTasks(householdId, { assetType, includeCompleted: showCompleted }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, assetType, showCompleted]);

  async function addTask(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newAssetId) {
      setError("Pick which asset this task is for");
      return;
    }
    try {
      await api.createMaintenanceTask(householdId, { assetId: newAssetId, task: newTask.trim(), dueDate: newDueDate });
      setNewTask("");
      setNewDueDate("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add task");
    }
  }

  async function toggleComplete(t: MaintenanceTask) {
    setError(null);
    try {
      if (t.status === "done") {
        await api.reopenMaintenanceTask(householdId, t.id);
      } else {
        await api.completeMaintenanceTask(householdId, t.id);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    }
  }

  return (
    <div className="section">
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
        <span>Show completed (maintenance log)</span>
      </label>

      <div className="row-list">
        <div className="row-list-header" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
          <span>Task</span>
          <span>Asset</span>
          <span>Due</span>
          <span>Status</span>
        </div>
        {tasks.map((t) => {
          const asset = assets.find((a) => a.id === t.asset_id);
          return (
            <div className="row-item--grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr", background: "var(--surface)" }} key={t.id}>
              <span className="row-title">{t.task}</span>
              <span className="row-meta">{asset?.name ?? "—"}</span>
              <span className="money">{t.due_date}</span>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className={STATUS_BADGE_CLASS[t.status]}>{STATUS_LABEL[t.status]}</span>
                <button className="secondary" onClick={() => toggleComplete(t)} style={{ padding: "2px 8px", fontSize: 12 }}>
                  {t.status === "done" ? "Reopen" : "Complete"}
                </button>
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && (
          <div className="row-item">
            <span className="hint">Nothing here — add a task below.</span>
          </div>
        )}
      </div>

      <section className="card card--padded" id="page-add-form">
        <h2>Add task</h2>
        <form onSubmit={addTask}>
          <div className="row">
            <input type="text" placeholder="Task" value={newTask} onChange={(e) => setNewTask(e.target.value)} required style={{ flex: 1 }} />
            <select value={newAssetId} onChange={(e) => setNewAssetId(e.target.value)} required>
              <option value="" disabled>
                Which asset?
              </option>
              {assetsOfType.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <input type="date" value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} required />
            <button type="submit">Add</button>
          </div>
        </form>
        {assetsOfType.length === 0 && (
          <p className="hint">Add a {assetType === "property" ? "house" : "car"} on the Assets page first.</p>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
