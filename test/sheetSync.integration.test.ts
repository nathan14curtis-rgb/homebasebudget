import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { getEnvelopeMonthSummariesForHousehold, listEnvelopes } from "../src/db/envelopes";
import { listChanges } from "../src/db/changeLog";
import { listRecurringPatterns } from "../src/db/recurringPatterns";
import { createTransaction, getTransaction, listTransactions } from "../src/db/transactions";
import { listTagsForTransaction } from "../src/db/tags";
import { acquireSheetLock, getSheetLink, releaseSheetLock, upsertSheetLink } from "../src/db/sheetLinks";
import { runAgentTool } from "../src/messaging/agentTools";
import { syncHouseholdSheet } from "../src/sheets/sync";
import { FakeSheets } from "./fakeSheets";

/**
 * The Google Sheet as the household's editing surface: what a person
 * types into a cell lands in the ledger through the same tools a text
 * does, and the sheet always comes back showing the ledger's answer.
 * Each test types into an in-memory sheet and syncs, the way a person
 * editing and the five-minute cron would.
 */

const db = env.DB;

function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const today = localToday();
const month = today.slice(0, 7);

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan", timezone: "America/Denver" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  const costco = await createTransaction(db, household.id, {
    accountId: checking.id,
    postedAt: today,
    amountCents: -18000,
    rawDescription: "COSTCO WHSE #0123",
    normalizedMerchant: "Costco",
  });
  const maverik = await createTransaction(db, household.id, {
    accountId: checking.id,
    postedAt: today,
    amountCents: -4250,
    rawDescription: "MAVERIK 442",
    normalizedMerchant: "Maverik",
  });
  await upsertSheetLink(db, household.id, `sheet-for-${household.id}`);
  const sheet = new FakeSheets();
  // First pass: lays out the tabs and fills them; there's nothing to diff yet.
  const first = await syncHouseholdSheet(env, household.id, sheet);
  expect(first.status).toBe("synced");
  return { household, nathan, checking, costco, maverik, sheet };
}

async function envelopeFor(householdId: string, name: string) {
  const category = (await listCategories(db, householdId)).find((c) => c.name === name)!;
  const envelope = (await listEnvelopes(db, householdId)).find((e) => e.category_id === category.id)!;
  return { category, envelope };
}

describe("first sync", () => {
  it("builds every tab, hides the lists, and fills them from the database", async () => {
    const { sheet, costco } = await seed();
    const titles = [...sheet.tabs.keys()];
    expect(titles).toEqual(expect.arrayContaining(["Read Me", "Budget", "Transactions", "Bills", "Bills This Month", "Categories", "Log", "_lists"]));
    expect(titles).not.toContain("Sheet1");
    expect(sheet.tabs.get("_lists")!.hidden).toBe(true);

    const row = sheet.findRow("Transactions", "id", costco.id)!;
    expect(row.cells).toMatchObject({ Payee: "Costco", Amount: -180, Category: "", Status: "Needs category", Account: "Chase Checking" });

    expect(sheet.grid("Budget")[0]![2]).toBe(month);
    expect(sheet.findRow("Budget", "Category", "Groceries", 2)).not.toBeNull();
  });
});

