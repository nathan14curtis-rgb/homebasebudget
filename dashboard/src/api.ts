/**
 * Thin fetch wrapper over the Worker's REST API. Same-origin in
 * production (served by the same Worker as Workers Assets); proxied to a
 * local `wrangler dev` in `npm run dev` (see vite.config.ts).
 */

/** What a field name in a server validation message means to a person. */
const FIELD_WORDS: Record<string, string> = {
  name: "a name",
  accountId: "an account",
  categoryId: "a category",
  postedAt: "a date",
  amountCents: "an amount",
  description: "a description",
  phoneE164: "a phone number",
  userId: "a person",
  verifiedByUserId: "a person",
  task: "a task",
  dueDate: "a due date",
  assetId: "an asset",
  merchantPattern: "a merchant",
  month: "a month",
  newCategoryName: "a name",
  csv: "a CSV file",
  columnMapping: "the column mapping",
  code: "the code",
  householdName: "a household name",
  creatorName: "your name",
};

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/**
 * Turns the server's developer-facing error ("categoryId is required",
 * "phoneE164 must be E.164, e.g. +13035551234") into a sentence a person
 * can act on. Every page shows `err.message` directly, so this is the one
 * place the wording is decided.
 */
export function describeApiError(status: number, body: unknown): string {
  const raw = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;

  if (raw) {
    if (raw === "not logged in") return "You're logged out. Reload the page to log in again.";
    if (raw === "That code is invalid or has expired.") return raw;
    if (raw === "categoryId or newCategoryName is required") return "Pick a category, or give it a new name.";
    if (raw.startsWith("phoneE164")) return "Enter a 10-digit US phone number, like (303) 555-1234.";
    if (raw.startsWith("splits must be")) return "A split needs at least two lines, each with an amount and a category.";
    if (raw.includes("amountCents") && raw.includes("non-zero")) return "Enter an amount other than zero.";
    const required = raw.match(/^(\w+) is required$/);
    if (required) return `Enter ${FIELD_WORDS[required[1]!] ?? required[1]}.`;
    const oneOf = raw.match(/^(\w+) must be one of (.+)$/);
    if (oneOf) return `Choose ${FIELD_WORDS[oneOf[1]!] ?? oneOf[1]} from the options given.`;
    const mustBe = raw.match(/^(\w+)( query param)? must be (.+)$/);
    if (mustBe) return `The ${FIELD_WORDS[mustBe[1]!]?.replace(/^(a|an|the|your) /, "") ?? mustBe[1]} should be ${mustBe[3]}.`;
    if (/not found$/.test(raw)) return "That's no longer here. Reload the page and try again.";
    if (/not configured$/.test(raw)) return "That isn't set up on this deployment yet.";
    if (status < 500) return sentence(raw);
  }

  if (status === 0) return "Couldn't reach the server. Check your connection and try again.";
  if (status === 401) return "You're logged out. Reload the page to log in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That's no longer here. Reload the page and try again.";
  if (status === 409) return "That clashes with something that already exists.";
  if (status === 413) return "That's too large to send.";
  if (status >= 500) return "Something went wrong on the server. Try again in a moment.";
  return "That didn't work. Try again.";
}

export class ApiError extends Error {
  /** The server's own wording, for logs and the console; `message` is the person-facing version. */
  public detail: string;
  constructor(public status: number, public body: unknown) {
    super(describeApiError(status, body));
    this.name = "ApiError";
    this.detail = `API error ${status}: ${JSON.stringify(body)}`;
  }
}

/** The one way a page turns a thrown value into words for a person. */
export function errorMessage(err: unknown, fallback = "That didn't work. Try again."): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export type AccessLevel = "full" | "limited" | "view_only";
export type AssetType = "property" | "vehicle" | "appliance" | "other";
export type DocumentCategory = "insurance" | "warranty" | "identification" | "passwords";
export type VerifyState = "me" | "ai" | "none";
export type TransactionFlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export type MaintenanceStatus = "scheduled" | "due_soon" | "overdue" | "done";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: "imessage" | "dashboard" | "scheduled";
  createdAt: string;
}

export interface Household {
  id: string;
  name: string;
  timezone: string;
  group_chat_id: string | null;
}

export interface User {
  id: string;
  household_id: string;
  name: string;
  phone_e164: string | null;
  phone_verified_at: string | null;
  role: string | null;
  access_level: AccessLevel;
  weekly_allowance_cents: number | null;
  note: string | null;
}

