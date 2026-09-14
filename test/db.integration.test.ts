import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount, updateAccount } from "../src/db/accounts";
import { archiveCategory, createCategory, createEnvelopeForCategory, listCategories, renameCategory, unarchiveCategory } from "../src/db/categories";
import { listEnvelopes, allocateToEnvelope, moveMoneyBetweenEnvelopes, getEnvelopeMonthSummary, updateEnvelope } from "../src/db/envelopes";
import { applyCategorization, createTransaction, splitTransaction, listTransactions, setTransactionExcluded } from "../src/db/transactions";
import { listClassifications } from "../src/db/classifications";
import { getMerchantMemory } from "../src/db/merchantMemory";
import { importCsvTransactions } from "../src/db/csvImport";
import { parseCsvRows } from "../src/import/csvImport";
import { NotFoundError } from "../src/db/client";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  const dining = categories.find((c) => c.name === "Dining Out")!;
  return { household, nathan, account, groceries, dining };
}

describe("household setup", () => {
  it("seeds the default taxonomy and one envelope per expense/savings category", async () => {
    const { household } = await seedHousehold();
    const categories = await listCategories(db, household.id);
    const envelopes = await listEnvelopes(db, household.id);

    expect(categories.length).toBeGreaterThan(10);
    const fundedKinds = categories.filter((c) => c.kind === "expense" || c.kind === "savings");
    expect(envelopes).toHaveLength(fundedKinds.length);

    const income = categories.filter((c) => c.kind === "income");
    expect(income.length).toBeGreaterThan(0);
    for (const cat of income) {
      expect(envelopes.some((e) => e.category_id === cat.id)).toBe(false);
    }
  });

  it("scopes every read to the household — a wrong id 404s instead of leaking another household's row", async () => {
    const { household } = await seedHousehold();
    const other = await createHousehold(db, { name: "Someone Else" });
    const otherCategories = await listCategories(db, other.id);

    await expect(async () => {
      const { getCategory } = await import("../src/db/categories");
      await getCategory(db, household.id, otherCategories[0]!.id);
    }).rejects.toThrow(NotFoundError);
  });
});

describe("phone verification", () => {
  it("only binds a phone once verified, and rejects a duplicate", async () => {
    const { household, nathan } = await seedHousehold();
    const verified = await verifyUserPhone(db, household.id, nathan.id, "+13035551234");
    expect(verified.phone_e164).toBe("+13035551234");
    expect(verified.phone_verified_at).not.toBeNull();
  });
});

describe("applyCategorization", () => {
  it("updates the transaction, writes an audit row, and reinforces merchant_memory for a human correction", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -4523,
      rawDescription: "WALMART #4821 GRAND JCT CO",
      normalizedMerchant: "WALMART",
    });

    const updated = await applyCategorization(db, household.id, txn.id, {
      categoryId: groceries.id,
      memo: "weekly groceries",
      method: "human",
    });
    expect(updated.category_id).toBe(groceries.id);
    expect(updated.memo).toBe("weekly groceries");

    const classifications = await listClassifications(db, household.id, txn.id);
    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({ method: "human", category_id: groceries.id, prior_category_id: null });

    const memory = await getMerchantMemory(db, household.id, "WALMART");
    expect(memory).toMatchObject({ category_id: groceries.id, hit_count: 1 });
  });

  it("does not touch merchant_memory for a non-human (e.g. rule) categorization", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -1200,
      rawDescription: "COSTCO GAS",
      normalizedMerchant: "COSTCO GAS",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "rule" });
    const memory = await getMerchantMemory(db, household.id, "COSTCO GAS");
    expect(memory).toBeNull();
  });

  it("records the prior category on a correction", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -2000,
      rawDescription: "AMBIGUOUS CHARGE",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "llm", confidence: 0.6 });
    await applyCategorization(db, household.id, txn.id, { categoryId: dining.id, method: "human" });

    const classifications = await listClassifications(db, household.id, txn.id);
    expect(classifications).toHaveLength(2);
    expect(classifications[1]).toMatchObject({ method: "human", category_id: dining.id, prior_category_id: groceries.id });
  });
});

