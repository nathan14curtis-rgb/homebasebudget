import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { findActiveCategoryByName, listCategories } from "../src/db/categories";
import { getEnvelopeByCategory, listEnvelopes } from "../src/db/envelopes";
import { createConfirmedRecurringPattern, listRecurringPatterns } from "../src/db/recurringPatterns";
import { listOccurrences } from "../src/envelopes/occurrences";
import { applyBudgetCsv, exportBudgetCsv, previewBudgetCsv } from "../src/budget/csv";
import { parseCsvWithHeader } from "../src/lib/csv";

const db = env.DB;

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const categories = await listCategories(db, household.id);
  const utilities = categories.find((c) => c.name === "Utilities")!;
  await createConfirmedRecurringPattern(db, household.id, {
    categoryId: utilities.id,
    merchantPattern: "ROCKY MTN POWER",
    kind: "expense",
    dayOfMonth: 5,
    expectedAmountCents: 10_000,
  });
  return { household, utilities };
}

describe("budget CSV — export", () => {
  it("writes one row per envelope, goal and series, with a bill's envelope not doubled as an envelope row", async () => {
    const { household } = await seed();
    const rows = parseCsvWithHeader(await exportBudgetCsv(db, household.id));
    const utilities = rows.filter((r) => r.name === "Utilities");
    expect(utilities).toHaveLength(1);
    expect(utilities[0]).toMatchObject({ type: "bill", amount: "100.00", frequency: "monthly", day: "5", merchant: "ROCKY MTN POWER" });
    expect(rows.find((r) => r.name === "Groceries")).toMatchObject({ type: "envelope", group: "Food", rollover: "carry" });
    expect(rows.find((r) => r.name === "Vacation Fund")).toMatchObject({ type: "goal" });
    expect(rows.some((r) => r.type === "income")).toBe(false);
  });

  it("round-trips: importing the export changes nothing", async () => {
    const { household } = await seed();
    const csv = await exportBudgetCsv(db, household.id);
    const plan = await previewBudgetCsv(db, household.id, csv);
    expect(plan.errors).toBe(0);
    expect(plan.creates + plan.updates + plan.archives).toBe(0);
    expect(plan.rows.every((r) => r.action === "unchanged")).toBe(true);
  });
});

describe("budget CSV — import", () => {
  const csv = [
    "type,name,amount,group,frequency,day,day2,merchant,goal_date,rollover,action",
    "envelope,Groceries,450,Food,,,,,,reset,",
    "envelope,Dog Food,60,Pets,,,,,,,",
    'goal,Vacation Fund,"3,000",Goals,,,,,2027-06-01,,',
    "bill,Utilities,125,,monthly,20,,ROCKY MTN POWER,,,",
    "bill,Internet,80,,monthly,12,,CENTURYLINK,,,",
    "income,Paycheck,1935.01,,twice-monthly,4,20,REDO PAYROLL,,,",
    "envelope,Hobbies,,,,,,,,,archive",
  ].join("\n");

  it("previews every change without writing anything", async () => {
    const { household } = await seed();
    const before = await exportBudgetCsv(db, household.id);
    const plan = await previewBudgetCsv(db, household.id, csv);
    expect(plan.errors).toBe(0);
    expect(plan.applied).toBe(false);
    const byName = Object.fromEntries(plan.rows.map((r) => [r.name, r]));
    expect(byName.Groceries).toMatchObject({ action: "update" });
    expect(byName.Groceries!.changes.join("; ")).toContain("$450.00");
    expect(byName["Dog Food"]).toMatchObject({ action: "create" });
    expect(byName.Utilities).toMatchObject({ action: "update" });
    expect(byName.Utilities!.changes.join("; ")).toContain("monthly on the 5 → monthly on the 20");
    expect(byName.Internet).toMatchObject({ action: "create" });
    expect(byName.Paycheck).toMatchObject({ action: "create" });
    expect(byName.Hobbies).toMatchObject({ action: "archive" });
    expect(await exportBudgetCsv(db, household.id)).toBe(before);
  });

  it("applies the plan: targets, groups, new rows, series edits, and archives", async () => {
    const { household, utilities } = await seed();
    const result = await applyBudgetCsv(db, household.id, csv);
    expect(result.applied).toBe(true);

    const categories = await listCategories(db, household.id);
    const envelopes = await listEnvelopes(db, household.id);
    const envelopeOf = (name: string) => envelopes.find((e) => e.category_id === categories.find((c) => c.name === name)!.id)!;
    expect(envelopeOf("Groceries")).toMatchObject({ monthly_target_cents: 45_000, rollover_mode: "reset", group_name: "Food" });
    expect(envelopeOf("Dog Food")).toMatchObject({ monthly_target_cents: 6_000, group_name: "Pets" });
    expect(envelopeOf("Vacation Fund")).toMatchObject({ monthly_target_cents: 300_000, target_date: "2027-06-01" });
    expect(envelopeOf("Hobbies").archived_at).not.toBeNull();

    const patterns = await listRecurringPatterns(db, household.id, { status: "confirmed" });
    const utilitiesSeries = patterns.find((p) => p.category_id === utilities.id)!;
    expect(utilitiesSeries).toMatchObject({ expected_amount_cents: 12_500, day_of_month: 20 });
    // The bill's envelope follows the series, and only one Utilities exists.
    expect((await getEnvelopeByCategory(db, household.id, utilities.id))!.monthly_target_cents).toBe(12_500);
    expect(categories.filter((c) => c.name === "Utilities")).toHaveLength(1);
    const internet = await findActiveCategoryByName(db, household.id, "Internet", "expense");
    expect(internet).not.toBeNull();
    expect((await getEnvelopeByCategory(db, household.id, internet!.id))).toMatchObject({ group_name: "Bills", monthly_target_cents: 8_000 });
    const paycheck = patterns.find((p) => p.kind === "income")!;
    expect(paycheck).toMatchObject({ frequency: "semimonthly", day_of_month: 4, day_of_month_2: 20, expected_amount_cents: 193_501 });
    // And the calendar picks the new rows up on its next read.
    const month = new Date().toISOString().slice(0, 7);
    const occurrences = await listOccurrences(db, household.id, month);
    expect(occurrences.some((o) => o.pattern_id === paycheck.id)).toBe(true);
  });

  it("refuses to apply a file with a bad row, and says which line", async () => {
    const { household } = await seed();
    const bad = ["type,name,amount", "envelope,Groceries,450", "envelope,Groceries,500", "bill,Water,forty"].join("\n");
    const result = await applyBudgetCsv(db, household.id, bad);
    expect(result.applied).toBe(false);
    expect(result.errors).toBe(2);
    expect(result.rows[1]).toMatchObject({ line: 3, action: "error" });
    expect(result.rows[1]!.error).toContain("appears twice");
    expect(result.rows[2]!.error).toContain("not a dollar amount");
    // Nothing was written.
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    expect((await getEnvelopeByCategory(db, household.id, groceries.id))!.monthly_target_cents).toBeNull();
  });

  it("rejects a file without the type and name columns", async () => {
    const { household } = await seed();
    await expect(previewBudgetCsv(db, household.id, "category,amount\nGroceries,400")).rejects.toThrow(/type.*name/);
  });
});
