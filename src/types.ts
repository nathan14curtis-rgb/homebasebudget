/** Domain types mirroring migrations/0001_init.sql. Kept as plain rows —
 * D1's driver returns exactly this shape, no ORM mapping layer. */

export type CategoryKind = "expense" | "income" | "savings" | "transfer";
export type AccountType = "depository_checking" | "depository_savings" | "credit_card" | "other";
export type AccountStatus = "active" | "login_required" | "removed";
export type TransactionSource = "plaid" | "csv_import" | "manual";
export type TransactionFlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export type ClassificationMethod = "rule" | "memory" | "llm" | "human";
export type AllocationSource = "income_assignment" | "envelope_move" | "correction";
/** Whether an envelope's leftover money survives the turn of the month.
 * 'carry' is the ledger's natural behavior (PLAN.md §3); 'reset' zeroes
 * what carried in at the start of each month with a correction entry, for
 * the envelopes a household thinks of as starting fresh. */
export type RolloverMode = "carry" | "reset";
export type ClarificationStatus = "queued" | "sent" | "answered" | "timed_out";
export type RuleSource = "user" | "ai_suggested";
export type AccessLevel = "full" | "limited" | "view_only";
export type RecurringPatternKind = "expense" | "income";
export type RecurringPatternStatus = "suggested" | "confirmed" | "dismissed";
export type RecurringPatternFrequency = "weekly" | "semimonthly" | "monthly";
export type SeriesOccurrenceStatus = "upcoming" | "matched" | "skipped";
export type AssetType = "property" | "vehicle" | "appliance" | "other";
export type DocumentCategory = "insurance" | "warranty" | "identification" | "passwords";

