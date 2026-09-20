import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { createHousehold } from "../src/db/households";
import { createConfirmedRecurringPattern, detectRecurringPatterns, dismissRecurringPattern, listRecurringPatterns } from "../src/db/recurringPatterns";
import { createTransaction } from "../src/db/transactions";
import { amountClusters, inferRecurringSeries, type DetectableTransaction } from "../src/lib/recurringDetection";

const TODAY = "2026-09-20";

function txn(merchant: string | null, amountCents: number, postedAt: string, raw = merchant ?? ""): DetectableTransaction {
  return { normalized_merchant: merchant, raw_description: raw, amount_cents: amountCents, posted_at: postedAt };
}

function series(merchant: string, amountCents: number, dates: string[]): DetectableTransaction[] {
  return dates.map((d) => txn(merchant, amountCents, d));
}

function infer(rows: DetectableTransaction[]) {
  return inferRecurringSeries(rows, { today: TODAY });
}

describe("inferRecurringSeries — cadences", () => {
  it("still finds a plain monthly subscription, including one month that posted late", () => {
    const [s, ...rest] = infer(series("NETFLIX", -1599, ["2026-06-15", "2026-07-15", "2026-08-17", "2026-09-15"]));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ merchantPattern: "NETFLIX", kind: "expense", frequency: "monthly", dayOfMonth: 15, sampleCount: 4, expectedAmountCents: 1599 });
  });

  it("finds a biweekly paycheck and stores it as twice a month on the two latest paydays", () => {
    const paydays = ["2026-06-05", "2026-06-19", "2026-07-03", "2026-07-17", "2026-07-31", "2026-08-14", "2026-08-28", "2026-09-11"];
    const [s] = infer(series("ACME PAYROLL", 250000, paydays));
    expect(s).toMatchObject({ kind: "income", frequency: "semimonthly", observedCadence: "biweekly", dayOfMonth: 11, dayOfMonth2: 28, sampleCount: 8, expectedAmountCents: 250000 });
    expect(s!.dayTolerance).toBeGreaterThanOrEqual(6);
  });

  it("finds a twice-a-month mortgage on the 1st and 15th", () => {
    const [s] = infer(series("ROCKET MORTGAGE", -95000, ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-08-03", "2026-08-15", "2026-09-01", "2026-09-15"]));
    expect(s).toMatchObject({ frequency: "semimonthly", observedCadence: "semimonthly", dayOfMonth: 1, dayOfMonth2: 15, sampleCount: 8 });
  });

  it("finds a weekly charge on a fixed weekday", () => {
    // Fridays.
    const [s] = infer(series("BRIGHT HORIZONS DAYCARE", -18500, ["2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"]));
    expect(s).toMatchObject({ frequency: "weekly", dayOfWeek: 5, sampleCount: 7 });
  });
});

describe("inferRecurringSeries — tolerance", () => {
  it("keeps a utility whose due date drifts beyond four days", () => {
    const [s] = infer(series("ROCKY MOUNTAIN POWER", -18000, ["2026-06-03", "2026-07-09", "2026-08-06", "2026-09-12"]));
    expect(s).toMatchObject({ frequency: "monthly", sampleCount: 4 });
    expect(s!.dayTolerance).toBeGreaterThanOrEqual(5);
  });

  it("keeps a variable-amount utility as one series", () => {
    const rows = [txn("LEHI CITY", -18000, "2026-06-20"), txn("LEHI CITY", -20500, "2026-07-21"), txn("LEHI CITY", -24000, "2026-08-20"), txn("LEHI CITY", -26500, "2026-09-19")];
    expect(infer(rows)).toHaveLength(1);
    expect(infer(rows)[0]).toMatchObject({ dayOfMonth: 20, sampleCount: 4, expectedAmountCents: 24000 });
  });

  it("does not let one stray charge from the same merchant sink the series", () => {
    const rows = [...series("NETFLIX", -1599, ["2026-06-15", "2026-07-15", "2026-08-15", "2026-09-15"]), txn("NETFLIX", -1599, "2026-07-28")];
    const [s] = infer(rows);
    expect(s).toMatchObject({ frequency: "monthly", dayOfMonth: 15, sampleCount: 4 });
  });

  it("finds a subscription buried among one-off purchases at the same merchant", () => {
    const rows = [
      ...series("AMAZON", -1499, ["2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"]),
      txn("AMAZON", -4312, "2026-07-22"),
      txn("AMAZON", -899, "2026-08-02"),
      txn("AMAZON", -12750, "2026-08-27"),
      txn("AMAZON", -2310, "2026-09-03"),
    ];
    const [s] = infer(rows);
    expect(s).toMatchObject({ merchantPattern: "AMAZON", frequency: "monthly", dayOfMonth: 10, sampleCount: 4, expectedAmountCents: 1499 });
  });
});

