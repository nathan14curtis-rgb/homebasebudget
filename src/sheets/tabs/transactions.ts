import { listAccounts } from "../../db/accounts";
import { listCategories } from "../../db/categories";
import { listTagsByTransaction } from "../../db/tags";
import { listTransactionsWithVerifyState } from "../../db/transactions";
import { previousMonth } from "../../db/envelopes";
import { centsToDollars, isBlank, parseBool, parseDate, parseMoneyDollars, parseTags, text } from "../cells";
import type { CellValue } from "../client";
import { afterCreate, changed, runSheetTool, SheetEditError, withSync, type ChangedCell, type RenderedRow, type SyncContext, type TabSpec } from "../layout";

/**
 * Every charge from the last three months, newest first.
 *
 * Fix anything a person can see — payee, amount, date, category, memo,
 * tags, excluded, flag — by typing over it. Split a charge by writing its
 * parts into Split ("Groceries 120, Household 60"). Add a cash charge on
 * an empty row at the bottom. The bank's own description stays read-only:
 * it's the link back to the statement.
 */

const FLAGS = ["red", "orange", "yellow", "green", "blue", "purple"];
const SPLIT_CHILD_MARK = "↳ part of a split";
const MONTHS_SHOWN = 3;

export const transactionsTab: TabSpec = {
  name: "Transactions",
  headerRow: 1,
  allowsCreate: true,
  minRows: 1500,
  columns: withSync([
    { key: "id", header: "id", type: "id", editable: false, width: 40 },
    { key: "date", header: "Date", type: "date", editable: true, width: 100 },
    { key: "payee", header: "Payee", type: "text", editable: true, width: 200 },
    { key: "amount", header: "Amount", type: "money", editable: true, width: 100, note: "Negative is money out, positive is money in." },
    { key: "category", header: "Category", type: "text", editable: true, dropdown: "categories", width: 170 },
    { key: "memo", header: "Memo", type: "text", editable: true, width: 200 },
    { key: "tags", header: "Tags", type: "tags", editable: true, width: 140, note: "Comma-separated, e.g. vacation, reimbursable" },
    { key: "excluded", header: "Excluded", type: "bool", editable: true, width: 80, note: "Ticked = kept on the books but out of every budget total." },
    { key: "flag", header: "Flag", type: "choice", editable: true, options: FLAGS, width: 80 },
    {
      key: "split",
      header: "Split",
      type: "text",
      editable: true,
      width: 220,
      note: "Write the parts to split a charge: 'Groceries 120, Household 60'. They must add up to the amount. To undo a split, tick Undo on it in the Log tab.",
    },
    { key: "account", header: "Account", type: "text", editable: false, createOnly: true, dropdown: "accounts", width: 150, note: "Only needed when adding a charge by hand." },
    { key: "bank", header: "Bank description", type: "text", editable: false, width: 220 },
    { key: "status", header: "Status", type: "text", editable: false, width: 110 },
  ]),

  async render(ctx) {
    let from = ctx.today.slice(0, 7);
    for (let i = 1; i < MONTHS_SHOWN; i++) from = previousMonth(from);
    const [transactions, categories, accounts, tagsByTxn] = await Promise.all([
      listTransactionsWithVerifyState(ctx.env.DB, ctx.householdId, { fromDate: `${from}-01`, limit: 1000 }),
      listCategories(ctx.env.DB, ctx.householdId),
      listAccounts(ctx.env.DB, ctx.householdId),
      listTagsByTransaction(ctx.env.DB, ctx.householdId),
    ]);
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const childrenByParent = new Map<string, typeof transactions>();
    for (const t of transactions) {
      if (!t.split_parent_id) continue;
      const list = childrenByParent.get(t.split_parent_id) ?? [];
      list.push(t);
      childrenByParent.set(t.split_parent_id, list);
    }

    // Parents first, each followed by its parts, so a split reads as one block.
    const ordered: typeof transactions = [];
    for (const t of transactions) {
      if (t.split_parent_id && transactions.some((p) => p.id === t.split_parent_id)) continue;
      ordered.push(t);
      for (const child of childrenByParent.get(t.id) ?? []) ordered.push(child);
    }

    return ordered.map((t): RenderedRow => {
      const children = childrenByParent.get(t.id) ?? [];
      let split = "";
      if (t.split_parent_id) split = SPLIT_CHILD_MARK;
      else if (children.length > 0) {
        split = children.map((c) => `${categoryName.get(c.category_id ?? "") ?? "?"} ${Math.abs(c.amount_cents / 100).toFixed(2)}`).join(", ");
      }
      let status = "";
      if (t.pending) status = "Pending";
      else if (t.is_transfer) status = "Transfer";
      else if (children.length > 0) status = "Split";
      else if (!t.category_id && !t.excluded_from_budget) status = "Needs category";
      else if (t.verify_state === "me") status = "Checked";
      else if (t.verify_state === "ai") status = "Auto-filed";
      return {
        id: t.id,
        cells: {
          id: t.id,
          date: t.posted_at.slice(0, 10),
          payee: t.normalized_merchant ?? t.raw_description,
          amount: centsToDollars(t.amount_cents),
          category: t.category_id ? (categoryName.get(t.category_id) ?? "") : "",
          memo: t.memo ?? "",
          tags: (tagsByTxn[t.id] ?? []).map((tag) => tag.name).join(", "),
          excluded: t.excluded_from_budget === 1,
          flag: t.flag_color ?? "",
          split,
          account: accountName.get(t.account_id) ?? "",
          bank: t.raw_description,
          status,
        },
      };
    });
  },

  async applyEdit(ctx, id, changes) {
    const update: Record<string, unknown> = {};
    const payee = changed(changes, "payee");
    if (payee) {
      if (isBlank(payee.value)) throw new SheetEditError("Payee can't be blank");
      update.payee = text(payee.value);
    }
    const amount = changed(changes, "amount");
    if (amount) {
      const dollars = parseMoneyDollars(amount.value);
      if (dollars === null) throw new SheetEditError(`'${text(amount.value)}' isn't an amount`);
      update.amount_dollars = dollars;
    }
    const date = changed(changes, "date");
    if (date) {
      const parsed = parseDate(date.value);
      if (!parsed) throw new SheetEditError(`'${text(date.value)}' isn't a date — use 2026-10-05`);
      update.date = parsed;
    }
    const memo = changed(changes, "memo");
    if (memo) update.memo = text(memo.value);
    const flag = changed(changes, "flag");
    if (flag) update.flag = isBlank(flag.value) ? "none" : text(flag.value).toLowerCase();
    if (Object.keys(update).length > 0) await runSheetTool(ctx, "update_transaction", { transaction_id: id, ...update });

    const category = changed(changes, "category");
    if (category) {
      if (isBlank(category.value)) throw new SheetEditError("Pick a category — a charge can't be put back to uncategorized from the sheet");
      await runSheetTool(ctx, "categorize_transactions", { items: [{ transaction_id: id, category: text(category.value) }] });
    }

    const tags = changed(changes, "tags");
    if (tags) await runSheetTool(ctx, "tag_transaction", { transaction_id: id, tags: parseTags(tags.value), replace: true });

    const excluded = changed(changes, "excluded");
    if (excluded) await runSheetTool(ctx, "set_transaction_excluded", { transaction_id: id, excluded: parseBool(excluded.value) });

    const split = changed(changes, "split");
    if (split) await applySplit(ctx, id, split);
  },

  async applyCreate(ctx, row) {
    const date = parseDate(row.date);
    const amount = parseMoneyDollars(row.amount);
    const payee = text(row.payee);
    const missing = [!date && "Date", !payee && "Payee", amount === null && "Amount", isBlank(row.account) && "Account"].filter(Boolean);
    if (missing.length > 0) throw new SheetEditError(`To add a charge, fill in ${missing.join(", ")}`);
    const created = await runSheetTool(ctx, "add_transaction", {
      account: text(row.account),
      date,
      payee,
      amount_dollars: amount,
      ...(isBlank(row.category) ? {} : { category: text(row.category) }),
      ...(isBlank(row.memo) ? {} : { memo: text(row.memo) }),
    });
    const id = String(created.transaction_id);
    await afterCreate(id, async () => {
      const tags = parseTags(row.tags);
      if (tags.length > 0) await runSheetTool(ctx, "tag_transaction", { transaction_id: id, tags });
      if (parseBool(row.excluded)) await runSheetTool(ctx, "set_transaction_excluded", { transaction_id: id, excluded: true });
      if (!isBlank(row.flag)) await runSheetTool(ctx, "update_transaction", { transaction_id: id, flag: text(row.flag).toLowerCase() });
    });
  },
};

async function applySplit(ctx: SyncContext, id: string, split: ChangedCell): Promise<void> {
  if (split.before === SPLIT_CHILD_MARK) throw new SheetEditError("This row is one part of a split — edit its category or amount instead");
  if (split.before !== "") throw new SheetEditError("Already split. To redo it, tick Undo on the split in the Log tab first");
  const parts = parseSplit(split.value);
  if (parts.length < 2) throw new SheetEditError("Write at least two parts, like 'Groceries 120, Household 60'");
  await runSheetTool(ctx, "split_transaction", {
    transaction_id: id,
    parts: parts.map((p) => ({ category: p.category, amount_dollars: p.dollars })),
  });
}

/** 'Groceries 120, Household 60.50' → [{Groceries, 120}, {Household, 60.5}]. */
export function parseSplit(value: CellValue): Array<{ category: string; dollars: number }> {
  return text(value)
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const m = part.match(/^(.*?)[\s:=]+\(?-?\$?([\d,]*\.?\d+)\)?$/);
      if (!m || m[1]!.trim() === "") throw new SheetEditError(`Couldn't read '${part}' — write each part as 'Category amount'`);
      return { category: m[1]!.trim(), dollars: Number(m[2]!.replace(/,/g, "")) };
    });
}