describe("editing a transaction", () => {
  it("categorizes, renames, tags and flags through the agent tools, and logs it as the sheet", async () => {
    const { household, sheet, costco } = await seed();
    const row = sheet.findRow("Transactions", "id", costco.id)!;
    sheet.type("Transactions", row.index, "Category", "Groceries");
    sheet.type("Transactions", row.index, "Payee", "Costco Run");
    sheet.type("Transactions", row.index, "Tags", "bulk, family");
    sheet.type("Transactions", row.index, "Flag", "blue");

    const result = await syncHouseholdSheet(env, household.id, sheet);
    expect(result).toMatchObject({ applied: 1, failed: 0 });

    const saved = await getTransaction(db, household.id, costco.id);
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    expect(saved.category_id).toBe(groceries.id);
    expect(saved.normalized_merchant).toBe("Costco Run");
    expect(saved.flag_color).toBe("blue");
    expect((await listTagsForTransaction(db, household.id, costco.id)).map((t) => t.name).sort()).toEqual(["bulk", "family"]);

    const changes = await listChanges(db, household.id, { limit: 10 });
    expect(changes.every((c) => c.tool_name.startsWith("sheet:"))).toBe(true);
    expect(sheet.findRow("Log", "Who", "Sheet")).not.toBeNull();
    expect(sheet.findRow("Transactions", "id", costco.id)!.cells.Status).not.toBe("Needs category");
  });

  it("only applies what changed — a second sync with no typing does nothing", async () => {
    const { household, sheet, costco } = await seed();
    sheet.type("Transactions", sheet.findRow("Transactions", "id", costco.id)!.index, "Category", "Groceries");
    await syncHouseholdSheet(env, household.id, sheet);
    const writesBefore = sheet.writeCalls;
    const again = await syncHouseholdSheet(env, household.id, sheet);
    expect(again).toMatchObject({ applied: 0, failed: 0 });
    expect((await listChanges(db, household.id, { limit: 50 })).filter((c) => c.tool_name === "sheet:categorize_transactions")).toHaveLength(1);
    expect(sheet.writeCalls).toBe(writesBefore + 1); // only the hidden lists tab is rewritten
  });

  it("refuses a category that doesn't exist, puts the cell back, and says why on the row", async () => {
    const { household, sheet, costco } = await seed();
    const row = sheet.findRow("Transactions", "id", costco.id)!;
    sheet.type("Transactions", row.index, "Category", "Grocerys and stuff");
    const result = await syncHouseholdSheet(env, household.id, sheet);
    expect(result.failed).toBe(1);
    const after = sheet.findRow("Transactions", "id", costco.id)!;
    expect(after.cells.Category).toBe("");
    expect(String(after.cells.Sync)).toMatch(/No category named/);
    expect((await getTransaction(db, household.id, costco.id)).category_id).toBeNull();
  });

  it("splits a charge from the Split column, and the parent stops counting", async () => {
    const { household, sheet, costco } = await seed();
    const row = sheet.findRow("Transactions", "id", costco.id)!;
    sheet.type("Transactions", row.index, "Split", "Groceries 120, Gifts 60");
    await syncHouseholdSheet(env, household.id, sheet);

    const children = (await listTransactions(db, household.id)).filter((t) => t.split_parent_id === costco.id);
    expect(children.map((c) => c.amount_cents).sort()).toEqual([-12000, -6000]);
    expect((await getTransaction(db, household.id, costco.id)).excluded_from_budget).toBe(1);
    expect(String(sheet.findRow("Transactions", "id", costco.id)!.cells.Split)).toMatch(/Groceries 120\.00/);
  });

  it("adds a cash charge typed on an empty row", async () => {
    const { household, sheet } = await seed();
    sheet.addRow("Transactions", { Date: today, Payee: "Farmers market", Amount: -23.5, Category: "Groceries", Account: "Chase Checking" });
    const result = await syncHouseholdSheet(env, household.id, sheet);
    expect(result.applied).toBe(1);
    const added = (await listTransactions(db, household.id)).find((t) => t.normalized_merchant === "Farmers market")!;
    expect(added).toMatchObject({ amount_cents: -2350, source: "manual" });
    expect(sheet.findRow("Transactions", "id", added.id)).not.toBeNull();
  });

  it("keeps an incomplete new row in the sheet with what's missing, then adds it once fixed", async () => {
    const { household, sheet } = await seed();
    sheet.addRow("Transactions", { Payee: "Cash tip", Amount: -10 });
    const first = await syncHouseholdSheet(env, household.id, sheet);
    expect(first.failed).toBe(1);
    const pending = sheet.findRow("Transactions", "Payee", "Cash tip")!;
    expect(pending.cells.id).toBe("");
    expect(String(pending.cells.Sync)).toMatch(/Date.*Account/);

    sheet.type("Transactions", pending.index, "Date", today);
    sheet.type("Transactions", pending.index, "Account", "Chase Checking");
    const second = await syncHouseholdSheet(env, household.id, sheet);
    expect(second).toMatchObject({ applied: 1, failed: 0 });
    expect((await listTransactions(db, household.id)).filter((t) => t.normalized_merchant === "Cash tip")).toHaveLength(1);
    expect(sheet.findRow("Transactions", "Payee", "Cash tip")!.cells.id).not.toBe("");
  });
});