describe("inferRecurringSeries — grouping", () => {
  it("merges the same bill when Plaid's merchant name comes and goes", () => {
    const rows = [txn("SPOTIFY", -1099, "2026-06-20"), txn("SPOTIFY USA", -1099, "2026-07-20", "SPOTIFY USA 8887784875 NY"), txn("SPOTIFY", -1099, "2026-08-20"), txn("SPOTIFY", -1099, "2026-09-20")];
    const found = infer(rows);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ merchantPattern: "SPOTIFY", sampleCount: 4 });
  });

  it("merges charges whose descriptors carry a different reference token each month", () => {
    const rows = [
      txn("AMAZON PRIME*2K4L9 AMZN.COM/BILL", -1499, "2026-06-12"),
      txn("AMAZON PRIME*7HH3Q AMZN.COM/BILL", -1499, "2026-07-12"),
      txn("AMAZON PRIME*QW0P1 AMZN.COM/BILL", -1499, "2026-08-12"),
      txn("AMAZON PRIME*8Z2ZZ AMZN.COM/BILL", -1499, "2026-09-12"),
    ];
    const found = infer(rows);
    expect(found).toHaveLength(1);
    expect(found[0]!.merchantPattern.startsWith("AMAZON PRIME")).toBe(true);
    expect(found[0]!.sampleCount).toBe(4);
  });

  it("skips merchants the caller says are covered", () => {
    const rows = series("NETFLIX", -1599, ["2026-07-15", "2026-08-15", "2026-09-15"]);
    expect(inferRecurringSeries(rows, { today: TODAY, isCovered: (m) => m === "NETFLIX" })).toEqual([]);
  });
});

describe("inferRecurringSeries — rejections", () => {
  it("ignores a store visited every few days", () => {
    const dates = ["2026-08-01", "2026-08-04", "2026-08-09", "2026-08-13", "2026-08-16", "2026-08-22", "2026-08-25", "2026-09-01", "2026-09-06", "2026-09-10", "2026-09-14", "2026-09-18"];
    expect(infer(dates.map((d, i) => txn("SMITHS", -4000 - i * 700, d)))).toEqual([]);
  });

  it("ignores a series that stopped months ago", () => {
    expect(infer(series("HULU", -1299, ["2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05"]))).toEqual([]);
  });

  it("ignores a single charge and a same-month pair", () => {
    expect(infer(series("ONE OFF", -5000, ["2026-09-01"]))).toEqual([]);
    expect(infer(series("TWICE", -5000, ["2026-09-01", "2026-09-03"]))).toEqual([]);
  });
});

describe("amountClusters", () => {
  it("chains gradual drift into one cluster and splits distinct price points", () => {
    const rows = [txn("X", -18000, "a"), txn("X", -20500, "b"), txn("X", -24000, "c"), txn("X", -1499, "d"), txn("X", -1499, "e"), txn("X", -9900, "f")];
    const clusters = amountClusters(rows).map((c) => c.map((r) => Math.abs(r.amount_cents)));
    expect(clusters).toEqual([[1499, 1499], [9900], [18000, 20500, 24000]]);
  });
});

describe("detectRecurringPatterns (database)", () => {
  const db = env.DB;

  async function seed() {
    const household = await createHousehold(db, { name: "Curtis Clan" });
    const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
    return { household, account };
  }

  async function post(householdId: string, accountId: string, merchant: string, amountCents: number, dates: string[], raw = merchant) {
    for (const [i, postedAt] of dates.entries()) {
      await createTransaction(db, householdId, { accountId, postedAt, amountCents, rawDescription: raw, normalizedMerchant: merchant, plaidTxnId: `${merchant}-${amountCents}-${i}-${postedAt}` });
    }
  }

  it("suggests a biweekly paycheck and a monthly bill, once, and honours substring-covered merchants", async () => {
    const { household, account } = await seed();
    await post(household.id, account.id, "ACME PAYROLL", 250000, ["2026-06-05", "2026-06-19", "2026-07-03", "2026-07-17", "2026-07-31", "2026-08-14", "2026-08-28", "2026-09-11"]);
    await post(household.id, account.id, "ROCKY MOUNTAIN POWER", -18000, ["2026-06-03", "2026-07-09", "2026-08-06", "2026-09-12"]);
    await post(household.id, account.id, "NETFLIX.COM", -1599, ["2026-07-15", "2026-08-15", "2026-09-15"]);
    const categories = await listCategories(db, household.id);
    const expense = categories.find((c) => c.kind === "expense")!;
    // A confirmed pattern typed by hand with a shorter merchant string must
    // block the detector's canonical key for the same merchant.
    await createConfirmedRecurringPattern(db, household.id, { categoryId: expense.id, merchantPattern: "NETFLIX", kind: "expense", dayOfMonth: 15 });

    const created = await detectRecurringPatterns(db, household.id, TODAY);
    expect(created.map((p) => [p.merchant_pattern, p.kind, p.frequency, p.status])).toEqual([
      ["ACME PAYROLL", "income", "semimonthly", "suggested"],
      ["ROCKY MOUNTAIN POWER", "expense", "monthly", "suggested"],
    ]);

    // Idempotent: running again re-suggests nothing, and dismissing sticks.
    expect(await detectRecurringPatterns(db, household.id, TODAY)).toEqual([]);
    await dismissRecurringPattern(db, household.id, created[1]!.id);
    expect(await detectRecurringPatterns(db, household.id, TODAY)).toEqual([]);
    const all = await listRecurringPatterns(db, household.id);
    expect(all).toHaveLength(3);
  });
});
