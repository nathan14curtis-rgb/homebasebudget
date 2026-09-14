import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { allocateToEnvelope, getEnvelopeMonthSummariesForHousehold, listEnvelopes, previousMonth } from "../src/db/envelopes";
import { listChanges } from "../src/db/changeLog";
import { listRecurringPatterns } from "../src/db/recurringPatterns";
import { createTransaction, getTransaction, listTransactions } from "../src/db/transactions";
import { listTagsForTransaction } from "../src/db/tags";
import { runAgentTool, type AgentToolContext } from "../src/messaging/agentTools";

/**
 * The capability the texting bot was missing: writing the plan, not just
 * reading it. Each test here is a text message someone actually sent that
 * the bot couldn't act on — "make groceries $250 this month with nothing
 * rolled over", "add my internet bill", "undo that" — checked against the
 * ledger rather than against the reply.
 */

const db = env.DB;
const month = new Date().toISOString().slice(0, 7);

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  const ctx: AgentToolContext = { householdId: household.id, userId: nathan.id };
  return { household, nathan, checking, ctx };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

async function envelopeFor(householdId: string, categoryName: string) {
  const category = (await listCategories(db, householdId)).find((c) => c.name === categoryName)!;
  const envelope = (await listEnvelopes(db, householdId)).find((e) => e.category_id === category.id)!;
  return { category, envelope };
}

async function summaryFor(householdId: string, envelopeId: string, forMonth = month) {
  return (await getEnvelopeMonthSummariesForHousehold(db, householdId, forMonth))[envelopeId]!;
}

describe("set_month_budget — 'make groceries $250 this month, nothing rolled over'", () => {
  it("funds the month to an exact figure and books the opening balance in the prior month", async () => {
    const { household, ctx } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    // $180 left over from last month, $90 already assigned this month.
    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: previousMonth(month), amountCents: 18000 });
    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month, amountCents: 9000 });

    const outcome = await runAgentTool(env, ctx, "set_month_budget", {
      category: "groceries",
      amount_dollars: 250,
      opening_rollover_dollars: 0,
    });
    expect(outcome.isError).toBe(false);
    const body = parse(outcome.content);
    expect(body.budgeted_dollars).toBe(250);
    expect(body.carried_in_dollars).toBe(0);

    const summary = await summaryFor(household.id, envelope.id);
    expect(summary.carriedInCents).toBe(0);
    expect(summary.carriedInCents + summary.allocatedCents).toBe(25000);
    // The prior month absorbed the rollover correction, so this month's
    // funding figure is what they asked for, not what's left of an
    // adjustment.
    const prior = await summaryFor(household.id, envelope.id, previousMonth(month));
    expect(prior.balanceCents).toBe(0);
  });

  it("leaves the monthly target alone unless told otherwise", async () => {
    const { household, ctx } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    await runAgentTool(env, ctx, "update_spending_plan", { category: "groceries", monthly_target_dollars: 800 });

    await runAgentTool(env, ctx, "set_month_budget", { category: "groceries", amount_dollars: 250 });
    let after = (await listEnvelopes(db, household.id)).find((e) => e.id === envelope.id)!;
    expect(after.monthly_target_cents).toBe(80000);

    await runAgentTool(env, ctx, "set_month_budget", { category: "groceries", amount_dollars: 250, also_set_monthly_target: true });
    after = (await listEnvelopes(db, household.id)).find((e) => e.id === envelope.id)!;
    expect(after.monthly_target_cents).toBe(25000);
  });

  it("takes money back out when the month is already over the new figure", async () => {
    const { household, ctx } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month, amountCents: 60000 });

    await runAgentTool(env, ctx, "set_month_budget", { category: "groceries", amount_dollars: 250 });
    const summary = await summaryFor(household.id, envelope.id);
    expect(summary.allocatedCents).toBe(25000);
  });
});

describe("rollover mode", () => {
  it("'reset' zeroes what carries into the month, 'carry' leaves it", async () => {
    const { household, ctx } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: previousMonth(month), amountCents: 12000 });

    // Default is carry: last month's $120 is still there.
    let plan = parse((await runAgentTool(env, ctx, "get_spending_plan", { month })).content);
    let row = (plan.envelopes as Record<string, unknown>[]).find((e) => e.category === "Groceries")!;
    expect(row.carried_in_dollars).toBe(120);
    expect(row.rollover).toBe("carry");

    await runAgentTool(env, ctx, "update_spending_plan", { category: "groceries", rollover: "reset" });
    plan = parse((await runAgentTool(env, ctx, "get_spending_plan", { month })).content);
    row = (plan.envelopes as Record<string, unknown>[]).find((e) => e.category === "Groceries")!;
    expect(row.carried_in_dollars).toBe(0);

    // Idempotent: reading the plan again doesn't book a second correction.
    await runAgentTool(env, ctx, "get_spending_plan", { month });
    const summary = await summaryFor(household.id, envelope.id);
    expect(summary.carriedInCents).toBe(0);
  });
});