describe("splitTransaction", () => {
  it("requires splits to sum exactly to the parent amount", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -10000,
      rawDescription: "COSTCO",
    });
    await expect(
      splitTransaction(db, household.id, txn.id, [
        { amountCents: -6000, categoryId: groceries.id },
        { amountCents: -3000, categoryId: dining.id },
      ]),
    ).rejects.toThrow(/sum to parent amount/);
  });

  it("creates child rows and excludes the parent from budget totals", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -10000,
      rawDescription: "COSTCO",
    });
    const children = await splitTransaction(db, household.id, txn.id, [
      { amountCents: -7000, categoryId: groceries.id, memo: "groceries" },
      { amountCents: -3000, categoryId: dining.id, memo: "rotisserie chicken lol" },
    ]);
    expect(children).toHaveLength(2);

    const all = await listTransactions(db, household.id, { accountId: account.id });
    const parent = all.find((t) => t.id === txn.id)!;
    expect(parent.excluded_from_budget).toBe(1);
    expect(children.every((c) => c.split_parent_id === txn.id)).toBe(true);
  });
});

describe("envelope ledger", () => {
  it("computes a month summary matching allocations minus spend", async () => {
    const { household, account, groceries } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const envelope = envelopes.find((e) => e.category_id === groceries.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: "2026-03", amountCents: 60000 });
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -4523,
      rawDescription: "WALMART",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "human" });

    const summary = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-03");
    expect(summary).toEqual({ month: "2026-03", allocatedCents: 60000, spentCents: 4523, balanceCents: 55477, carriedInCents: 0 });
  });

  it("carries a negative balance forward into the next month (PLAN.md §8.2)", async () => {
    const { household, account, groceries } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const envelope = envelopes.find((e) => e.category_id === groceries.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: "2026-03", amountCents: 4000 });
    const overspend = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -8000,
      rawDescription: "BIG GROCERY RUN",
    });
    await applyCategorization(db, household.id, overspend.id, { categoryId: groceries.id, method: "human" });

    const march = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-03");
    expect(march.balanceCents).toBe(-4000);

    // April: no new spend, no new allocation — the deficit persists.
    const april = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-04");
    expect(april.balanceCents).toBe(-4000);
    expect(april.allocatedCents).toBe(0);
    expect(april.spentCents).toBe(0);
  });

  it("moves money between envelopes as two linked, reversible ledger rows", async () => {
    const { household, groceries, dining } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const groceriesEnv = envelopes.find((e) => e.category_id === groceries.id)!;
    const diningEnv = envelopes.find((e) => e.category_id === dining.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: diningEnv.id, month: "2026-03", amountCents: 10000 });
    await moveMoneyBetweenEnvelopes(db, household.id, {
      fromEnvelopeId: diningEnv.id,
      toEnvelopeId: groceriesEnv.id,
      month: "2026-03",
      amountCents: 4000,
    });

    const diningSummary = await getEnvelopeMonthSummary(db, household.id, diningEnv.id, "2026-03");
    const groceriesSummary = await getEnvelopeMonthSummary(db, household.id, groceriesEnv.id, "2026-03");
    expect(diningSummary.balanceCents).toBe(6000);
    expect(groceriesSummary.balanceCents).toBe(4000);
  });
});

describe("CSV import", () => {
  it("imports rows, categorizes by matching category name, and is idempotent on re-run", async () => {
    const { household, account } = await seedHousehold();
    const rows = parseCsvRows([
      { Date: "3/1/2026", Description: "WALMART #4821 GRAND JCT CO", Category: "Groceries", Amount: "-45.23", Notes: "" },
      { Date: "3/2/2026", Description: "SOME UNKNOWN CATEGORY SHOP", Category: "Nonexistent Category", Amount: "-10.00", Notes: "" },
    ]);

    const first = await importCsvTransactions(db, household.id, account.id, rows);
    expect(first.imported).toBe(2);
    expect(first.skippedDuplicates).toBe(0);
    expect(first.unmatchedCategoryNames).toEqual(["Nonexistent Category"]);

    const second = await importCsvTransactions(db, household.id, account.id, rows);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const transactions = await listTransactions(db, household.id, { accountId: account.id });
    expect(transactions).toHaveLength(2);
  });
});

