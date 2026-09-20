import { useEffect, useState } from "react";
import { api, errorMessage, type Asset, type AssetType, type MaintenanceStatus, type MaintenanceTask } from "../api";
import { usePageAction } from "../pageAction";
import { Modal } from "./ScheduleFields";
import { Notice, useAction } from "./Notice";
import { EmptyState } from "./EmptyState";

interface Props {
  householdId: string;
  assetType: AssetType;
  assets: Asset[];
  onGoToAssets: () => void;
}

const STATUS_BADGE_CLASS: Record<MaintenanceStatus, string> = {
  scheduled: "badge badge--soft",
  due_soon: "badge badge--soft badge--warn",
  overdue: "badge badge--soft badge--danger",
  done: "badge badge--soft badge--positive",
};
const STATUS_LABEL: Record<MaintenanceStatus, string> = { scheduled: "Scheduled", due_soon: "Due soon", overdue: "Overdue", done: "Done" };

/** Add and edit, one dialog. */
function TaskModal({
  householdId,
  assetsOfType,
  task,
  onClose,
  onSaved,
}: {
  householdId: string;
  assetsOfType: Asset[];
  task?: MaintenanceTask;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = Boolean(task);
  const [text, setText] = useState(task?.task ?? "");
  const [assetId, setAssetId] = useState(task?.asset_id ?? assetsOfType[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(task?.due_date ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const action = useAction();

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return action.showError("Say what needs doing.");
    if (!assetId) return action.showError("Pick which asset this is for.");
    if (!dueDate) return action.showError("Pick a due date.");
    const ok = await action.run(async () => {
      if (task) {
        await api.updateMaintenanceTask(householdId, task.id, { task: trimmed, dueDate, notes: notes.trim() || null });
      } else {
        await api.createMaintenanceTask(householdId, { assetId, task: trimmed, dueDate, notes: notes.trim() || undefined });
      }
      await onSaved();
    });
    if (ok) onClose();
  }

  return (
    <Modal
      title={editing ? "Edit task" : "Add task"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={action.busy}>
            {action.busy ? "Saving…" : editing ? "Save" : "Add task"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="task-text">Task</label>
        <input id="task-text" type="text" data-autofocus="true" placeholder="e.g. Replace furnace filter" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="task-asset">For</label>
          <select id="task-asset" value={assetId} disabled={editing} onChange={(e) => setAssetId(e.target.value)}>
            {!assetId && (
              <option value="" disabled>
                Choose…
              </option>
            )}
            {assetsOfType.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="task-due">Due</label>
          <input id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="task-notes">Note</label>
        <input id="task-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Notice notice={action.notice} onDismiss={action.clear} />
    </Modal>
  );
}

export function MaintenancePage({ householdId, assetType, assets, onGoToAssets }: Props) {
  const [tasks, setTasks] = useState<MaintenanceTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MaintenanceTask | null>(null);
  const page = useAction();

  const assetsOfType = assets.filter((a) => a.type === assetType);
  const noun = assetType === "property" ? "house" : "car";

  usePageAction("Add task", () => setAdding(true));

  async function refresh() {
    try {
      setTasks(await api.listMaintenanceTasks(householdId, { assetType, includeCompleted: showCompleted }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load these tasks."));
    }
  }

  useEffect(() => {
    setTasks(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, assetType, showCompleted]);

  function toggleComplete(t: MaintenanceTask) {
    void page.run(
      async () => {
        if (t.status === "done") await api.reopenMaintenanceTask(householdId, t.id);
        else await api.completeMaintenanceTask(householdId, t.id);
        await refresh();
      },
      { key: t.id, success: t.status === "done" ? `${t.task} reopened.` : `${t.task} marked done.` },
    );
  }

  return (
    <div className="section">
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
        <span>Show completed tasks</span>
      </label>

      <Notice notice={page.notice} onDismiss={page.clear} />
      {loadError && <Notice notice={{ kind: "error", text: loadError }} />}

      {tasks === null && !loadError ? (
        <p className="hint">Loading…</p>
      ) : tasks && tasks.length > 0 ? (
        <div className="row-list">
          <div className="row-list-header" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
            <span>Task</span>
            <span>For</span>
            <span>Due</span>
            <span>Status</span>
          </div>
          {tasks.map((t) => {
            const asset = assets.find((a) => a.id === t.asset_id);
            const busy = page.busyKey === t.id;
            return (
              <div className="row-item--grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr", background: "var(--surface)" }} key={t.id}>
                <span className="row-figure">
                  <span className="row-title">{t.task}</span>
                  {t.notes && <span className="row-meta">{t.notes}</span>}
                </span>
                <span className="row-meta">{asset?.name ?? "—"}</span>
                <span className="money">{t.due_date}</span>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className={STATUS_BADGE_CLASS[t.status]}>{STATUS_LABEL[t.status]}</span>
                  <span className="row" style={{ gap: 4 }}>
                    {t.status !== "done" && (
                      <button className="secondary" type="button" onClick={() => setEditing(t)} style={{ padding: "2px 8px", fontSize: 12 }}>
                        Edit
                      </button>
                    )}
                    <button className="secondary" type="button" disabled={busy} onClick={() => toggleComplete(t)} style={{ padding: "2px 8px", fontSize: 12 }}>
                      {busy ? "Working…" : t.status === "done" ? "Reopen" : "Mark done"}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : tasks ? (
        assetsOfType.length === 0 ? (
          <EmptyState title={`No ${noun} to look after yet`} hint={`Add a ${noun} on the Assets page first, then its tasks go here.`}>
            <button type="button" onClick={onGoToAssets}>
              Go to Assets
            </button>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing scheduled" hint={showCompleted ? "No tasks, done or open." : "Add the next thing this needs, with a date, and it shows up here."}>
            <button type="button" onClick={() => setAdding(true)}>
              Add task
            </button>
          </EmptyState>
        )
      ) : null}

      {adding && <TaskModal householdId={householdId} assetsOfType={assetsOfType} onClose={() => setAdding(false)} onSaved={refresh} />}
      {editing && <TaskModal householdId={householdId} assetsOfType={assetsOfType} task={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}
