import { describe, expect, it } from "vitest";
import type { Account, Category, Envelope, RecurringPattern, SeriesOccurrence } from "../dashboard/src/api";
import {
  addDays,
  addMonths,
  cashOnHandCents,
  daysInMonth,
  firstWeekdayOfMonth,
  monthsBetween,
  occurrenceAmountCents,
  occurrenceSignedCents,
  perDiemCents,
  projectDailyBalances,
  weeksInMonth,
} from "../dashboard/src/calendar";

function pattern(over: Partial<RecurringPattern> = {}): RecurringPattern {
  return {
    id: "rpat_1",
    household_id: "hh_1",
    category_id: "cat_1",
    merchant_pattern: "ACME",
    kind: "expense",
    frequency: "monthly",
    day_of_month: 5,
    day_of_month_2: null,
    day_of_week: null,
    day_tolerance: 4,
    status: "confirmed",
    sample_count: 3,
    expected_amount_cents: 10_000,
    ended_at: null,
    ...over,
  };
}

function occurrence(over: Partial<SeriesOccurrence> = {}): SeriesOccurrence {
  return {
    id: "socc_1",
    household_id: "hh_1",
    pattern_id: "rpat_1",
    month: "2026-03",
    scheduled_date: "2026-03-05",
    due_date: "2026-03-05",
    amount_cents: null,
    amount_override_cents: null,
    status: "upcoming",
    matched_transaction_id: null,
    unlinked_transaction_id: null,
    ...over,
  };
}

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "env_1",
    household_id: "hh_1",
    category_id: "cat_1",
    group_name: "Everyday",
    monthly_target_cents: null,
    target_date: null,
    rollover_mode: "carry",
    archived_at: null,
    ...over,
  };
}

function account(over: Partial<Account> = {}): Account {
  return {
    id: "acct_1",
    household_id: "hh_1",
    owner_user_id: null,
    name: "Checking",
    type: "depository_checking",
    mask: null,
    plaid_item_id: null,
    plaid_account_id: null,
    status: "active",
    current_balance_cents: 0,
    ...over,
  };
}

describe("calendar dates", () => {
  it("counts the days in a month, leap year included", () => {
    expect(daysInMonth("2026-03")).toBe(31);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-04")).toBe(30);
  });

  it("finds the weekday the month starts on", () => {
    // 2026-03-01 is a Sunday.
    expect(firstWeekdayOfMonth("2026-03")).toBe(0);
    // 2026-04-01 is a Wednesday.
    expect(firstWeekdayOfMonth("2026-04")).toBe(3);
  });

  it("steps months across a year boundary in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", 0)).toBe("2026-03");
  });

  it("steps days across a month boundary", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("lays the month out as whole weeks, padded with blanks", () => {
    const weeks = weeksInMonth("2026-04"); // starts Wednesday, 30 days
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // Three blanks before Wednesday the 1st.
    expect(weeks[0]!.slice(0, 3).every((c) => c.date === null)).toBe(true);
    expect(weeks[0]![3]!.date).toBe("2026-04-01");
    const dates = weeks.flat().filter((c) => c.date !== null);
    expect(dates).toHaveLength(30);
    expect(dates[29]!.date).toBe("2026-04-30");
  });

  it("caps how many months a projection will span", () => {
    expect(monthsBetween("2026-01", "2026-03")).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(monthsBetween("2026-01", "2026-01")).toEqual(["2026-01"]);
    expect(monthsBetween("2026-01", "2099-01")).toHaveLength(14);
    // A month before the start yields nothing rather than looping forever.
    expect(monthsBetween("2026-05", "2026-01")).toEqual([]);
  });
});

describe("occurrence amounts", () => {
  it("prefers a one-month override, then the generated amount, then the series", () => {
    expect(occurrenceAmountCents(occurrence({ amount_override_cents: 24_000, amount_cents: 20_000 }), pattern())).toBe(24_000);
    expect(occurrenceAmountCents(occurrence({ amount_cents: 20_000 }), pattern())).toBe(20_000);
    expect(occurrenceAmountCents(occurrence(), pattern())).toBe(10_000);
  });

  it("is null, not zero, when nothing has an amount yet", () => {
    expect(occurrenceAmountCents(occurrence(), pattern({ expected_amount_cents: null }))).toBeNull();
    expect(occurrenceAmountCents(occurrence(), undefined)).toBeNull();
  });

  it("signs by the series' kind, and counts a skipped occurrence as nothing", () => {
    expect(occurrenceSignedCents(occurrence(), pattern({ kind: "income" }))).toBe(10_000);
    expect(occurrenceSignedCents(occurrence(), pattern({ kind: "expense" }))).toBe(-10_000);
    expect(occurrenceSignedCents(occurrence({ status: "skipped" }), pattern({ kind: "income" }))).toBe(0);
  });
});

describe("cash on hand", () => {
  it("counts active depository accounts only", () => {
    const accounts = [
      account({ id: "a", current_balance_cents: 150_000 }),
      account({ id: "b", type: "depository_savings", current_balance_cents: 500_000 }),
      // A card balance is a debt that shows up as a bill, not spendable cash.
      account({ id: "c", type: "credit_card", current_balance_cents: 80_000 }),
      account({ id: "d", status: "removed", current_balance_cents: 999_999 }),
    ];
    expect(cashOnHandCents(accounts)).toBe(650_000);
  });
});

