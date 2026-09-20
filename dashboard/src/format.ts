export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 'YYYY-MM' in local time, the same clock as the calendar's todayIso().
 * (toISOString() is UTC, which from about 6 pm Mountain on the last day of
 * a month is already next month — and an adjustment made then landed in
 * the wrong month.) */
export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Days remaining in the current month, counting today — matches the
 * mockup's "Month status" sidebar widget ("N days left ... before the
 * 1st"). */
export function daysLeftInMonth(now = new Date()): number {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return lastDay - now.getDate() + 1;
}

/** "Today" / "Yesterday" / "August 28" — groups the Transactions list by
 * day the way the mockup does, from a 'YYYY-MM-DD' posted_at string. */
export function dayLabel(dateStr: string, now = new Date()): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}
