import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type RecurringPattern, type SeriesOccurrence } from "./api";
import { currentMonth } from "./format";

export interface Recurring {
  patterns: RecurringPattern[];
  /** Occurrences keyed by 'YYYY-MM', for every month asked for so far. */
  occurrencesByMonth: Record<string, SeriesOccurrence[]>;
  loading: boolean;
  error: string | null;
  /** Load any of these months not already held. Safe to call on render. */
  ensureMonths: (months: string[]) => void;
  /** Re-read the patterns and every month held — what to call after a write. */
  refresh: () => Promise<void>;
}

function describe(err: unknown): string {
  if (err instanceof ApiError && err.status >= 500) {
    return "The database migrations for recurring bills haven't been applied on this deployment yet. Run `npx wrangler d1 migrations apply curtisclan --remote`.";
  }
  return err instanceof Error ? err.message : "Couldn't load your bills and income.";
}

/**
 * The household's recurring series and their projected occurrences, held
 * once for the whole app.
 *
 * Two pages need this data and would otherwise each fetch it: the Bills &
 * Income calendar draws it, and the Spending Plan reads it to know which
 * transactions to leave out (a charge a series already accounts for is on
 * the calendar, and counting it in both places would double it). Holding
 * it here also means a bill edited on the calendar is immediately right on
 * the plan, without a reload.
 *
 * Reading a month generates and reconciles it server-side, so a fetch is
 * also what turns a posted paycheck into a "Received" tile — which is why
 * `refresh` re-reads every month held rather than only the visible one.
 */
export function useRecurring(householdId: string | null): Recurring {
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [occurrencesByMonth, setOccurrencesByMonth] = useState<Record<string, SeriesOccurrence[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: adding a month must not itself re-render, or
  // ensureMonths() called during render would loop.
  const months = useRef<Set<string>>(new Set([currentMonth()]));

  const load = useCallback(
    async (wanted: string[]) => {
      if (!householdId || wanted.length === 0) return;
      try {
        const [loadedPatterns, ...lists] = await Promise.all([
          api.listRecurringPatterns(householdId),
          ...wanted.map((m) => api.listOccurrences(householdId, m)),
        ]);
        setPatterns(loadedPatterns);
        setOccurrencesByMonth((prev) => {
          const next = { ...prev };
          wanted.forEach((m, i) => {
            next[m] = lists[i] ?? [];
          });
          return next;
        });
        setError(null);
      } catch (err) {
        setError(describe(err));
      } finally {
        setLoading(false);
      }
    },
    [householdId],
  );

  useEffect(() => {
    if (!householdId) return;
    void load([...months.current]);
  }, [householdId, load]);

  const ensureMonths = useCallback(
    (wanted: string[]) => {
      const missing = wanted.filter((m) => !months.current.has(m));
      if (missing.length === 0) return;
      for (const m of missing) months.current.add(m);
      void load(missing);
    },
    [load],
  );

  const refresh = useCallback(() => load([...months.current]), [load]);

  return { patterns, occurrencesByMonth, loading, error, ensureMonths, refresh };
}
