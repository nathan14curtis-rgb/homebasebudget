/**
 * Turning what a person types into cents, one way for the whole app.
 *
 * Amount fields used to come in three shapes — a signed number input, a
 * text field with a "$" prefix, and a text field with "$" in the
 * placeholder — and only the dialogs checked what was typed before
 * sending it. `Number("abc")` is NaN, and NaN went to the server.
 */

/** Cents from a typed amount, or null when it isn't a number. "$1,234.50",
 * "1234.5" and " 12 " all parse; an empty string is null too, so callers
 * decide whether blank means "none" or "required". */
export function parseMoney(value: string, { allowNegative = false }: { allowNegative?: boolean } = {}): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned || !/^-?\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents)) return null;
  return allowNegative ? cents : Math.abs(cents);
}

/** "45.23" from cents, for putting an existing value into a field. Sign is
 * kept only when asked for, since most fields are magnitudes. */
export function moneyToInput(cents: number | null | undefined, { signed = false }: { signed?: boolean } = {}): string {
  if (cents === null || cents === undefined) return "";
  const dollars = (signed ? cents : Math.abs(cents)) / 100;
  return dollars.toFixed(2);
}