describe("fund_month_from_plan — 'set up this month the usual way'", () => {
  it("tops every envelope up to its monthly target and leaves the rest alone", async () => {
    const { household, ctx } = await seed();
    await runAgentTool(env, ctx, "set_targets_in_bulk", {
      targets: [
        { category: "Groceries", monthly_target_dollars: 800 },
        { category: "Gas", monthly_target_dollars: 200 },
      ],
    });
    const { envelope: groceries } = await envelopeFor(household.id, "Groceries");
    await allocateToEnvelope(db, household.id, { envelopeId: groceries.id, month, amountCents: 50000 });

    const outcome = await runAgentTool(env, ctx, "fund_month_from_plan", { month });
    const body = parse(outcome.content);
    expect(body.total_dollars).toBe(500);

    expect((await summaryFor(household.id, groceries.id)).allocatedCents).toBe(80000);
    const { envelope: gas } = await envelopeFor(household.id, "Gas");
    expect((await summaryFor(household.id, gas.id)).allocatedCents).toBe(20000);
  });
});

describe("recurring series", () => {
  it("creates a bill, projects it into the month, and edits one occurrence without touching the series", async () => {
    const { household, ctx } = await seed();
    const created = parse((await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "XFINITY",
      kind: "expense",
      category: "Utilities",
      frequency: "monthly",
      day_of_month: 5,
      expected_amount_dollars: 95,
    })).content);
    expect(created.merchant).toBe("XFINITY");

    const listed = parse((await runAgentTool(env, ctx, "list_month_occurrences", { month })).content);
    const occurrences = listed.occurrences as Record<string, unknown>[];
    const xfinity = occurrences.find((o) => o.merchant === "XFINITY")!;
    expect(xfinity.amount_dollars).toBe(95);

    const updated = parse((await runAgentTool(env, ctx, "update_bill_occurrence", {
      occurrence_id: xfinity.occurrence_id,
      amount_dollars: 140,
    })).content);
    expect(updated.amount_dollars).toBe(140);

    // The series itself still says $95 — one month changed, not the plan.
    const pattern = (await listRecurringPatterns(db, household.id)).find((p) => p.merchant_pattern === "XFINITY")!;
    expect(pattern.expected_amount_cents).toBe(9500);
  });

  it("refuses to end a series without confirmation, then ends it", async () => {
    const { household, ctx } = await seed();
    await runAgentTool(env, ctx, "create_recurring_series", {
      merchant_contains: "PLANET FITNESS",
      kind: "expense",
      category: "Subscriptions",
      day_of_month: 2,
    });

    const refused = await runAgentTool(env, ctx, "end_recurring_series", { series: "PLANET FITNESS" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("confirmed");
    expect((await listRecurringPatterns(db, household.id)).find((p) => p.merchant_pattern === "PLANET FITNESS")!.ended_at).toBeNull();

    const ended = await runAgentTool(env, ctx, "end_recurring_series", { series: "PLANET FITNESS", confirmed: true });
    expect(ended.isError).toBe(false);
    expect((await listRecurringPatterns(db, household.id)).find((p) => p.merchant_pattern === "PLANET FITNESS")!.ended_at).not.toBeNull();
  });
});