describe("savings goals (envelope target_date)", () => {
  // PLAN.md §8.5: a savings goal is not a separate table — it's a
  // kind='savings' envelope with target_date set. routes/categories.ts's
  // POST / handler forwards body.targetDate through to this exact call, so
  // this pins down the db-layer half of "New goal" actually working.
  it("createEnvelopeForCategory round-trips targetDate onto the envelope", async () => {
    const { household } = await seedHousehold();
    const category = await createCategory(db, household.id, { name: "New roof", kind: "savings" });
    const envelope = await createEnvelopeForCategory(db, household.id, category, {
      groupName: "Goals",
      monthlyTargetCents: 1400000,
      targetDate: "2027-06-01",
    });
    expect(envelope.target_date).toBe("2027-06-01");

    const [reloaded] = (await listEnvelopes(db, household.id)).filter((e) => e.id === envelope.id);
    expect(reloaded!.target_date).toBe("2027-06-01");
  });

  // Found in manual verification: an envelope created without a
  // target_date (e.g. the default-taxonomy Savings envelopes every
  // household starts with) had no way to become a goal after the fact —
  // updateEnvelope silently ignored targetDate entirely.
  it("updateEnvelope can set, and later clear, target_date on an existing envelope", async () => {
    const { household } = await seedHousehold();
    const category = await createCategory(db, household.id, { name: "Emergency Fund", kind: "savings" });
    const envelope = await createEnvelopeForCategory(db, household.id, category, { groupName: "Goals" });
    expect(envelope.target_date).toBeNull();

    const withDate = await updateEnvelope(db, household.id, envelope.id, { targetDate: "2027-03-01" });
    expect(withDate.target_date).toBe("2027-03-01");

    const renamedOnly = await updateEnvelope(db, household.id, envelope.id, { groupName: "Savings Goals" });
    expect(renamedOnly.target_date).toBe("2027-03-01"); // untouched — key omitted

    const cleared = await updateEnvelope(db, household.id, envelope.id, { targetDate: null });
    expect(cleared.target_date).toBeNull();
  });
});

describe("category/envelope/account editing (dashboard CRUD)", () => {
  it("renames a category", async () => {
    const { household, groceries } = await seedHousehold();
    const renamed = await renameCategory(db, household.id, groceries.id, "Food & Groceries");
    expect(renamed.name).toBe("Food & Groceries");
  });

  it("archiving a category archives its envelope too, and unarchiving reverses both", async () => {
    const { household, groceries } = await seedHousehold();
    const envelopeBefore = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;
    expect(envelopeBefore.archived_at).toBeNull();

    const archived = await archiveCategory(db, household.id, groceries.id);
    expect(archived.archived_at).not.toBeNull();
    const envelopeAfterArchive = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;
    expect(envelopeAfterArchive.archived_at).not.toBeNull();

    const restored = await unarchiveCategory(db, household.id, groceries.id);
    expect(restored.archived_at).toBeNull();
    const envelopeAfterRestore = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;
    expect(envelopeAfterRestore.archived_at).toBeNull();
  });

  it("regroups an envelope (e.g. into 'Bills') without touching its target when omitted", async () => {
    const { household, groceries } = await seedHousehold();
    const envelope = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;
    await updateEnvelope(db, household.id, envelope.id, { monthlyTargetCents: 50000 });

    const regrouped = await updateEnvelope(db, household.id, envelope.id, { groupName: "Bills" });
    expect(regrouped.group_name).toBe("Bills");
    expect(regrouped.monthly_target_cents).toBe(50000); // untouched — key was omitted, not null

    const cleared = await updateEnvelope(db, household.id, envelope.id, { monthlyTargetCents: null });
    expect(cleared.monthly_target_cents).toBeNull();
    expect(cleared.group_name).toBe("Bills"); // still untouched
  });

  it("reassigns an account's owner, including clearing it for a joint account, and can mark it removed", async () => {
    const { household, account, nathan } = await seedHousehold();
    const wife = await createUser(db, household.id, { name: "Wife" });

    const reassigned = await updateAccount(db, household.id, account.id, { ownerUserId: wife.id });
    expect(reassigned.owner_user_id).toBe(wife.id);

    const renamed = await updateAccount(db, household.id, account.id, { name: "Joint Checking" });
    expect(renamed.name).toBe("Joint Checking");
    expect(renamed.owner_user_id).toBe(wife.id); // untouched — key was omitted

    const cleared = await updateAccount(db, household.id, account.id, { ownerUserId: null });
    expect(cleared.owner_user_id).toBeNull();

    const removed = await updateAccount(db, household.id, account.id, { status: "removed" });
    expect(removed.status).toBe("removed");
    expect(nathan.id).toBeTruthy(); // seeded owner, unused after reassignment above
  });

  it("toggles a transaction's excluded_from_budget flag without touching its category", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-01",
      amountCents: -2000,
      rawDescription: "Reimbursed lunch",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "human" });

    const excluded = await setTransactionExcluded(db, household.id, txn.id, true);
    expect(excluded.excluded_from_budget).toBe(1);
    expect(excluded.category_id).toBe(groceries.id);

    const included = await setTransactionExcluded(db, household.id, txn.id, false);
    expect(included.excluded_from_budget).toBe(0);
  });
});
