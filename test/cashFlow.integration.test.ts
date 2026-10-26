import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createAccount, updateAccountBalance } from "../src/db/accounts";
import { createTransaction } from "../src/db/transactions";
import { upsertSheetLink } from "../src/db/sheetLinks";
import { runAgentTool } from "../src/messaging/agentTools";
import { syncHouseholdSheet } from "../src/sheets/sync";
import { addDays, buildCashFlowForecast, CASH_FLOW_WEEKS, mondayOf } from "../src/sheets/tabs/cashFlow";
import { FakeSheets } from "./fakeSheets";

const db = env.DB;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("Cash Flow tab", () => {
  it("rolls cash forward week by week: beginning + income − bills − average spending = ending", async () => {
    const household = await createHousehold(db, { name: "Curtis Clan", timezone: "America/Denver" });
    const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
    const amex = await createAccount(db, household.id, { name: "Amex", type: "credit_card" });
    await updateAccountBalance(db, checking.id, 500000, 500000); // $5,000 in checking
    await updateAccountBalance(db, amex.id, 80000, null); // $800 owed on the card

    // $1,200 of everyday spending over the last 12 full weeks → $100/week.
    const lastSunday = addDays(mondayOf(today), -1);
    for (let i = 0; i < 12; i++) {
      await createTransaction(db, household.id, {
        accountId: checking.id,
        postedAt: addDays(lastSunday, -7 * i - 2),
        amountCents: -10000,
        rawDescription: `SMITHS ${i}`,
        normalizedMerchant: "Smiths",
      });
    }
    // An old charge outside the lookback window doesn't count.
    await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2024-01-05", amountCents: -999999, rawDescription: "OLD" });

    const ctx = { householdId: household.id, userId: null };
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "ACME PAYROLL",
      kind: "income",
      category: "Paycheck",
      frequency: "weekly",
      day_of_week: weekday,
      expected_amount_dollars: 1500,
    });
    await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "CREDIT CARD AUTOPAY",
      kind: "expense",
      category: "Credit Card Payment",
      frequency: "weekly",
      day_of_week: weekday,
      expected_amount_dollars: 800,
    });

    const forecast = await buildCashFlowForecast({ env, householdId: household.id, timezone: "America/Denver", month: today.slice(0, 7), today });
    expect(forecast.cashOnHandCents).toBe(420000);
    expect(forecast.avgWeeklySpendCents).toBe(10000);
    expect(forecast.weeks).toHaveLength(CASH_FLOW_WEEKS);

    const [first, second] = forecast.weeks;
    expect(first!.start).toBe(mondayOf(today));
    expect(first!.beginningCents).toBe(420000);
    expect(first!.incomeCents).toBe(150000);
    // The card-payment series is a transfer: the card balance is already netted out.
    expect(first!.billsCents).toBe(0);
    const daysLeft = (7 - ((weekday + 6) % 7));
    expect(first!.spendingCents).toBe(Math.round((10000 * daysLeft) / 7));
    for (const w of forecast.weeks) expect(w.endingCents).toBe(w.beginningCents + w.incomeCents - w.billsCents - w.spendingCents);
    expect(second!.beginningCents).toBe(first!.endingCents);
    expect(second!.spendingCents).toBe(10000);

    // A real bill shows up, and the tab renders in the sheet.
    await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "ROCKY MOUNTAIN POWER",
      kind: "expense",
      category: "Utilities",
      frequency: "weekly",
      day_of_week: weekday,
      expected_amount_dollars: 60,
    });
    await upsertSheetLink(db, household.id, `sheet-cf-${household.id}`);
    const sheet = new FakeSheets();
    await syncHouseholdSheet(env, household.id, sheet);
    const row = sheet.findRow("Cash Flow", "id", mondayOf(today), 2)!;
    expect(row.cells).toMatchObject({ "Beginning cash": 4200, Income: 1500, Bills: 60 });
    expect(String(row.cells["What's due"])).toMatch(/ROCKY MOUNTAIN POWER \$60/);
    expect(sheet.grid("Cash Flow")[0]![3]).toBe(4200);
    expect([...sheet.tabs.keys()].indexOf("Cash Flow")).toBeGreaterThan(-1);
  });

  it("counts a bill a couple of days late as still due, but not one from last week", async () => {
    const household = await createHousehold(db, { name: "Late Bills", timezone: "America/Denver" });
    const checking = await createAccount(db, household.id, { name: "Checking", type: "depository_checking" });
    await updateAccountBalance(db, checking.id, 100000, 100000);
    const ctx = { householdId: household.id, userId: null };
    const twoDaysAgo = addDays(today, -2);
    const day = Number(twoDaysAgo.slice(8, 10));
    await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "XFINITY",
      kind: "expense",
      category: "Utilities",
      frequency: "monthly",
      day_of_month: day,
      expected_amount_dollars: 95,
    });
    const f = await buildCashFlowForecast({ env, householdId: household.id, timezone: "America/Denver", month: today.slice(0, 7), today });
    expect(f.weeks[0]!.billsCents).toBe(9500);
    expect(f.weeks[0]!.items[0]!.date).toBe(today);
  });
});