export interface Account {
  id: string;
  household_id: string;
  owner_user_id: string | null;
  name: string;
  type: "depository_checking" | "depository_savings" | "credit_card" | "other";
  mask: string | null;
  plaid_item_id: string | null;
  plaid_account_id: string | null;
  status: "active" | "login_required" | "removed";
  current_balance_cents: number | null;
}

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income" | "savings" | "transfer";
  archived_at: string | null;
}

export interface Envelope {
  id: string;
  household_id: string;
  category_id: string;
  group_name: string;
  monthly_target_cents: number | null;
  // ISO date. A savings-goal envelope (PLAN.md §8.5: not a separate table)
  // is a kind='savings' envelope with this set — see the Goals page.
  target_date: string | null;
  // 'carry' leaves unspent money in the envelope next month; 'reset'
  // starts every month at zero (migration 0011). Set from here or by text.
  rollover_mode: "carry" | "reset";
  archived_at: string | null;
}

export interface EnvelopeMonthSummary {
  month: string;
  allocatedCents: number;
  spentCents: number;
  balanceCents: number;
  /** What carried in from last month: balance − allocated + spent. */
  carriedInCents: number;
}

export interface Transaction {
  id: string;
  household_id: string;
  account_id: string;
  posted_at: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
  category_id: string | null;
  memo: string | null;
  pending: 0 | 1;
  is_transfer: 0 | 1;
  excluded_from_budget: 0 | 1;
  source: "plaid" | "csv_import" | "manual";
  verified_by_user_id: string | null;
  verified_at: string | null;
  flag_color: TransactionFlagColor | null;
  // "me" (verified_by_user_id set) / "ai" (latest classification is
  // rule/memory/llm, never explicitly verified) / "none" — computed by
  // listTransactionsWithVerifyState, not stored.
  verify_state: VerifyState;
}

export interface CsvImportSummary {
  imported: number;
  skippedDuplicates: number;
  unmatchedCategoryNames: string[];
}

export interface Asset {
  id: string;
  household_id: string;
  name: string;
  type: AssetType;
  value_cents: number | null;
  notes: string | null;
  archived_at: string | null;
  documentCount: number;
  openTaskCount: number;
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
}

export type RecurringPatternKind = "expense" | "income";
export type RecurringPatternStatus = "suggested" | "confirmed" | "dismissed";
export type RecurringPatternFrequency = "weekly" | "semimonthly" | "monthly";

export interface RecurringPattern {
  id: string;
  household_id: string;
  category_id: string | null;
  merchant_pattern: string;
  kind: RecurringPatternKind;
  frequency: RecurringPatternFrequency;
  day_of_month: number;
  day_of_month_2: number | null;
  day_of_week: number | null;
  day_tolerance: number;
  status: RecurringPatternStatus;
  sample_count: number;
  expected_amount_cents: number | null;
  ended_at: string | null;
}

export type SeriesOccurrenceStatus = "upcoming" | "matched" | "skipped";

/** One projected occurrence of a series — the 20th's paycheck exists as a
 * row on the 4th, before any transaction does (migrations/0010,
 * src/envelopes/occurrences.ts). */
export interface SeriesOccurrence {
  id: string;
  household_id: string;
  pattern_id: string;
  month: string;
  scheduled_date: string;
  due_date: string;
  amount_cents: number | null;
  amount_override_cents: number | null;
  status: SeriesOccurrenceStatus;
  matched_transaction_id: string | null;
  unlinked_transaction_id: string | null;
}

export interface Tag {
  id: string;
  household_id: string;
  name: string;
  color: string | null;
}

export interface RecurringPatternScheduleInput {
  frequency?: RecurringPatternFrequency;
  dayOfMonth?: number;
  dayOfMonth2?: number;
  dayOfWeek?: number;
  dayTolerance?: number;
}

export interface CategorySuggestion {
  name: string;
  kind: "expense" | "income" | "savings";
  groupName: string;
  monthlyTargetCents: number | null;
  reasoning: string;
}

export type BudgetRowType = "envelope" | "goal" | "bill" | "income";
export type BudgetPlanAction = "create" | "update" | "archive" | "unchanged" | "error";

/** One row of an uploaded budget CSV and what applying it would do
 * (src/budget/csv.ts). */
export interface BudgetPlanRow {
  line: number;
  type: BudgetRowType | null;
  name: string;
  action: BudgetPlanAction;
  changes: string[];
  error?: string;
}

