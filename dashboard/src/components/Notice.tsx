import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";

/**
 * The app's one way of telling a person how an action went.
 *
 * Before this, an error was a red line at the bottom of the page, a
 * success was nothing at all, and one page put good news in the error
 * slot. A notice sits next to the action it is about, is announced to a
 * screen reader, can be dismissed, and a success clears itself.
 */
export type NoticeKind = "error" | "success" | "info";

export interface NoticeState {
  kind: NoticeKind;
  text: string;
}

const SUCCESS_TTL_MS = 4000;

export function Notice({ notice, onDismiss, style }: { notice: NoticeState | null; onDismiss?: () => void; style?: React.CSSProperties }) {
  if (!notice) return null;
  return (
    <div className={`notice notice--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} style={style}>
      <span className="notice-text">{notice.text}</span>
      {onDismiss && (
        <button type="button" className="notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

export interface UseNotice {
  notice: NoticeState | null;
  setNotice: (notice: NoticeState | null) => void;
  clear: () => void;
  showError: (text: string) => void;
  showSuccess: (text: string) => void;
  showInfo: (text: string) => void;
}

export function useNotice(): UseNotice {
  const [notice, setNoticeState] = useState<NoticeState | null>(null);
  const timer = useRef<number | null>(null);

  const setNotice = useCallback((next: NoticeState | null) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setNoticeState(next);
    if (next && next.kind !== "error") {
      timer.current = window.setTimeout(() => setNoticeState(null), SUCCESS_TTL_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return {
    notice,
    setNotice,
    clear: useCallback(() => setNotice(null), [setNotice]),
    showError: useCallback((text: string) => setNotice({ kind: "error", text }), [setNotice]),
    showSuccess: useCallback((text: string) => setNotice({ kind: "success", text }), [setNotice]),
    showInfo: useCallback((text: string) => setNotice({ kind: "info", text }), [setNotice]),
  };
}

export interface RunOptions {
  /** Shown when the work succeeds. Omit for actions whose result is visible on its own (a dialog closing, a row disappearing). */
  success?: string;
  /** Shown when the work throws something that is not an Error. */
  failure?: string;
  /** Which row or control is busy, for pages with many. */
  key?: string;
}

export interface UseAction extends UseNotice {
  /** True while any work runs. */
  busy: boolean;
  /** The `key` of the work that is running, when one was given. */
  busyKey: string | null;
  /** Runs the work, sets busy, and reports the outcome as a notice. Resolves true on success. */
  run: (work: () => Promise<unknown>, options?: RunOptions) => Promise<boolean>;
}

/**
 * Busy state, error reporting and success reporting for one page or
 * dialog, in one hook, so every save in the app behaves the same way: the
 * button is disabled while the request runs, a second click does nothing,
 * a failure is a sentence next to the button, and a success is either
 * visible on its own or said in a line that fades.
 */
export function useAction(): UseAction {
  const notice = useNotice();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { setNotice } = notice;

  const run = useCallback(
    async (work: () => Promise<unknown>, options: RunOptions = {}) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setBusyKey(options.key ?? null);
      setNotice(null);
      try {
        await work();
        if (options.success) setNotice({ kind: "success", text: options.success });
        return true;
      } catch (err) {
        setNotice({ kind: "error", text: errorMessage(err, options.failure) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
        setBusyKey(null);
      }
    },
    [setNotice],
  );

  return { ...notice, busy, busyKey, run };
}
