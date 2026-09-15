import { useState } from "react";
import { Modal } from "./ScheduleFields";

/**
 * The app's "are you sure?".
 *
 * It replaces window.confirm(), which cannot say what is about to happen
 * in more than one unstyled line, cannot show progress while the work
 * runs, and is suppressed outright by some browsers — a suppressed
 * confirm() returns false, so the action silently does nothing and the
 * person is left thinking they clicked wrong.
 *
 * `onConfirm` is awaited and its failure is shown here rather than
 * dismissing the dialog on an error the person never sees.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onCancel}
      width={420}
      footer={
        <>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={danger ? "danger" : undefined} data-autofocus="true" onClick={confirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>{body}</p>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
