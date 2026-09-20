import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { applyCategorization, createTransaction } from "../src/db/transactions";
import { createConfirmedRecurringPattern, updateRecurringPattern } from "../src/db/recurringPatterns";
import type { RecurringPattern } from "../src/types";
import {
  dueDatesInMonth,
  generateOccurrences,
  listOccurrences,
  reconcileOccurrences,
  resolveOccurrenceAmountCents,
  unlinkOccurrence,
  updateOccurrence,
} from "../src/envelopes/occurrences";

const db = env.DB;

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  const categories = await listCategories(db, household.id);
  const paycheck = categories.find((c) => c.kind === "income")!;
  const utilities = categories.find((c) => c.kind === "expense")!;
  return { household, account, paycheck, utilities };
}

/** A schedule-shaped stub for the pure date math, which never touches the DB. */
function pattern(overrides: Partial<RecurringPattern>): RecurringPattern {
  return {
    id: "rpat_test",
    household_id: "hh_test",
    category_id: "cat_test",
    merchant_pattern: "REDO PAYROLL",
    kind: "income",
    frequency: "monthly",
    day_of_month: 4,
    day_of_month_2: null,
    day_of_week: null,
    day_tolerance: 4,
    status: "confirmed",
    sample_count: 3,
    expected_amount_cents: 193501,
    ended_at: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("dueDatesInMonth", () => {
  it("expands a monthly series to its one day", () => {
    expect(dueDatesInMonth(pattern({ day_of_month: 4 }), "2026-09")).toEqual(["2026-09-04"]);
  });

  it("clamps a 31st-of-the-month bill into a short month instead of dropping it", () => {
    expect(dueDatesInMonth(pattern({ day_of_month: 31 }), "2026-02")).toEqual(["2026-02-28"]);
    expect(dueDatesInMonth(pattern({ day_of_month: 31 }), "2024-02")).toEqual(["2024-02-29"]);
    expect(dueDatesInMonth(pattern({ day_of_month: 31 }), "2026-04")).toEqual(["2026-04-30"]);
  });

  it("expands a semimonthly series to both days, in order", () => {
    expect(dueDatesInMonth(pattern({ frequency: "semimonthly", day_of_month: 20, day_of_month_2: 4 }), "2026-09")).toEqual([
      "2026-09-04",
      "2026-09-20",
    ]);
  });

  it("collapses a semimonthly series whose two days clamp onto the same date", () => {
    expect(dueDatesInMonth(pattern({ frequency: "semimonthly", day_of_month: 30, day_of_month_2: 31 }), "2026-02")).toEqual(["2026-02-28"]);
  });

  it("expands a weekly series to every matching weekday in the month", () => {
    // Fridays in September 2026: the 4th, 11th, 18th, 25th.
    expect(dueDatesInMonth(pattern({ frequency: "weekly", day_of_week: 5 }), "2026-09")).toEqual([
      "2026-09-04",
      "2026-09-11",
      "2026-09-18",
      "2026-09-25",
    ]);
  });
});

describe("resolveOccurrenceAmountCents", () => {
  const series = { expected_amount_cents: 20000 };

  it("prefers this month's override over everything else", () => {
    expect(resolveOccurrenceAmountCents({ amount_cents: 19500, amount_override_cents: 24000 }, series)).toBe(24000);
  });

  it("falls back to the occurrence's own amount, then the series', then null", () => {
    expect(resolveOccurrenceAmountCents({ amount_cents: 19500, amount_override_cents: null }, series)).toBe(19500);
    expect(resolveOccurrenceAmountCents({ amount_cents: null, amount_override_cents: null }, series)).toBe(20000);
    expect(resolveOccurrenceAmountCents({ amount_cents: null, amount_override_cents: null }, { expected_amount_cents: null })).toBeNull();
  });

  it("keeps a zero override rather than treating it as absent", () => {
    expect(resolveOccurrenceAmountCents({ amount_cents: 19500, amount_override_cents: 0 }, series)).toBe(0);
  });
});

describe("generateOccurrences", () => {
  it("materializes each confirmed series' month, seeded with the series' expected amount", async () => {
    const { household, paycheck } = await seed();
    await createConfirmedRecurringPattern(db, household.id, {
      categoryId: paycheck.id,
      merchantPattern: "REDO PAYROLL",
      kind: "income",
      frequency: "semimonthly",
      dayOfMonth: 4,
      dayOfMonth2: 20,
      expectedAmountCents: 193501,
    });

    const created = await generateOccurrences(db, household.id, "2026-09");
    expect(created.map((o) => o.due_date)).toEqual(["2026-09-04", "2026-09-20"]);
    expect(created.every((o) => o.status === "upcoming")).toBe(true);
    expect(created.every((o) => o.amount_cents === 193501)).toBe(true);
    // scheduled_date starts equal to due_date and is what regeneration keys off.
    expect(created.map((o) => o.scheduled_date)).toEqual(["2026-09-04", "2026-09-20"]);
  });

  it("is idempotent — a second run creates nothing", async () => {
    const { household, paycheck } = await seed();
    await createConfirmedRecurringPattern(db, household.id, {
      categoryId: paycheck.id,
      merchantPattern: "REDO PAYROLL",
      kind: "income",
      dayOfMonth: 4,
    });
    expect((await generateOccurrences(db, household.id, "2026-09")).length).toBe(1);
    expect((await generateOccurrences(db, household.id, "2026-09")).length).toBe(0);
  });

  it("stops projecting past a series' end date but keeps what came before it", async () => {
    const { household, utilities } = await seed();
    await createConfirmedRecurringPattern(db, household.id, {
      categoryId: utilities.id,
      merchantPattern: "OLD GYM",
      kind: "expense",
      frequency: "semimonthly",
      dayOfMonth: 4,
      dayOfMonth2: 20,
    });
    await db.prepare(`UPDATE recurring_pattern SET ended_at = '2026-09-10' WHERE household_id = ?`).bind(household.id).run();

    const created = await generateOccurrences(db, household.id, "2026-09");
    expect(created.map((o) => o.due_date)).toEqual(["2026-09-04"]);
  });

  it("does not re-create an occurrence someone moved to another day", async () => {
    const { household, utilities } = await seed();
    await createConfirmedRecurringPattern(db, household.id, { categoryId: utilities.id, merchantPattern: "RENT", kind: "expense", dayOfMonth: 1 });
    const [occurrence] = await generateOccurrences(db, household.id, "2026-09");

    await updateOccurrence(db, household.id, occurrence!.id, { dueDate: "2026-09-03" });
    expect((await generateOccurrences(db, household.id, "2026-09")).length).toBe(0);
  });

  it("keeps a skip through a regeneration", async () => {
    const { household, utilities } = await seed();
    await createConfirmedRecurringPattern(db, household.id, { categoryId: utilities.id, merchantPattern: "RENT", kind: "expense", dayOfMonth: 1 });
    const [occurrence] = await generateOccurrences(db, household.id, "2026-09");
    await updateOccurrence(db, household.id, occurrence!.id, { status: "skipped" });

    await generateOccurrences(db, household.id, "2026-09");
    const after = await reconcileOccurrences(db, household.id, "2026-09");
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("skipped");
  });
});

describe("reconcileOccurrences", () => {
  async function seedTwiceMonthlyPaycheck() {
    const { household, account, paycheck } = await seed();
    await createConfirmedRecurringPattern(db, household.id, {
      categoryId: paycheck.id,
      merchantPattern: "REDO PAYROLL",
      kind: "income",
      frequency: "semimonthly",
      dayOfMonth: 4,
      dayOfMonth2: 20,
      expectedAmountCents: 193501,
    });
    return { household, account, paycheck };
  }

  async function postIncome(householdId: string, accountId: string, categoryId: string, postedAt: string, amountCents: number) {
    const txn = await createTransaction(db, householdId, { accountId, postedAt, amountCents, rawDescription: "REDO PAYROLL PPD ID:" });
    await applyCategorization(db, householdId, txn.id, { categoryId, method: "human" });
    return txn;
  }

  it("marks the paid occurrence Received and leaves the later one Upcoming", async () => {
    const { household, account, paycheck } = await seedTwiceMonthlyPaycheck();
    await postIncome(household.id, account.id, paycheck.id, "2026-09-04", 193501);

    const occurrences = await listOccurrences(db, household.id, "2026-09");
    const [first, second] = occurrences;
    expect(first!.status).toBe("matched");
    expect(second!.status).toBe("upcoming");
  });

  it("hangs two deposits on two different occurrences, nearest first", async () => {
    const { household, account, paycheck } = await seedTwiceMonthlyPaycheck();
    await postIncome(household.id, account.id, paycheck.id, "2026-09-04", 193501);
    await postIncome(household.id, account.id, paycheck.id, "2026-09-21", 190000);

    const occurrences = await listOccurrences(db, household.id, "2026-09");
    expect(occurrences.map((o) => o.status)).toEqual(["matched", "matched"]);
    expect(new Set(occurrences.map((o) => o.matched_transaction_id)).size).toBe(2);
    // A matched occurrence shows what actually posted, not the projection.
    expect(occurrences[1]!.amount_cents).toBe(190000);
  });

  it("ignores a transaction further from the due date than the series' tolerance", async () => {
    const { household, account, paycheck } = await seedTwiceMonthlyPaycheck();
    await postIncome(household.id, account.id, paycheck.id, "2026-09-12", 193501);

    const occurrences = await listOccurrences(db, household.id, "2026-09");
    expect(occurrences.every((o) => o.status === "upcoming")).toBe(true);
  });

  it("keeps an unlinked pair apart on the next reconcile", async () => {
    const { household, account, paycheck } = await seedTwiceMonthlyPaycheck();
    await postIncome(household.id, account.id, paycheck.id, "2026-09-04", 193501);
    const [first] = await listOccurrences(db, household.id, "2026-09");
    expect(first!.status).toBe("matched");

    await unlinkOccurrence(db, household.id, first!.id);
    const after = await listOccurrences(db, household.id, "2026-09");
    expect(after[0]!.status).toBe("upcoming");
    expect(after[0]!.matched_transaction_id).toBeNull();
  });

  it("returns a matched occurrence to Upcoming when its transaction is recategorized away", async () => {
    const { household, account, paycheck } = await seedTwiceMonthlyPaycheck();
    const txn = await postIncome(household.id, account.id, paycheck.id, "2026-09-04", 193501);
    expect((await listOccurrences(db, household.id, "2026-09"))[0]!.status).toBe("matched");

    const categories = await listCategories(db, household.id);
    const other = categories.find((c) => c.kind === "income" && c.id !== paycheck.id) ?? categories.find((c) => c.kind === "expense")!;
    await applyCategorization(db, household.id, txn.id, { categoryId: other.id, method: "human" });

    expect((await listOccurrences(db, household.id, "2026-09"))[0]!.status).toBe("upcoming");
  });
});

describe("updateRecurringPattern — editing a series", () => {
  async function seedSeries() {
    const { household, utilities } = await seed();
    const created = await createConfirmedRecurringPattern(db, household.id, {
      categoryId: utilities.id,
      merchantPattern: "CITY WATER",
      kind: "expense",
      dayOfMonth: 12,
      expectedAmountCents: 8500,
    });
    return { household, utilities, created };
  }

  it("ends a series without touching what it already matched, and resumes it again", async () => {
    const { household, created } = await seedSeries();
    await generateOccurrences(db, household.id, "2026-09");

    const ended = await updateRecurringPattern(db, household.id, created.id, { endedAt: "2026-09-30" });
    expect(ended.ended_at).toBe("2026-09-30");
    // The occurrence on or before the end date is still there.
    expect((await reconcileOccurrences(db, household.id, "2026-09")).length).toBe(1);
    // And nothing new is projected for a later month.
    expect((await generateOccurrences(db, household.id, "2026-10")).length).toBe(0);
    // An unpaid square that was already projected past the end date goes
    // with it — "stop after this month" means the calendar clears out.
    await updateRecurringPattern(db, household.id, created.id, { endedAt: "2026-09-01" });
    expect((await reconcileOccurrences(db, household.id, "2026-09")).length).toBe(0);

    const resumed = await updateRecurringPattern(db, household.id, created.id, { endedAt: null });
    expect(resumed.ended_at).toBeNull();
    expect((await generateOccurrences(db, household.id, "2026-10")).length).toBe(1);
  });

  it("changes the expected amount, and clears it back to nothing", async () => {
    const { household, created } = await seedSeries();
    expect((await updateRecurringPattern(db, household.id, created.id, { expectedAmountCents: 9000 })).expected_amount_cents).toBe(9000);
    expect((await updateRecurringPattern(db, household.id, created.id, { expectedAmountCents: null })).expected_amount_cents).toBeNull();
    // An omitted field is left alone rather than cleared.
    expect((await updateRecurringPattern(db, household.id, created.id, { expectedAmountCents: 9000 })).expected_amount_cents).toBe(9000);
    expect((await updateRecurringPattern(db, household.id, created.id, { merchantPattern: "CITY WATER DEPT" })).expected_amount_cents).toBe(9000);
  });

  it("re-points a series at a different category", async () => {
    const { household, created } = await seedSeries();
    const categories = await listCategories(db, household.id);
    const other = categories.find((c) => c.kind === "expense" && c.id !== created.category_id)!;
    expect((await updateRecurringPattern(db, household.id, created.id, { categoryId: other.id })).category_id).toBe(other.id);
  });
});

describe("realignOccurrences — an edited series reaches the squares already on the calendar", () => {
  async function seedSeries() {
    const { household, account, utilities } = await seed();
    const created = await createConfirmedRecurringPattern(db, household.id, {
      categoryId: utilities.id,
      merchantPattern: "ROCKY MTN POWER",
      kind: "expense",
      dayOfMonth: 5,
      expectedAmountCents: 10_000,
    });
    return { household, account, utilities, created };
  }

  it("re-seeds an upcoming occurrence with the new expected amount", async () => {
    const { household, created } = await seedSeries();
    const [before] = await generateOccurrences(db, household.id, "2099-03");
    expect(before!.amount_cents).toBe(10_000);

    await updateRecurringPattern(db, household.id, created.id, { expectedAmountCents: 15_000 });
    const after = await listOccurrences(db, household.id, "2099-03");
    expect(after).toHaveLength(1);
    expect(after[0]!.amount_cents).toBe(15_000);
    expect(resolveOccurrenceAmountCents(after[0]!, { expected_amount_cents: 15_000 })).toBe(15_000);
  });

  it("moves the square when the day changes instead of leaving both", async () => {
    const { household, created } = await seedSeries();
    await generateOccurrences(db, household.id, "2099-03");

    await updateRecurringPattern(db, household.id, created.id, { dayOfMonth: 20 });
    const after = await listOccurrences(db, household.id, "2099-03");
    expect(after.map((o) => o.due_date)).toEqual(["2099-03-20"]);
  });

  it("leaves a square the person edited by hand, a skip, and a match alone", async () => {
    const { household, account, utilities, created } = await seedSeries();
    const [march] = await generateOccurrences(db, household.id, "2099-03");
    const [april] = await generateOccurrences(db, household.id, "2099-04");
    const [may] = await generateOccurrences(db, household.id, "2099-05");
    await updateOccurrence(db, household.id, march!.id, { amountOverrideCents: 12_345 });
    await updateOccurrence(db, household.id, april!.id, { status: "skipped" });
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2099-05-05", amountCents: -9_950, rawDescription: "ROCKY MTN POWER" });
    await applyCategorization(db, household.id, txn.id, { categoryId: utilities.id, method: "human" });
    expect((await listOccurrences(db, household.id, "2099-05"))[0]!.status).toBe("matched");

    await updateRecurringPattern(db, household.id, created.id, { dayOfMonth: 20, expectedAmountCents: 15_000 });

    const marchAfter = await listOccurrences(db, household.id, "2099-03");
    expect(marchAfter.map((o) => [o.due_date, o.amount_override_cents, o.amount_cents])).toEqual([
      ["2099-03-05", 12_345, 15_000],
      ["2099-03-20", null, 15_000],
    ]);
    const aprilAfter = await listOccurrences(db, household.id, "2099-04");
    expect(aprilAfter.find((o) => o.due_date === "2099-04-05")?.status).toBe("skipped");
    const mayAfter = await listOccurrences(db, household.id, "2099-05");
    const matched = mayAfter.find((o) => o.due_date === "2099-05-05")!;
    expect(matched.status).toBe("matched");
    expect(matched.amount_cents).toBe(9_950);
    // Once paid, what it actually cost is the answer, whatever was projected.
    expect(resolveOccurrenceAmountCents({ ...matched, amount_override_cents: 11_111 }, created)).toBe(9_950);
  });
});