describe("editing the Budget tab", () => {
  it("changes the plan, books this month's assigned total as a delta, and sets the opening balance", async () => {
    const { household, sheet } = await seed();
    const row = sheet.findRow("Budget", "Category", "Groceries", 2)!;
    sheet.type("Budget", row.index, "Monthly target", 900, 2);
    sheet.type("Budget", row.index, "Rollover", "reset", 2);
    sheet.type("Budget", row.index, "Assigned", 650, 2);
    await syncHouseholdSheet(env, household.id, sheet);

    const { envelope } = await envelopeFor(household.id, "Groceries");
    expect(envelope).toMatchObject({ monthly_target_cents: 90000, rollover_mode: "reset" });
    const summary = (await getEnvelopeMonthSummariesForHousehold(db, household.id, month))[envelope.id]!;
    expect(summary.allocatedCents).toBe(65000);

    // Typing a smaller total takes money back out rather than adding more.
    sheet.type("Budget", sheet.findRow("Budget", "Category", "Groceries", 2)!.index, "Assigned", 600, 2);
    await syncHouseholdSheet(env, household.id, sheet);
    expect((await getEnvelopeMonthSummariesForHousehold(db, household.id, month))[envelope.id]!.allocatedCents).toBe(60000);
    expect(sheet.findRow("Budget", "Category", "Groceries", 2)!.cells.Available).toBe(600);

    // "Carried in" books a correction in last month, not this month's funding.
    const gas = await envelopeFor(household.id, "Gas");
    sheet.type("Budget", sheet.findRow("Budget", "Category", "Gas", 2)!.index, "Carried in", 40, 2);
    await syncHouseholdSheet(env, household.id, sheet);
    const gasSummary = (await getEnvelopeMonthSummariesForHousehold(db, household.id, month))[gas.envelope.id]!;
    expect(gasSummary).toMatchObject({ carriedInCents: 4000, allocatedCents: 0 });
  });

  it("renames a category by typing over its name, and adds a new envelope from an empty row", async () => {
    const { household, sheet } = await seed();
    sheet.type("Budget", sheet.findRow("Budget", "Category", "Groceries", 2)!.index, "Category", "Food at home", 2);
    sheet.addRow("Budget", { Group: "Goals", Category: "Hawaii trip", "Monthly target": 300, "Goal date": "2027-06-01" }, 2);
    await syncHouseholdSheet(env, household.id, sheet);

    const names = (await listCategories(db, household.id)).map((c) => c.name);
    expect(names).toContain("Food at home");
    expect(names).not.toContain("Groceries");
    const hawaii = await envelopeFor(household.id, "Hawaii trip");
    expect(hawaii.category.kind).toBe("savings");
    expect(hawaii.envelope).toMatchObject({ monthly_target_cents: 30000, target_date: "2027-06-01", group_name: "Goals" });
  });

  it("switches month from the month cell, and funds the month to plan from the checkbox", async () => {
    const { household, sheet } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    sheet.type("Budget", sheet.findRow("Budget", "Category", "Groceries", 2)!.index, "Monthly target", 500, 2);
    await syncHouseholdSheet(env, household.id, sheet);

    const [y, m] = month.split("-").map(Number);
    const next = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
    sheet.grid("Budget")[0]![2] = next;
    sheet.grid("Budget")[0]![5] = true;
    await syncHouseholdSheet(env, household.id, sheet);

    expect(sheet.grid("Budget")[0]![2]).toBe(next);
    expect(sheet.grid("Budget")[0]![5]).toBe(false);
    expect((await getSheetLink(db, household.id))!.view_month).toBe(next);
    expect((await getEnvelopeMonthSummariesForHousehold(db, household.id, next))[envelope.id]!.allocatedCents).toBe(50000);
  });
});

describe("Categories, Bills and Log", () => {
  it("archives from the Categories tab and adds an income category", async () => {
    const { household, sheet } = await seed();
    const dining = sheet.findRow("Categories", "Category", "Dining Out") ?? sheet.findRow("Categories", "Kind", "expense")!;
    const name = String(dining.cells.Category);
    sheet.type("Categories", dining.index, "Archived", true);
    sheet.addRow("Categories", { Category: "Bakery sales", Kind: "income" });
    await syncHouseholdSheet(env, household.id, sheet);
    const categories = await listCategories(db, household.id);
    expect(categories.find((c) => c.name === name)!.archived_at).not.toBeNull();
    expect(categories.find((c) => c.name === "Bakery sales")!.kind).toBe("income");
  });

  it("adds a recurring bill, then skips this month's occurrence", async () => {
    const { household, sheet } = await seed();
    const category = (await listCategories(db, household.id)).find((c) => c.kind === "expense" && !c.archived_at)!;
    sheet.addRow("Bills", { "Merchant contains": "XFINITY", Category: category.name, Frequency: "monthly", "Day of month": 28, "Usual amount": 95 });
    await syncHouseholdSheet(env, household.id, sheet);
    const pattern = (await listRecurringPatterns(db, household.id)).find((p) => p.merchant_pattern === "XFINITY")!;
    expect(pattern).toMatchObject({ status: "confirmed", day_of_month: 28, expected_amount_cents: 9500 });

    const occurrence = sheet.findRow("Bills This Month", "Bill", "XFINITY")!;
    expect(occurrence.cells.Amount).toBe(95);
    sheet.type("Bills This Month", occurrence.index, "Status", "skipped");
    await syncHouseholdSheet(env, household.id, sheet);
    expect(sheet.findRow("Bills This Month", "Bill", "XFINITY")!.cells.Status).toBe("skipped");
  });

  it("undoes a change when its Undo box is ticked, including one the bot made by text", async () => {
    const { household, nathan, sheet } = await seed();
    await runAgentTool(env, { householdId: household.id, userId: nathan.id }, "update_spending_plan", { category: "Groceries", monthly_target_dollars: 777 });
    await syncHouseholdSheet(env, household.id, sheet);
    const logRow = sheet.findRow("Log", "Who", "Nathan (text)")!;
    sheet.type("Log", logRow.index, "Undo", true);
    await syncHouseholdSheet(env, household.id, sheet);

    const { envelope } = await envelopeFor(household.id, "Groceries");
    expect(envelope.monthly_target_cents).not.toBe(77700);
    expect(String(sheet.findRow("Log", "id", logRow.cells.id!)!.cells["What changed"])).toMatch(/undone/);
  });
});