describe("per diem", () => {
  const spend = (id: string): Category => ({ id, name: id, kind: "expense", archived_at: null });

  it("spreads the plan's everyday expense targets across the month", () => {
    const envelopes = [
      envelope({ id: "e1", category_id: "c1", monthly_target_cents: 60_000 }),
      envelope({ id: "e2", category_id: "c2", monthly_target_cents: 33_000 }),
      // Bills are their own tiles on the calendar; counting them here too
      // would subtract them twice.
      envelope({ id: "e3", category_id: "c3", group_name: "Bills", monthly_target_cents: 200_000 }),
      envelope({ id: "e4", category_id: "c4", monthly_target_cents: 10_000, archived_at: "2026-01-01" }),
    ];
    const categoryById = new Map(["c1", "c2", "c3", "c4"].map((id) => [id, spend(id)]));
    expect(perDiemCents(envelopes, categoryById, "2026-04")).toBe(Math.round(93_000 / 30));
  });

  it("leaves savings goals out — a $12,000 car fund is a finish line, not $400 a day", () => {
    const envelopes = [
      envelope({ id: "e1", category_id: "c1", monthly_target_cents: 60_000 }),
      envelope({ id: "e2", category_id: "goal", group_name: "Goals", monthly_target_cents: 1_200_000 }),
    ];
    const categoryById = new Map<string, Category>([
      ["c1", spend("c1")],
      ["goal", { id: "goal", name: "New Car Fund", kind: "savings", archived_at: null }],
    ]);
    expect(perDiemCents(envelopes, categoryById, "2026-04")).toBe(2_000);
  });
});

describe("projected daily balances", () => {
  const patternById = new Map([
    ["pay", pattern({ id: "pay", kind: "income", expected_amount_cents: 200_000 })],
    ["rent", pattern({ id: "rent", kind: "expense", expected_amount_cents: 150_000 })],
  ]);

  it("starts at today's real balance and burns down by the per diem", () => {
    const balances = projectDailyBalances({
      month: "2026-03",
      today: "2026-03-10",
      startingCashCents: 100_000,
      occurrencesByMonth: { "2026-03": [] },
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    expect(balances.get("2026-03-10")).toBe(100_000);
    expect(balances.get("2026-03-11")).toBe(99_000);
    expect(balances.get("2026-03-13")).toBe(97_000);
  });

  it("leaves the days before today alone — history is not a projection", () => {
    const balances = projectDailyBalances({
      month: "2026-03",
      today: "2026-03-10",
      startingCashCents: 100_000,
      occurrencesByMonth: { "2026-03": [] },
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    expect(balances.has("2026-03-09")).toBe(false);
    expect(balances.has("2026-03-01")).toBe(false);
  });

  it("applies income and bills on the day they come due", () => {
    const balances = projectDailyBalances({
      month: "2026-03",
      today: "2026-03-10",
      startingCashCents: 100_000,
      occurrencesByMonth: {
        "2026-03": [
          occurrence({ id: "o1", pattern_id: "pay", due_date: "2026-03-12" }),
          occurrence({ id: "o2", pattern_id: "rent", due_date: "2026-03-13" }),
        ],
      },
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    expect(balances.get("2026-03-11")).toBe(99_000);
    expect(balances.get("2026-03-12")).toBe(99_000 - 1_000 + 200_000);
    expect(balances.get("2026-03-13")).toBe(99_000 - 2_000 + 200_000 - 150_000);
  });

  it("ignores what has already posted — that money is in the starting balance", () => {
    const balances = projectDailyBalances({
      month: "2026-03",
      today: "2026-03-10",
      startingCashCents: 100_000,
      occurrencesByMonth: {
        "2026-03": [
          occurrence({ id: "o1", pattern_id: "pay", due_date: "2026-03-12", status: "matched", matched_transaction_id: "txn_1" }),
          occurrence({ id: "o2", pattern_id: "rent", due_date: "2026-03-12", status: "skipped" }),
        ],
      },
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    expect(balances.get("2026-03-12")).toBe(98_000);
  });

  it("walks through the intervening months when a future month is on screen", () => {
    const balances = projectDailyBalances({
      month: "2026-04",
      today: "2026-03-30",
      startingCashCents: 100_000,
      occurrencesByMonth: {
        "2026-03": [occurrence({ id: "o1", pattern_id: "rent", month: "2026-03", due_date: "2026-03-31" })],
        "2026-04": [occurrence({ id: "o2", pattern_id: "pay", month: "2026-04", due_date: "2026-04-02" })],
      },
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    // March isn't the displayed month, so it isn't in the map — but its
    // rent on the 31st has still been taken out by the time April starts.
    expect(balances.has("2026-03-31")).toBe(false);
    expect(balances.get("2026-04-01")).toBe(100_000 - 2_000 - 150_000);
    expect(balances.get("2026-04-02")).toBe(100_000 - 3_000 - 150_000 + 200_000);
  });

  it("projects nothing for a month that is entirely in the past", () => {
    const balances = projectDailyBalances({
      month: "2026-01",
      today: "2026-03-10",
      startingCashCents: 100_000,
      occurrencesByMonth: {},
      patternById,
      perDiemCentsForMonth: () => 1_000,
    });
    expect(balances.size).toBe(0);
  });
});
