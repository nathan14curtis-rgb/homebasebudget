import { listTags, listTagsForTransaction, setTransactionTags } from "../db/tags";
import { getTransaction, splitTransaction, updateTransaction } from "../db/transactions";
import type { Transaction, TransactionFlagColor } from "../types";
import {
  AgentToolError,
  arr,
  bool,
  dateArg,
  formatDollars,
  num,
  required,
  resolveCategory,
  str,
  toCents,
  toDollars,
  type AgentTool,
} from "./agentToolKit";
import type { UndoEnvelope } from "./undo";

/**
 * Fixing a charge itself, rather than where it files.
 *
 * The bank is usually right about a transaction and usually wrong about
 * what it's called, so the common cases here are cosmetic — a payee a
 * person recognizes, a memo about why — with two that genuinely change the
 * budget's math: correcting an amount (a tip the merchant added, a manual
 * entry typed wrong) and splitting one charge across several categories,
 * which is how a $180 Costco run stops being filed entirely as groceries.
 */

const FLAG_COLORS = new Set(["red", "orange", "yellow", "green", "blue", "purple"]);

function transactionUndo(before: Transaction): UndoEnvelope {
  return {
    kind: "transactions",
    entries: [
      {
        transactionId: before.id,
        categoryId: before.category_id,
        amountCents: before.amount_cents,
        postedAt: before.posted_at,
        payee: before.normalized_merchant,
        memo: before.memo,
        excluded: before.excluded_from_budget === 1,
        flagColor: before.flag_color,
      },
    ],
  };
}

const editTransactionTool: AgentTool = {
  mutates: true,
  access: "categorize",
  definition: {
    name: "update_transaction",
    description:
      "Correct a charge: what it's called, what it cost, the date it belongs on, a memo about it, or a colored flag. The bank's original description is never overwritten — the payee is what the household sees. Use categorize_transactions for the category instead; this is for everything else about the row.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        payee: { type: "string", description: "What to call the merchant, in the household's words." },
        amount_dollars: {
          type: "number",
          description: "The corrected amount. Negative for money out, positive for money in — keep the sign the charge already had unless they're telling you it was the other direction.",
        },
        date: { type: "string", description: "'YYYY-MM-DD' the charge belongs on." },
        memo: { type: "string", description: "A note about what it was. Pass an empty string to clear it." },
        flag: { type: "string", enum: ["red", "orange", "yellow", "green", "blue", "purple", "none"], description: "A colored marker, or 'none' to clear it." },
      },
      required: ["transaction_id"],
    },
  },
  async run(env, ctx, input) {
    const transactionId = required(input, "transaction_id");
    const before = await getTransaction(env.DB, ctx.householdId, transactionId);

    const patch: Parameters<typeof updateTransaction>[3] = { editedByUserId: ctx.userId ?? undefined };
    const payee = str(input, "payee");
    if (payee) patch.payee = payee;
    const amount = num(input, "amount_dollars");
    if (amount !== null) {
      if (amount === 0) throw new AgentToolError("'amount_dollars' can't be zero — a charge with no amount isn't a charge");
      patch.amountCents = toCents(amount);
    }
    const date = dateArg(input, "date");
    if (date) patch.postedAt = date;
    if (typeof input.memo === "string") patch.memo = input.memo.trim() || null;
    const flag = str(input, "flag");
    if (flag === "none") patch.flagColor = null;
    else if (flag !== null) {
      if (!FLAG_COLORS.has(flag)) throw new AgentToolError(`'flag' must be one of ${[...FLAG_COLORS].join(", ")}, or 'none'`);
      patch.flagColor = flag as TransactionFlagColor;
    }

    const updated = await updateTransaction(env.DB, ctx.householdId, transactionId, patch);
    ctx.record({
      summary: `edited ${formatDollars(before.amount_cents)} at ${before.normalized_merchant ?? before.raw_description}${
        patch.amountCents !== undefined ? ` — amount now ${formatDollars(updated.amount_cents)}` : ""
      }`,
      undo: transactionUndo(before),
    });
    return {
      transaction_id: updated.id,
      payee: updated.normalized_merchant,
      amount_dollars: toDollars(updated.amount_cents),
      date: updated.posted_at,
      memo: updated.memo,
      flag: updated.flag_color,
    };
  },
};