describe("guards", () => {
  it("never applies an edit twice when a pass dies after applying it and is retried", async () => {
    const { household, sheet, costco } = await seed();
    sheet.addRow("Transactions", { Date: today, Payee: "Lemonade stand", Amount: -4, Account: "Chase Checking" });
    sheet.type("Transactions", sheet.findRow("Transactions", "id", costco.id)!.index, "Split", "Groceries 120, Gifts 60");

    // Google rate-limits the final write: the pass fails after its edits landed.
    const realWrite = sheet.writeRanges.bind(sheet);
    sheet.writeRanges = async (data) => {
      if (data.length > 1) throw new Error("Google Sheets API 429: quota exceeded");
      return realWrite(data);
    };
    await expect(syncHouseholdSheet(env, household.id, sheet)).rejects.toThrow(/429/);
    sheet.writeRanges = realWrite;

    // The queue retries the pass.
    const retry = await syncHouseholdSheet(env, household.id, sheet);
    expect(retry.applied).toBe(0);
    const all = await listTransactions(db, household.id);
    expect(all.filter((t) => t.normalized_merchant === "Lemonade stand")).toHaveLength(1);
    expect(all.filter((t) => t.split_parent_id === costco.id)).toHaveLength(2);
    expect((await getSheetLink(db, household.id))!.last_error).toBeNull();
  });

  it("undoes a categorized cash charge from the Log tab", async () => {
    const { household, sheet } = await seed();
    sheet.addRow("Transactions", { Date: today, Payee: "Snow cones", Amount: -6, Category: "Dining Out", Account: "Chase Checking" });
    await syncHouseholdSheet(env, household.id, sheet);
    const logRow = sheet.findRow("Log", "Who", "Sheet")!;
    expect(String(logRow.cells["What changed"])).toMatch(/Snow cones/);
    sheet.type("Log", logRow.index, "Undo", true);
    const result = await syncHouseholdSheet(env, household.id, sheet);
    expect(result.failed).toBe(0);
    expect((await listTransactions(db, household.id)).some((t) => t.normalized_merchant === "Snow cones")).toBe(false);
  });

  it("refuses to split a charge that's already split", async () => {
    const { household, costco } = await seed();
    const ctx = { householdId: household.id, userId: null };
    const parts = [{ category: "Groceries", amount_dollars: 100 }, { category: "Gifts", amount_dollars: 80 }];
    expect((await runAgentTool(env, ctx, "split_transaction", { transaction_id: costco.id, parts })).isError).toBe(false);
    const again = await runAgentTool(env, ctx, "split_transaction", { transaction_id: costco.id, parts });
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already split/);
  });

  it("won't connect one sheet to two households", async () => {
    const { household } = await seed();
    const other = await createHousehold(db, { name: "Neighbors" });
    await expect(upsertSheetLink(db, other.id, `sheet-for-${household.id}`)).rejects.toThrow(/different household/);
  });

  it("a pass that outlived its lock doesn't release the next pass's lock", async () => {
    const { household } = await seed();
    const stale = await acquireSheetLock(db, household.id, -1); // already expired
    expect(stale).not.toBeNull();
    const fresh = await acquireSheetLock(db, household.id);
    expect(fresh).not.toBeNull();
    await releaseSheetLock(db, household.id, stale!);
    expect(await acquireSheetLock(db, household.id)).toBeNull();
    await releaseSheetLock(db, household.id, fresh!);
    expect(await acquireSheetLock(db, household.id)).not.toBeNull();
  });

  it("skips a pass while another holds the lock", async () => {
    const { household, sheet } = await seed();
    expect(await acquireSheetLock(db, household.id)).not.toBeNull();
    expect((await syncHouseholdSheet(env, household.id, sheet)).status).toBe("locked");
  });

  it("does nothing for a household with no sheet", async () => {
    const household = await createHousehold(db, { name: "No Sheet" });
    expect((await syncHouseholdSheet(env, household.id, new FakeSheets())).status).toBe("not_linked");
  });
});