export interface BudgetPlanSummary {
  rows: BudgetPlanRow[];
  creates: number;
  updates: number;
  archives: number;
  errors: number;
  applied: boolean;
}

export interface MaintenanceTask {
  id: string;
  household_id: string;
  asset_id: string;
  task: string;
  due_date: string;
  completed_at: string | null;
  notes: string | null;
  status: MaintenanceStatus;
}

export const api = {
  createHousehold: (name: string, creatorName: string) =>
    request<{ household: Household; userId: string }>("/households", { method: "POST", body: JSON.stringify({ name, creatorName }) }),
  getHousehold: (householdId: string) => request<Household>(`/households/${householdId}`),

  requestLoginCode: (phoneE164: string) => request<{ ok: true }>("/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164 }) }),
  verifyLoginCode: (phoneE164: string, code: string) =>
    request<{ householdId: string; userId: string; userName: string }>("/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ phoneE164, code }),
    }),
  getSession: () => request<{ householdId: string; userId: string; userName: string }>("/auth/session"),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  listUsers: (householdId: string) => request<User[]>(`/households/${householdId}/users`),
  createUser: (
    householdId: string,
    input: { name: string; role?: string; accessLevel?: AccessLevel; weeklyAllowanceCents?: number; note?: string },
  ) => request<User>(`/households/${householdId}/users`, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (
    householdId: string,
    userId: string,
    input: { name?: string; role?: string | null; accessLevel?: AccessLevel; weeklyAllowanceCents?: number | null; note?: string | null },
  ) => request<User>(`/households/${householdId}/users/${userId}`, { method: "PATCH", body: JSON.stringify(input) }),
  verifyPhone: (householdId: string, userId: string, phoneE164: string) =>
    request<User>(`/households/${householdId}/users/${userId}/verify-phone`, {
      method: "POST",
      body: JSON.stringify({ phoneE164 }),
    }),

  listAccounts: (householdId: string) => request<Account[]>(`/households/${householdId}/accounts`),
  createAccount: (householdId: string, input: { name: string; type: Account["type"]; ownerUserId?: string }) =>
    request<Account>(`/households/${householdId}/accounts`, { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (householdId: string, accountId: string, input: { name?: string; ownerUserId?: string | null; status?: Account["status"] }) =>
    request<Account>(`/households/${householdId}/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify(input) }),
  unlinkAccount: (householdId: string, accountId: string, deleteTransactions: boolean) =>
    request<{ ok: true; transactionsDeleted: number }>(`/households/${householdId}/accounts/${accountId}/unlink`, {
      method: "POST",
      body: JSON.stringify({ deleteTransactions }),
    }),

  listCategories: (householdId: string) => request<Category[]>(`/households/${householdId}/categories`),
  createCategory: (
    householdId: string,
    input: { name: string; kind: Category["kind"]; groupName?: string; monthlyTargetCents?: number; targetDate?: string },
  ) =>
    request<{ category: Category; envelope: Envelope | null }>(`/households/${householdId}/categories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  suggestCategories: (householdId: string) => request<CategorySuggestion[]>(`/households/${householdId}/categories/suggest`),
  renameCategory: (householdId: string, categoryId: string, name: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  archiveCategory: (householdId: string, categoryId: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}/archive`, { method: "POST" }),
  unarchiveCategory: (householdId: string, categoryId: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}/unarchive`, { method: "POST" }),

  listEnvelopes: (householdId: string) => request<Envelope[]>(`/households/${householdId}/envelopes`),
  updateEnvelope: (
    householdId: string,
    envelopeId: string,
    input: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null; rolloverMode?: "carry" | "reset" },
  ) => request<Envelope>(`/households/${householdId}/envelopes/${envelopeId}`, { method: "PATCH", body: JSON.stringify(input) }),
  getEnvelopeSummary: (householdId: string, envelopeId: string, month: string) =>
    request<EnvelopeMonthSummary>(`/households/${householdId}/envelopes/${envelopeId}/summary?month=${month}`),
  // Every envelope's summary in one round trip — the Overview page's
  // envelope-fill chart needs all of them at once, and this replaces the
  // per-page Promise.all(envelopes.map(getEnvelopeSummary)) N+1 pattern.
  getEnvelopeSummaries: (householdId: string, month: string) =>
    request<Record<string, EnvelopeMonthSummary>>(`/households/${householdId}/envelopes/summary?month=${month}`),
  allocateToEnvelope: (householdId: string, envelopeId: string, input: { month: string; amountCents: number; note?: string }) =>
    request<{ ok: true }>(`/households/${householdId}/envelopes/${envelopeId}/allocate`, { method: "POST", body: JSON.stringify(input) }),
  // Bring envelopes up to their monthly targets for the month, all of them
  // or just the ids given — the dashboard's counterpart to the texting
  // agent's "fund the month from the plan".
  fundEnvelopes: (householdId: string, input: { month: string; envelopeIds?: string[]; topUpOnly?: boolean }) =>
    request<{ funded: Array<{ envelopeId: string; month: string; amountCents: number; availableAfterCents: number }>; totalCents: number }>(
      `/households/${householdId}/envelopes/fund`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  // The whole plan as a spreadsheet, and the way back (src/budget/csv.ts).
  downloadBudgetCsv: async (householdId: string) => {
    const response = await fetch(`/api/households/${householdId}/budget/csv`);
    if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
    return response.text();
  },
  previewBudgetCsv: (householdId: string, csv: string) =>
    request<BudgetPlanSummary>(`/households/${householdId}/budget/csv`, { method: "POST", body: JSON.stringify({ csv, apply: false }) }),
  applyBudgetCsv: (householdId: string, csv: string) =>
    request<BudgetPlanSummary>(`/households/${householdId}/budget/csv`, { method: "POST", body: JSON.stringify({ csv, apply: true }) }),
  moveMoneyBetweenEnvelopes: (
    householdId: string,
    input: { fromEnvelopeId: string; toEnvelopeId: string; month: string; amountCents: number; note?: string },
  ) => request<{ ok: true }>(`/households/${householdId}/envelopes/move`, { method: "POST", body: JSON.stringify(input) }),

  listTransactions: (
    householdId: string,
    filter: { accountId?: string; categoryId?: string; fromDate?: string; toDate?: string; needsReview?: boolean; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (filter.accountId) params.set("accountId", filter.accountId);
    if (filter.categoryId) params.set("categoryId", filter.categoryId);
    if (filter.fromDate) params.set("fromDate", filter.fromDate);
    if (filter.toDate) params.set("toDate", filter.toDate);
    if (filter.needsReview) params.set("needsReview", "true");
    if (filter.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return request<Transaction[]>(`/households/${householdId}/transactions${qs ? `?${qs}` : ""}`);
  },
  categorizeTransaction: (householdId: string, transactionId: string, input: { categoryId: string; memo?: string }) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/categorize`, { method: "PATCH", body: JSON.stringify(input) }),
  editTransaction: (householdId: string, transactionId: string, input: { categoryId: string; amountCents: number; editedByUserId?: string }) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/edit`, { method: "PATCH", body: JSON.stringify(input) }),
  setTransactionFlag: (householdId: string, transactionId: string, color: TransactionFlagColor | null) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/flag`, { method: "POST", body: JSON.stringify({ color }) }),
  setTransactionExcluded: (householdId: string, transactionId: string, excluded: boolean) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/exclude`, {
      method: "POST",
      body: JSON.stringify({ excluded }),
    }),
  verifyTransaction: (householdId: string, transactionId: string, verifiedByUserId: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/verify`, {
      method: "POST",
      body: JSON.stringify({ verifiedByUserId }),
    }),
  unverifyTransaction: (householdId: string, transactionId: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/unverify`, { method: "POST" }),
  uncategorizeTransaction: (householdId: string, transactionId: string, clearedByUserId?: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/uncategorize`, {
      method: "POST",
      body: JSON.stringify({ clearedByUserId }),
    }),

  createLinkToken: (householdId: string, userId: string) =>
    request<{ link_token: string; expiration: string }>(`/households/${householdId}/plaid/link-token`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  exchangePlaidToken: (householdId: string, publicToken: string, institutionName?: string) =>
    request<{ itemId: string }>(`/households/${householdId}/plaid/exchange-token`, {
      method: "POST",
      body: JSON.stringify({ publicToken, institutionName }),
    }),

  importCsv: (
    householdId: string,
    input: { accountId: string; csv: string; columnMapping: { date: string; description: string; amount: string; category?: string; memo?: string } },
  ) => request<CsvImportSummary>(`/households/${householdId}/import/csv`, { method: "POST", body: JSON.stringify(input) }),

  listAssets: (householdId: string) => request<Asset[]>(`/households/${householdId}/assets`),
  createAsset: (householdId: string, input: { name: string; type: AssetType; valueCents?: number; notes?: string }) =>
    request<Omit<Asset, "documentCount" | "openTaskCount">>(`/households/${householdId}/assets`, { method: "POST", body: JSON.stringify(input) }),
  updateAsset: (
    householdId: string,
    assetId: string,
    input: { name?: string; type?: AssetType; valueCents?: number | null; notes?: string | null },
  ) => request<Omit<Asset, "documentCount" | "openTaskCount">>(`/households/${householdId}/assets/${assetId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveAsset: (householdId: string, assetId: string) =>
    request<Asset>(`/households/${householdId}/assets/${assetId}/archive`, { method: "POST" }),

  listDocuments: (householdId: string, filter: { category?: DocumentCategory; assetId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.category) params.set("category", filter.category);
    if (filter.assetId) params.set("assetId", filter.assetId);
    const qs = params.toString();
    return request<Document[]>(`/households/${householdId}/documents${qs ? `?${qs}` : ""}`);
  },
  createDocument: (householdId: string, input: { name: string; category: DocumentCategory; assetId?: string; ownerUserId?: string; detail?: string }) =>
    request<Document>(`/households/${householdId}/documents`, { method: "POST", body: JSON.stringify(input) }),
  updateDocument: (
    householdId: string,
    documentId: string,
    input: { name?: string; detail?: string | null; ownerUserId?: string | null; assetId?: string | null },
  ) => request<Document>(`/households/${householdId}/documents/${documentId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveDocument: (householdId: string, documentId: string) =>
    request<Document>(`/households/${householdId}/documents/${documentId}/archive`, { method: "POST" }),

  listMaintenanceTasks: (householdId: string, filter: { assetType?: AssetType; assetId?: string; includeCompleted?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (filter.assetType) params.set("assetType", filter.assetType);
    if (filter.assetId) params.set("assetId", filter.assetId);
    if (filter.includeCompleted) params.set("includeCompleted", "true");
    const qs = params.toString();
    return request<MaintenanceTask[]>(`/households/${householdId}/maintenance${qs ? `?${qs}` : ""}`);
  },
  createMaintenanceTask: (householdId: string, input: { assetId: string; task: string; dueDate: string; notes?: string }) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance`, { method: "POST", body: JSON.stringify(input) }),
  updateMaintenanceTask: (householdId: string, taskId: string, input: { task?: string; dueDate?: string; notes?: string | null }) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}`, { method: "PATCH", body: JSON.stringify(input) }),
  completeMaintenanceTask: (householdId: string, taskId: string) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}/complete`, { method: "POST" }),
  reopenMaintenanceTask: (householdId: string, taskId: string) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}/reopen`, { method: "POST" }),

  listRecurringPatterns: (householdId: string, status?: RecurringPatternStatus) =>
    request<RecurringPattern[]>(`/households/${householdId}/recurring-patterns${status ? `?status=${status}` : ""}`),
  createRecurringPattern: (
    householdId: string,
    input: {
      merchantPattern: string;
      kind: "expense" | "income";
      categoryId?: string;
      newCategoryName?: string;
      monthlyTargetCents?: number;
      // What the Bills & Income calendar shows on a tile before anything
      // has posted against it. Falls back to monthlyTargetCents server-side.
      expectedAmountCents?: number;
    } & RecurringPatternScheduleInput,
  ) => request<RecurringPattern>(`/households/${householdId}/recurring-patterns`, { method: "POST", body: JSON.stringify(input) }),
  updateRecurringPattern: (
    householdId: string,
    patternId: string,
    input: { merchantPattern?: string; categoryId?: string; expectedAmountCents?: number | null; endedAt?: string | null } & RecurringPatternScheduleInput,
  ) =>
    request<RecurringPattern>(`/households/${householdId}/recurring-patterns/${patternId}`, { method: "PATCH", body: JSON.stringify(input) }),
  detectRecurringPatterns: (householdId: string) =>
    request<RecurringPattern[]>(`/households/${householdId}/recurring-patterns/detect`, { method: "POST" }),
  // Puts a detected series on the calendar. Takes the amount, schedule and
  // merchant corrected in the same dialog so it is one request, not two.
  confirmRecurringPattern: (
    householdId: string,
    patternId: string,
    input: {
      categoryId?: string;
      newCategoryName?: string;
      kind?: "expense" | "income";
      merchantPattern?: string;
      expectedAmountCents?: number | null;
    } & RecurringPatternScheduleInput,
  ) => request<RecurringPattern>(`/households/${householdId}/recurring-patterns/${patternId}/confirm`, { method: "POST", body: JSON.stringify(input) }),
  dismissRecurringPattern: (householdId: string, patternId: string) =>
    request<{ ok: true }>(`/households/${householdId}/recurring-patterns/${patternId}/dismiss`, { method: "POST" }),
  // Removes the series and every occurrence it projected — the calendar's
  // "Delete", as opposed to "Stop after this month" (which PATCHes endedAt
  // and leaves what already happened on the calendar).
  deleteRecurringPattern: (householdId: string, patternId: string) =>
    request<{ ok: true }>(`/households/${householdId}/recurring-patterns/${patternId}`, { method: "DELETE" }),

  createTransaction: (
    householdId: string,
    input: { accountId: string; postedAt: string; amountCents: number; description: string; categoryId: string; memo?: string; createdByUserId?: string },
  ) => request<Transaction>(`/households/${householdId}/transactions`, { method: "POST", body: JSON.stringify(input) }),

  // The transaction detail modal's one save — every field it shows, in a
  // single write. Omitted fields are left alone; an explicit null clears
  // (memo, flagColor).
  updateTransaction: (
    householdId: string,
    transactionId: string,
    input: {
      payee?: string;
      postedAt?: string;
      amountCents?: number;
      accountId?: string;
      categoryId?: string;
      memo?: string | null;
      pending?: boolean;
      excluded?: boolean;
      flagColor?: TransactionFlagColor | null;
      editedByUserId?: string;
    },
  ) => request<Transaction>(`/households/${householdId}/transactions/${transactionId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTransaction: (householdId: string, transactionId: string) =>
    request<{ ok: true }>(`/households/${householdId}/transactions/${transactionId}`, { method: "DELETE" }),
  splitTransaction: (householdId: string, transactionId: string, splits: Array<{ amountCents: number; categoryId: string; memo?: string }>) =>
    request<Transaction[]>(`/households/${householdId}/transactions/${transactionId}/split`, { method: "POST", body: JSON.stringify({ splits }) }),

  listTags: (householdId: string) => request<Tag[]>(`/households/${householdId}/tags`),
  createTag: (householdId: string, input: { name: string; color?: string | null }) =>
    request<Tag>(`/households/${householdId}/tags`, { method: "POST", body: JSON.stringify(input) }),
  deleteTag: (householdId: string, tagId: string) => request<{ ok: true }>(`/households/${householdId}/tags/${tagId}`, { method: "DELETE" }),
  // Every transaction's tags in one read, so a list page doesn't N+1.
  listTagsByTransaction: (householdId: string) => request<Record<string, Tag[]>>(`/households/${householdId}/transactions/tags`),
  setTransactionTags: (householdId: string, transactionId: string, input: { tagIds?: string[]; tagNames?: string[] }) =>
    request<Tag[]>(`/households/${householdId}/transactions/${transactionId}/tags`, { method: "PUT", body: JSON.stringify(input) }),

  // Generates and reconciles before returning, so this is the whole read
  // the Spending Plan needs for a month.
  listOccurrences: (householdId: string, month: string) =>
    request<SeriesOccurrence[]>(`/households/${householdId}/occurrences?month=${month}`),
  updateOccurrence: (
    householdId: string,
    occurrenceId: string,
    input: { amountOverrideCents?: number | null; dueDate?: string; status?: "upcoming" | "skipped" },
  ) => request<SeriesOccurrence>(`/households/${householdId}/occurrences/${occurrenceId}`, { method: "PATCH", body: JSON.stringify(input) }),
  unlinkOccurrence: (householdId: string, occurrenceId: string) =>
    request<SeriesOccurrence>(`/households/${householdId}/occurrences/${occurrenceId}/unlink`, { method: "POST" }),

  // The same conversation the household has by text, from the dashboard —
  // one thread, one agent (src/messaging/agent.ts).
  getChat: (householdId: string) => request<{ messages: ChatMessage[] }>(`/households/${householdId}/chat`),
  sendChat: (householdId: string, message: string, userId?: string | null) =>
    request<{ reply: string; changed: boolean }>(`/households/${householdId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message, userId: userId ?? undefined }),
    }),
};