const splitTransactionTool: AgentTool = {
  mutates: true,
  access: "categorize",
  definition: {
    name: "split_transaction",
    description:
      "Split one charge across several categories — '$180 at Costco was $120 groceries, $40 household, $20 a gift'. The parts must add up to the original amount exactly. The original stays on the books as the link to the bank statement and stops counting toward any budget on its own.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        parts: {
          type: "array",
          description: "The pieces. Their amounts must sum to the original charge.",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              amount_dollars: { type: "number", description: "Same sign as the original charge — negative for a piece of a purchase." },
              memo: { type: "string" },
            },
            required: ["category", "amount_dollars"],
          },
        },
      },
      required: ["transaction_id", "parts"],
    },
  },
  async run(env, ctx, input) {
    const transactionId = required(input, "transaction_id");
    const parts = arr(input, "parts") as Record<string, unknown>[];
    if (parts.length < 2) throw new AgentToolError("a split needs at least two parts");
    const parent = await getTransaction(env.DB, ctx.householdId, transactionId);

    const splits: Array<{ amountCents: number; categoryId: string; memo?: string | null }> = [];
    for (const part of parts) {
      const amount = num(part, "amount_dollars");
      if (amount === null) throw new AgentToolError("every part needs an 'amount_dollars'");
      const category = await resolveCategory(env, ctx.householdId, required(part, "category"));
      // People say the pieces of a $180 purchase as positive numbers.
      // The ledger keeps spend negative, so match the parent's sign rather
      // than making the model remember to.
      const magnitude = Math.abs(toCents(amount));
      splits.push({
        amountCents: parent.amount_cents < 0 ? -magnitude : magnitude,
        categoryId: category.id,
        memo: str(part, "memo"),
      });
    }

    const sum = splits.reduce((total, s) => total + s.amountCents, 0);
    if (sum !== parent.amount_cents) {
      throw new AgentToolError(
        `the parts add up to ${formatDollars(sum)} but the charge is ${formatDollars(parent.amount_cents)} — they have to match exactly.`,
      );
    }

    const children = await splitTransaction(env.DB, ctx.householdId, transactionId, splits);
    ctx.record({
      summary: `split ${formatDollars(parent.amount_cents)} at ${parent.normalized_merchant ?? parent.raw_description} into ${children.length} parts`,
      undo: { kind: "split", parentId: transactionId, childIds: children.map((c) => c.id) },
    });
    return {
      transaction_id: transactionId,
      parts: children.map((child) => ({ transaction_id: child.id, amount_dollars: toDollars(child.amount_cents), memo: child.memo })),
    };
  },
};

const tagTransactionTool: AgentTool = {
  mutates: true,
  access: "categorize",
  definition: {
    name: "tag_transaction",
    description:
      "Put labels on a charge, alongside its category — 'vacation', 'reimbursable', 'tax deductible'. A charge has one category but any number of tags. Tags that don't exist yet are created.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "The tag names." },
        replace: { type: "boolean", description: "Default false: add to what's there. True replaces the charge's tags with exactly this list." },
      },
      required: ["transaction_id", "tags"],
    },
  },
  async run(env, ctx, input) {
    const transactionId = required(input, "transaction_id");
    const names = (arr(input, "tags") as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (names.length === 0 && !bool(input, "replace")) throw new AgentToolError("'tags' must contain at least one tag name");
    const transaction = await getTransaction(env.DB, ctx.householdId, transactionId);
    const before = await listTagsForTransaction(env.DB, ctx.householdId, transactionId);

    const tags = await setTransactionTags(env.DB, ctx.householdId, transactionId, {
      tagIds: bool(input, "replace") ? [] : before.map((t) => t.id),
      tagNames: names,
    });
    ctx.record({
      summary: `tagged ${formatDollars(transaction.amount_cents)} at ${transaction.normalized_merchant ?? transaction.raw_description} ${names
        .map((n) => `'${n}'`)
        .join(", ")}`,
      undo: { kind: "transaction_tags", transactionId, tagIds: before.map((t) => t.id) },
    });
    return { transaction_id: transactionId, tags: tags.map((t) => t.name) };
  },
};

const listTagsTool: AgentTool = {
  mutates: false,
  access: "read",
  definition: {
    name: "list_tags",
    description: "Every tag the household uses. Check this before inventing a new one — 'vacation' and 'vacations' as two tags is the thing to avoid.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(env, ctx) {
    const tags = await listTags(env.DB, ctx.householdId);
    return { tags: tags.map((t) => t.name) };
  },
};

export const TRANSACTION_TOOLS: AgentTool[] = [editTransactionTool, splitTransactionTool, tagTransactionTool, listTagsTool];
