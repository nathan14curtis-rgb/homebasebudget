/** Job payloads for TRANSACTION_QUEUE (ingest + categorization work) and
 * MESSAGE_QUEUE (outbound Sendblue sends, kept on a separate queue so a
 * low concurrency limit there doesn't also throttle Plaid sync). */

export type TransactionQueueMessage =
  | { type: "plaid_sync"; householdId: string; plaidItemId: string }
  | { type: "item_webhook"; householdId: string; plaidItemId: string; webhookCode: string }
  // skipClarification is set for a newly-linked item's initial historical
  // backfill (PLAN.md §4.2's "12-24 months at setup") — those
  // transactions still get categorized normally via rules/memory/LLM, but
  // never trigger an individual clarification text. Only genuinely new,
  // going-forward transactions ask a human (see src/plaid/sync.ts).
  | { type: "categorize"; householdId: string; transactionId: string; skipClarification?: boolean }
  | { type: "resolve_reply"; householdId: string; userId: string; inboundMessageId: string }
  // One pass of the Google Sheet sync (src/sheets/sync.ts): every five
  // minutes from cron, and right after a sheet is connected.
  | { type: "sheet_sync"; householdId: string };

export type MessageQueueMessage =
  // The hourly batched ask about charges the cascade couldn't place
  // (src/messaging/hourlyCheckin.ts) — one message per household per hour,
  // not one per charge, and only ever about that hour's charges.
  | { type: "hourly_checkin"; householdId: string }
  | { type: "daily_digest"; householdId: string };