export interface Household {
  id: string;
  name: string;
  timezone: string;
  // Sendblue's group thread id, set the first time a clarification is
  // sent — every household-scoped message reuses it (src/messaging/groupChat.ts).
  group_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  household_id: string;
  name: string;
  phone_e164: string | null;
  phone_verified_at: string | null;
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  notification_prefs: string;
  role: string | null;
  access_level: AccessLevel;
  weekly_allowance_cents: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  household_id: string;
  owner_user_id: string | null;
  name: string;
  type: AccountType;
  mask: string | null;
  plaid_item_id: string | null;
  plaid_account_id: string | null;
  status: AccountStatus;
  current_balance_cents: number | null;
  available_balance_cents: number | null;
  balance_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PlaidItemStatus = "active" | "login_required" | "removed";

export interface PlaidItem {
  id: string;
  household_id: string;
  plaid_item_id: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  institution_name: string | null;
  status: PlaidItemStatus;
  cursor: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurringPattern {
  id: string;
  household_id: string;
  category_id: string | null;
  merchant_pattern: string;
  kind: RecurringPatternKind;
  frequency: RecurringPatternFrequency;
  day_of_month: number;
  // Set only when frequency = 'semimonthly' (the pattern's second day of
  // the month, e.g. the 23rd alongside day_of_month's 8th).
  day_of_month_2: number | null;
  // Set only when frequency = 'weekly' (0=Sunday..6=Saturday); day_of_month
  // is unused (but still stored, see migrations/0008) for weekly rows.
  day_of_week: number | null;
  day_tolerance: number;
  status: RecurringPatternStatus;
  sample_count: number;
  // What this series is expected to cost (expense) or pay (income), so a
  // projected occurrence has an amount before anything has posted. Null
  // until seeded from matched history or set by hand.
  expected_amount_cents: number | null;
  // Set when the series is over (a cancelled subscription, a job change):
  // history stays matched, nothing new is projected past this date.
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One materialized occurrence of a confirmed recurring_pattern — the
 * 4th's paycheck and the 20th's are separate rows, so one of them can
 * carry a different amount or be skipped without touching the series
 * (migrations/0010, src/envelopes/occurrences.ts). */
export interface SeriesOccurrence {
  id: string;
  household_id: string;
  pattern_id: string;
  month: string; // 'YYYY-MM'
  // What the schedule produced, never edited — regeneration keys off this,
  // so moving an occurrence doesn't leave a hole that gets refilled with a
  // duplicate at the original date.
  scheduled_date: string;
  due_date: string; // ISO date it is actually expected; starts equal to scheduled_date
  amount_cents: number | null;
  // A one-month change ("the water bill is $240 this month"), which
  // survives regeneration and never edits the series.
  amount_override_cents: number | null;
  status: SeriesOccurrenceStatus;
  matched_transaction_id: string | null;
  // A transaction explicitly unlinked from this occurrence, so the next
  // reconcile doesn't simply re-match the pair.
  unlinked_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  household_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export interface Category {
  id: string;
  household_id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Envelope {
  id: string;
  household_id: string;
  category_id: string;
  group_name: string;
  sort_order: number;
  monthly_target_cents: number | null;
  target_date: string | null;
  rollover_mode: RolloverMode;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Allocation {
  id: string;
  household_id: string;
  envelope_id: string;
  month: string; // 'YYYY-MM'
  amount_cents: number;
  source: AllocationSource;
  related_envelope_id: string | null;
  note: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface EnvelopeBalanceSnapshot {
  id: string;
  household_id: string;
  envelope_id: string;
  month: string;
  balance_cents: number;
  computed_at: string;
}

export interface Transaction {
  id: string;
  household_id: string;
  account_id: string;
  plaid_txn_id: string | null;
  pending_plaid_txn_id: string | null;
  posted_at: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
  category_id: string | null;
  memo: string | null;
  pending: 0 | 1;
  is_transfer: 0 | 1;
  excluded_from_budget: 0 | 1;
  split_parent_id: string | null;
  source: TransactionSource;
  verified_by_user_id: string | null;
  verified_at: string | null;
  flag_color: TransactionFlagColor | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionClassification {
  id: string;
  household_id: string;
  transaction_id: string;
  method: ClassificationMethod;
  category_id: string | null;
  confidence: number | null;
  model: string | null;
  reasoning: string | null;
  alternatives: string | null;
  prompt_version: string | null;
  rule_id: string | null;
  prior_category_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface Clarification {
  id: string;
  household_id: string;
  transaction_id: string;
  user_id: string;
  status: ClarificationStatus;
  question_text: string | null;
  sendblue_handle: string | null;
  sent_at: string | null;
  answered_at: string | null;
  timed_out_at: string | null;
  created_at: string;
}

export interface InboundMessage {
  id: string;
  household_id: string | null;
  user_id: string | null;
  from_number: string;
  message_handle: string;
  content: string;
  received_at: string;
  processed_at: string | null;
  raw_payload: string;
}

export type ConversationRole = "user" | "assistant";
export type ConversationChannel = "imessage" | "dashboard" | "scheduled";

export interface ConversationMessage {
  id: string;
  household_id: string;
  user_id: string | null;
  role: ConversationRole;
  content: string;
  channel: ConversationChannel;
  created_at: string;
}

export interface MerchantMemory {
  id: string;
  household_id: string;
  normalized_merchant: string;
  category_id: string;
  hit_count: number;
  last_confirmed_at: string | null;
  typical_amount_cents: number | null;
  amount_stddev_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface Rule {
  id: string;
  household_id: string;
  priority: number;
  conditions: string; // JSON predicate tree, see src/categorization/rules.ts
  actions: string; // JSON action list
  source: RuleSource;
  match_count: number;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  household_id: string;
  name: string;
  type: AssetType;
  value_cents: number | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  household_id: string;
  asset_id: string | null;
  name: string;
  category: DocumentCategory;
  owner_user_id: string | null;
  detail: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceTask {
  id: string;
  household_id: string;
  asset_id: string;
  task: string;
  due_date: string;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  token_hash: string;
  household_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

export interface LoginCode {
  id: string;
  phone_e164: string;
  code_hash: string;
  attempts: number;
  consumed_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  TRANSACTION_QUEUE: Queue;
  MESSAGE_QUEUE: Queue;
  ASSETS: Fetcher; // dashboard/dist, served by the platform — unused directly in Worker code
  ENVIRONMENT: string;

  // Workers Secrets (wrangler secret put <NAME>) — see README for the
  // exact commands. Optional at the type level because local dev without
  // them should still boot; every call site that needs one checks it.
  TOKEN_ENCRYPTION_KEY?: string; // base64 AES-256 key, src/lib/crypto.ts
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: "sandbox" | "production";
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET_KEY?: string;
  SENDBLUE_SIGNING_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string; // the Sendblue-assigned number to send from — required by their API
  SENDBLUE_API_BASE_URL?: string; // default https://api.sendblue.com/api
  ANTHROPIC_API_KEY?: string;
}

/** One write an agent turn made, with a before-image good enough to undo
 * it (migration 0011). Text has no cancel button; this table is it. */
export interface AgentChangeLogEntry {
  id: string;
  household_id: string;
  user_id: string | null;
  tool_name: string;
  summary: string;
  undo: string;
  reverted_at: string | null;
  reverted_by_id: string | null;
  created_at: string;
}
