/**
 * Collapses a raw bank/card description into a stable key for
 * merchant_memory and the rules engine — "WALMART #4821 GRAND JCT CO" and
 * "WALMART #0193 DENVER CO" should both land on WALMART, or repeat visits
 * to the same chain never warm up layer 2 of the cascade (PLAN.md §6).
 *
 * Deliberately simple (uppercase, strip trailing store numbers / city-state
 * suffixes / card-network noise) rather than a lookup table — Plaid's own
 * `merchant_name` field (Phase 1) will supersede this for synced
 * transactions; this mainly matters for CSV-imported history that only has
 * a raw description.
 */
export function normalizeMerchant(rawDescription: string): string {
  let text = rawDescription.toUpperCase().trim();

  // Card-network / processor prefixes.
  text = text.replace(/^(SQ|TST|PAYPAL|POS|DEBIT|PURCHASE|CHECKCARD)\s*[*:]?\s*/, "");

  // Trailing "CITY ST" / "CITY NAME ST" (city word(s) + two-letter state),
  // stripped before the store-number pass below so a store number sitting
  // between the merchant name and the city ("#4821 GRAND JCT CO") doesn't
  // block the match.
  text = text.replace(/\s+([A-Z]+\s+){1,2}[A-Z]{2}$/, "");
  // Lone trailing state code with no city word in front of it.
  text = text.replace(/\s+[A-Z]{2}$/, "");

  // Trailing store/reference numbers ("#4821", "#0193-A").
  text = text.replace(/\s*#[\dA-Z-]+$/, "");

  // Trailing long digit runs (phone numbers, terminal ids).
  text = text.replace(/\s+\d{4,}$/, "");

  return text.replace(/\s+/g, " ").trim();
}

/**
 * A stronger collapse for recurring-bill detection, layered on
 * normalizeMerchant: the grouping key two charges must share to count as
 * the same bill. normalizeMerchant keeps enough of the descriptor to be a
 * faithful merchant name; this strips the parts that change from one
 * month's charge to the next — per-charge reference tokens
 * ("AMAZON PRIME*2K4L9" vs "AMAZON PRIME*7HH3Q"), leading date stamps
 * ("CHECKCARD 0815 NETFLIX.COM"), phone numbers, ".COM" / "/BILL" web
 * suffixes, and generic corporate/payment filler ("SPOTIFY USA", "ROCKY
 * MTN POWER BILL PAY"). Only ever removes tokens, so the result is
 * intentionally short; it is a key, not a display name.
 */
export function canonicalMerchantKey(rawDescription: string): string {
  let text = normalizeMerchant(rawDescription);

  // Bank-side prefixes for ACH/bill-pay rails that carry no merchant.
  text = text.replace(/^(ACH (DEBIT|CREDIT|PAYMENT|PMT)|DIRECT (DEBIT|DEP|DEPOSIT)|ONLINE (PAYMENT|PMT)|BILL ?PAY(MENT)?|RECURRING (PAYMENT|PMT)|AUTOPAY|WEB (PMTS?|PAYMENT)|ELECTRONIC (PAYMENT|PMT|DEBIT|WITHDRAWAL))\s*[-:]?\s*/, "");
  // Leading date stamps some issuers prepend (MMDD or MM/DD).
  text = text.replace(/^\d{2}\/?\d{2}\s+/, "");
  // Per-charge reference tokens after "*", which look like ids (contain a
  // digit) rather than a product name ("GOOGLE *YOUTUBEPREMIUM").
  text = text.replace(/\s*\*\s*(?=[A-Z0-9]*\d)[A-Z0-9]{3,12}\b/g, " ");
  // Phone numbers in any punctuation.
  text = text.replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, " ");
  // Web suffixes.
  text = text.replace(/\bWWW\./g, "").replace(/\.(COM|NET|ORG|CO)\b/g, "").replace(/\/BILL\b/g, "");
  // Any run of 5+ digits anywhere, not just trailing (account/reference numbers).
  text = text.replace(/\b\d{5,}\b/g, " ");
  // Stray punctuation left behind.
  text = text.replace(/[*:/|]+/g, " ").replace(/\s+/g, " ").trim();
  // Trailing corporate/payment filler, repeatedly ("... BILL PAY", "... USA INC").
  const filler = /\s+(USA|US|INC|LLC|LTD|CORP|CO|COMPANY|ONLINE|PAYMENT|PAYMENTS|PMT|PMTS|PYMT|AUTOPAY|EPAY|BILLPAY|BILL|PAY|WEB|ACH|DES|PPD|CCD|ID|DEBIT|CREDIT|RECURRING|SUBSCRIPTION|MEMBERSHIP)$/;
  let previous: string;
  do {
    previous = text;
    text = text.replace(filler, "");
  } while (text !== previous && text.includes(" "));

  return text.trim() || normalizeMerchant(rawDescription);
}
