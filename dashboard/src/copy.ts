/**
 * Words the app uses in more than one place, so they are the same words
 * in every place.
 */

/** A transaction with no category — it used to be "Uncategorized",
 * "Needs review", "Needs a category" and "still need a category"
 * depending on which screen you were on. */
export const NEEDS_CATEGORY = "Needs a category";

export function needsCategoryCount(count: number): string {
  return `${count} transaction${count === 1 ? "" : "s"} still need${count === 1 ? "s" : ""} a category`;
}

/** Plural helper for the copy that counts things. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Standard button labels. */
export const LABEL = {
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  add: "Add",
  adding: "Adding…",
  remove: "Remove",
  removing: "Removing…",
  edit: "Edit",
  working: "Working…",
} as const;

/** Standard field-level validation messages. */
export const VALIDATION = {
  name: "Give it a name.",
  amount: "Enter a valid amount, like 45 or 45.50.",
  amountRequired: "Enter an amount.",
  date: "Pick a date.",
  category: "Pick a category.",
} as const;

/** The two kinds of recurring series, as the person sees them. */
export function seriesNoun(isIncome: boolean): "bill" | "income" {
  return isIncome ? "income" : "bill";
}

/** Formats a string of digits as a US phone number: "303", "(303) 555",
 * "(303) 555-1234". Caps at 10 digits — a leading "1" is dropped since it
 * is added back at submit time. */
export function formatUsPhoneDisplay(digits: string): string {
  const d = digits.replace(/^1/, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** "+13035551234" from typed digits, or null until there are ten of them. */
export function usPhoneToE164(digits: string): string | null {
  const d = digits.replace(/\D/g, "").replace(/^1/, "").slice(0, 10);
  return d.length === 10 ? `+1${d}` : null;
}
