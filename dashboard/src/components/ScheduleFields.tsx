import { useEffect, useRef, type ReactNode } from "react";
import { ApiError, type RecurringPattern, type RecurringPatternFrequency } from "../api";

/**
 * The vocabulary of a recurring schedule, in one place.
 *
 * Both the Bills & Income calendar (which creates and edits series) and
 * the Spending Plan (which no longer does, but still describes them) need
 * the same three frequency shapes, the same validation, and the same
 * words for them — so they are defined here rather than duplicated per
 * page.
 */

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function daySuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
}

export function scheduleLabel(p: Pick<RecurringPattern, "frequency" | "day_of_month" | "day_of_month_2" | "day_of_week">): string {
  if (p.frequency === "weekly") return p.day_of_week !== null ? `Every ${WEEKDAY_NAMES[p.day_of_week]}` : "Weekly";
  if (p.frequency === "semimonthly" && p.day_of_month_2 !== null) {
    return `Twice a month, on the ${p.day_of_month}${daySuffix(p.day_of_month)} and the ${p.day_of_month_2}${daySuffix(p.day_of_month_2)}`;
  }
  return `Monthly on the ${p.day_of_month}${daySuffix(p.day_of_month)}`;
}

/** A write that touches recurring_pattern's frequency/day_of_month_2/
 * day_of_week columns 500s on a deployment where migrations/0008 hasn't
 * been applied yet (`npx wrangler d1 migrations apply curtisclan --remote`)
 * — surfaced as a specific, actionable message instead of a bare "Failed
 * to save". */
export function describeRecurringPatternError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 500) {
    return "The database migration for recurring schedules hasn't been applied on this deployment yet. Run `npx wrangler d1 migrations apply curtisclan --remote`.";
  }
  return err instanceof Error ? err.message : fallback;
}

export interface ScheduleState {
  frequency: RecurringPatternFrequency;
  dayOfMonth: string;
  dayOfMonth2: string;
  dayOfWeek: string; // "0".."6"
}

export function defaultSchedule(dayOfMonth?: string): ScheduleState {
  return { frequency: "monthly", dayOfMonth: dayOfMonth ?? "", dayOfMonth2: "", dayOfWeek: "" };
}

/** The schedule a date implies: monthly on that day, with the weekday
 * pre-filled too so switching the frequency to weekly keeps the day the
 * person actually clicked. */
export function scheduleFromDate(isoDate: string): ScheduleState {
  return {
    frequency: "monthly",
    dayOfMonth: String(Number(isoDate.slice(8, 10))),
    dayOfMonth2: "",
    dayOfWeek: String(new Date(`${isoDate}T00:00:00`).getDay()),
  };
}

export function scheduleFromPattern(p: RecurringPattern): ScheduleState {
  return {
    frequency: p.frequency,
    dayOfMonth: String(p.day_of_month),
    dayOfMonth2: p.day_of_month_2 !== null ? String(p.day_of_month_2) : "",
    dayOfWeek: p.day_of_week !== null ? String(p.day_of_week) : "",
  };
}

export function scheduleIsValid(s: ScheduleState): boolean {
  if (s.frequency === "weekly") return s.dayOfWeek !== "";
  const day = Number(s.dayOfMonth);
  if (!s.dayOfMonth.trim() || !Number.isInteger(day) || day < 1 || day > 31) return false;
  if (s.frequency !== "semimonthly") return true;
  const day2 = Number(s.dayOfMonth2);
  return s.dayOfMonth2.trim() !== "" && Number.isInteger(day2) && day2 >= 1 && day2 <= 31;
}

export function scheduleToApiInput(s: ScheduleState): {
  frequency: RecurringPatternFrequency;
  dayOfMonth?: number;
  dayOfMonth2?: number;
  dayOfWeek?: number;
} {
  return {
    frequency: s.frequency,
    dayOfMonth: s.frequency !== "weekly" ? Number(s.dayOfMonth) : undefined,
    dayOfMonth2: s.frequency === "semimonthly" ? Number(s.dayOfMonth2) : undefined,
    dayOfWeek: s.frequency === "weekly" ? Number(s.dayOfWeek) : undefined,
  };
}

/** `idPrefix` keeps the label/input `for` pairs unique when two of these
 * render at once (the add form and an open detail modal, say) — duplicate
 * ids silently break clicking a label to focus its field. */
export function ScheduleFields({
  value,
  onChange,
  idPrefix = "sched",
}: {
  value: ScheduleState;
  onChange: (next: ScheduleState) => void;
  idPrefix?: string;
}) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`${idPrefix}-frequency`}>Frequency</label>
        <select
          id={`${idPrefix}-frequency`}
          value={value.frequency}
          onChange={(e) => onChange({ ...value, frequency: e.target.value as RecurringPatternFrequency })}
        >
          <option value="monthly">Monthly</option>
          <option value="semimonthly">Twice a month</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {value.frequency === "weekly" ? (
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={`${idPrefix}-weekday`}>Day</label>
          <select id={`${idPrefix}-weekday`} value={value.dayOfWeek} onChange={(e) => onChange({ ...value, dayOfWeek: e.target.value })}>
            <option value="" disabled>
              Choose…
            </option>
            {WEEKDAY_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`${idPrefix}-day`}>{value.frequency === "semimonthly" ? "First day" : "Day of month"}</label>
            <input
              id={`${idPrefix}-day`}
              type="number"
              min={1}
              max={31}
              value={value.dayOfMonth}
              onChange={(e) => onChange({ ...value, dayOfMonth: e.target.value })}
              style={{ width: 96 }}
            />
          </div>
          {value.frequency === "semimonthly" && (
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`${idPrefix}-day-2`}>Second day</label>
              <input
                id={`${idPrefix}-day-2`}
                type="number"
                min={1}
                max={31}
                value={value.dayOfMonth2}
                onChange={(e) => onChange({ ...value, dayOfMonth2: e.target.value })}
                style={{ width: 96 }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The app's dialog: fixed to the viewport, capped to 90% of it with its
 * own scrollbar, so it can never be clipped by an ancestor's overflow.
 *
 * It also does the three things a dialog has to do to be usable with a
 * keyboard, none of which the page-local copies of this component did:
 * Escape closes it, focus moves into it on open and returns to whatever
 * opened it on close, and Tab is trapped inside it so it can't wander
 * into the page behind. The body is locked from scrolling for the same
 * reason — a dialog that scrolls the page underneath loses the reader's
 * place.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function focusables(): HTMLElement[] {
      if (!cardRef.current) return [];
      return [...cardRef.current.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
    }

    // The first real control, not the close button — opening a dialog
    // should land on the thing you came to change.
    const initial = focusables();
    (initial.find((el) => el.getAttribute("data-autofocus") === "true") ?? initial[1] ?? initial[0])?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={cardRef}
        style={width ? { maxWidth: width } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="row-edit-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