describe("transaction editing", () => {
  it("splits a charge across categories and tags it", async () => {
    const { household, checking, ctx } = await seed();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-11`, amountCents: -18000, rawDescription: "COSTCO WHSE #1021", normalizedMerchant: "COSTCO",
    });

    const split = await runAgentTool(env, ctx, "split_transaction", {
      transaction_id: txn.id,
      parts: [
        { category: "Groceries", amount_dollars: 120 },
        { category: "Home Maintenance", amount_dollars: 60 },
      ],
    });
    expect(split.isError).toBe(false);
    const children = await listTransactions(db, household.id, { limit: 50 });
    expect(children.filter((t) => t.split_parent_id === txn.id)).toHaveLength(2);
    expect((await getTransaction(db, household.id, txn.id)).excluded_from_budget).toBe(1);

    await runAgentTool(env, ctx, "tag_transaction", { transaction_id: txn.id, tags: ["reimbursable"] });
    expect((await listTagsForTransaction(db, household.id, txn.id)).map((t) => t.name)).toEqual(["reimbursable"]);
  });

  it("mismatched split amounts are refused in dollars the person would recognize", async () => {
    const { household, checking, ctx } = await seed();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-11`, amountCents: -18000, rawDescription: "COSTCO", normalizedMerchant: "COSTCO",
    });
    const outcome = await runAgentTool(env, ctx, "split_transaction", {
      transaction_id: txn.id,
      parts: [
        { category: "Groceries", amount_dollars: 120 },
        { category: "Home Maintenance", amount_dollars: 20 },
      ],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("$180.00");
  });
});

describe("undo", () => {
  it("reverses a funding change by id and refuses to do it twice", async () => {
    const { household, ctx } = await seed();
    const { envelope } = await envelopeFor(household.id, "Groceries");
    const funded = await runAgentTool(env, ctx, "set_month_budget", { category: "groceries", amount_dollars: 250 });
    expect((await summaryFor(household.id, envelope.id)).allocatedCents).toBe(25000);

    const changeId = (funded.changeIds ?? [])[0]!;
    expect(changeId).toBeTruthy();

    const listed = parse((await runAgentTool(env, ctx, "list_recent_changes", {})).content);
    expect((listed.changes as Record<string, unknown>[]).some((c) => c.change_id === changeId)).toBe(true);

    const undone = await runAgentTool(env, ctx, "undo_change", { change_id: changeId });
    expect(undone.isError).toBe(false);
    expect((await summaryFor(household.id, envelope.id)).allocatedCents).toBe(0);

    const again = await runAgentTool(env, ctx, "undo_change", { change_id: changeId });
    expect(again.isError).toBe(true);
    expect(again.content).toContain("already");
  });

  it("puts a renamed category back", async () => {
    const { household, ctx } = await seed();
    const renamed = await runAgentTool(env, ctx, "rename_category", { category: "Groceries", new_name: "Food" });
    expect((await listCategories(db, household.id)).some((c) => c.name === "Food")).toBe(true);

    await runAgentTool(env, ctx, "undo_change", { change_id: renamed.changeIds[0]! });
    expect((await listCategories(db, household.id)).some((c) => c.name === "Groceries")).toBe(true);
  });

  it("says plainly when something can't be undone", async () => {
    const { household, ctx } = await seed();
    const merged = await runAgentTool(env, ctx, "merge_categories", {
      from_category: "Dining Out",
      into_category: "Groceries",
      confirmed: true,
    });
    expect(merged.isError).toBe(false);
    const outcome = await runAgentTool(env, ctx, "undo_change", { change_id: merged.changeIds[0]! });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("can't be undone");
    // And the change is still on the log, unreverted, rather than silently
    // marked as handled.
    const changes = await listChanges(db, household.id, { includeReverted: true });
    expect(changes.find((c) => c.id === merged.changeIds[0])!.reverted_at).toBeNull();
  });
});

describe("access levels", () => {
  it("view-only members can read but not write; limited members can categorize but not re-plan", async () => {
    const { household, checking } = await seed();
    const viewer = await createUser(db, household.id, { name: "Guest", accessLevel: "view_only" });
    const limited = await createUser(db, household.id, { name: "Teen", accessLevel: "limited" });
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-03`, amountCents: -2200, rawDescription: "MAVERIK", normalizedMerchant: "MAVERIK",
    });

    const viewCtx: AgentToolContext = { householdId: household.id, userId: viewer.id, accessLevel: "view_only" };
    expect((await runAgentTool(env, viewCtx, "get_spending_plan", {})).isError).toBe(false);
    const blocked = await runAgentTool(env, viewCtx, "set_month_budget", { category: "groceries", amount_dollars: 250 });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("view-only");

    const limitedCtx: AgentToolContext = { householdId: household.id, userId: limited.id, accessLevel: "limited" };
    const categorized = await runAgentTool(env, limitedCtx, "categorize_transactions", {
      items: [{ transaction_id: txn.id, category: "Gas" }],
    });
    expect(categorized.isError).toBe(false);
    const replanned = await runAgentTool(env, limitedCtx, "update_spending_plan", { category: "Gas", monthly_target_dollars: 400 });
    expect(replanned.isError).toBe(true);
    expect(replanned.content).toContain("limited access");
  });
});
