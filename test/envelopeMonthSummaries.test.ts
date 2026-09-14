import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { allocateToEnvelope, getEnvelopeMonthSummariesForHousehold, getEnvelopeMonthSummary, listEnvelopes } from "../src/db/envelopes";
import { applyCategorization, createTransaction } from "../src/db/transactions";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  const dining = categories.find((c) => c.name === "Dining Out")!;
  return { household, account, groceries, dining };
}

describe("getEnvelopeMonthSummariesForHousehold", () => {
  it("matches getEnvelopeMonthSummary exactly, per envelope, across a mix of allocated/spent/untouched envelopes", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const groceriesEnv = envelopes.find((e) => e.category_id === groceries.id)!;
    const diningEnv = envelopes.find((e) => e.category_id === dining.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: groceriesEnv.id, month: "2026-03", amountCents: 60000 });
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -4523,
      rawDescription: "WALMART",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "human" });
    // dining envelope: allocated but never spent — exercises the zero-spend branch.
    await allocateToEnvelope(db, household.id, { envelopeId: diningEnv.id, month: "2026-03", amountCents: 10000 });

    const bulk = await getEnvelopeMonthSummariesForHousehold(db, household.id, "2026-03");

    for (const envelope of envelopes) {
      const single = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-03");
      expect(bulk[envelope.id]).toEqual(single);
    }
  });

  it("carries a negative balance forward for an untouched next month, matching the single-envelope function", async () => {
    const { household, account, groceries } = await seedHousehold();
    const envelope = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: "2026-03", amountCents: 4000 });
    const overspend = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -8000,
      rawDescription: "BIG GROCERY RUN",
    });
    await applyCategorization(db, household.id, overspend.id, { categoryId: groceries.id, method: "human" });

    const bulkApril = await getEnvelopeMonthSummariesForHousehold(db, household.id, "2026-04");
    const singleApril = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-04");
    expect(bulkApril[envelope.id]).toEqual(singleApril);
    expect(bulkApril[envelope.id]!.balanceCents).toBe(-4000);
  });

  it("gives every envelope a zeroed entry even with no allocations or spend at all", async () => {
    const { household } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const bulk = await getEnvelopeMonthSummariesForHousehold(db, household.id, "2026-03");
    for (const envelope of envelopes) {
      expect(bulk[envelope.id]).toEqual({ month: "2026-03", allocatedCents: 0, spentCents: 0, balanceCents: 0, carriedInCents: 0 });
    }
  });
});
