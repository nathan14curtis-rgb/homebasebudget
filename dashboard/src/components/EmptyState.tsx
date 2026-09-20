import type { ReactNode } from "react";

/**
 * What a list shows when it has nothing in it: a title, a line about what
 * to do, and the button that does it. Every page used to say it
 * differently, from a dashed panel with a call to action to a one-line
 * hint that read like an error.
 */
export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {hint && <p className="hint">{hint}</p>}
      {children && (
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A quieter version for a list inside a card, where the dashed panel
 * would be a box inside a box. */
export function EmptyRow({ text }: { text: string }) {
  return (
    <div className="row-item row-item--empty">
      <span className="hint">{text}</span>
    </div>
  );
}
