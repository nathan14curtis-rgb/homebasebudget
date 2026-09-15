import { createContext, useContext, useEffect, useRef } from "react";

export interface PageAction {
  label: string;
  run: () => void;
}

/**
 * How a page tells the header what its one action does.
 *
 * The page header's button used to be mockup copy with nothing behind it
 * ("Close the month", "Export report") — a button that does nothing when
 * clicked teaches people not to trust any of them. Now a page registers
 * the real action while it is mounted, and App renders the button only
 * when there is one.
 */
export const PageActionContext = createContext<(action: PageAction | null) => void>(() => {});

export function usePageAction(label: string, run: () => void): void {
  const setAction = useContext(PageActionContext);
  // The handler is almost always an inline closure, so a new identity every
  // render. Held in a ref so re-registering depends only on the label.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    setAction({ label, run: () => runRef.current() });
    return () => setAction(null);
  }, [setAction, label]);
}
