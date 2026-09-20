/**
 * Per-view header copy — eyebrow section label, title, and subtitle,
 * driven by real data.
 *
 * The header's one action is not decided here: a page registers it while
 * mounted (see pageAction.ts), and App.tsx renders the button only when
 * one is registered, so every page's header button opens that page's own
 * dialog rather than some scrolling to a form and others opening a modal.
 */
import { needsCategoryCount } from "./copy";

export interface PageHeadContext {
  pctOfBudget: number; // 0-100, spent/planned across funded envelopes this month
  uncategorizedCount: number;
  envelopesNeedingAttention: number; // over or within $50 of their target
  goalsCount: number;
  memberCount: number;
  assetName?: string; // set only when viewing a specific asset leaf
  /** Bills and income due in the rest of this month, for the calendar's subtitle. */
  upcomingBillCount: number;
  overdueBillCount: number;
}

export interface PageHead {
  sectionLabel: string;
  title: string;
  subtitle: string;
}

const DOCUMENT_VIEWS = new Set(["Insurance", "Warranties", "Identification", "Passwords"]);
const MAINTENANCE_VIEWS = new Set(["House", "Car"]);

export function getPageHead(view: string, ctx: PageHeadContext): PageHead {
  switch (view) {
    case "Overview":
      return {
        sectionLabel: "Overview",
        title: "Overview",
        subtitle: `The household is tracking ${ctx.pctOfBudget > 75 ? "a little hot" : "under plan"} this month.`,
      };
    case "Chat":
      return {
        sectionLabel: "Ask the bot",
        title: "Ask the bot",
        subtitle:
          ctx.uncategorizedCount > 0
            ? `Ask anything about the budget, or tell it what to change. ${needsCategoryCount(ctx.uncategorizedCount)}.`
            : "Ask anything about the budget, or tell it what to change. Same thread as your texts.",
      };
    case "Transactions":
      return {
        sectionLabel: "Transactions",
        title: "Transactions",
        subtitle:
          ctx.uncategorizedCount > 0 ? `${needsCategoryCount(ctx.uncategorizedCount)}.` : "Every dollar has a home.",
      };
    case "BillsIncome":
      return {
        sectionLabel: "Bills & Income",
        title: "Bills & Income",
        subtitle:
          ctx.overdueBillCount > 0
            ? `${ctx.overdueBillCount} bill${ctx.overdueBillCount === 1 ? "" : "s"} past due.`
            : ctx.upcomingBillCount > 0
              ? `${ctx.upcomingBillCount} still to come this month.`
              : "Everything this month has landed.",
      };
    case "Envelopes":
      return {
        sectionLabel: "Spending Plan",
        title: "Spending Plan",
        subtitle:
          ctx.envelopesNeedingAttention > 0
            ? `${ctx.envelopesNeedingAttention} envelope${ctx.envelopesNeedingAttention === 1 ? "" : "s"} need${ctx.envelopesNeedingAttention === 1 ? "s" : ""} a nudge before the month closes.`
            : "Everyday envelopes, minus the bills that repeat.",
      };
    case "Goals":
      return {
        sectionLabel: "Goals",
        title: "Goals",
        subtitle: `${ctx.goalsCount} thing${ctx.goalsCount === 1 ? "" : "s"} you're saving toward.`,
      };
    case "Members":
      return {
        sectionLabel: "Members",
        title: "Members",
        subtitle: `${ctx.memberCount} ${ctx.memberCount === 1 ? "person" : "people"}, one shared ledger.`,
      };
    case "Summary":
      return {
        sectionLabel: "Assets · Summary",
        title: "Assets · Summary",
        subtitle: "Financial, document, and maintenance history merged per asset.",
      };
    case "Settings":
      return {
        sectionLabel: "Settings",
        title: "Settings",
        subtitle: "People, accounts, categories, and importing history.",
      };
  }

  if (DOCUMENT_VIEWS.has(view)) {
    return {
      sectionLabel: `Documents · ${view}`,
      title: `Documents · ${view}`,
      subtitle: "Every document, in one place.",
    };
  }

  if (MAINTENANCE_VIEWS.has(view)) {
    return {
      sectionLabel: `Maintenance · ${view}`,
      title: `Maintenance · ${view}`,
      subtitle: view === "House" ? "What the house needs." : "Keep every car road-ready.",
    };
  }

  // Anything else is a specific asset name — the Assets group's dynamic leaves.
  return {
    sectionLabel: "Assets",
    title: ctx.assetName ?? view,
    subtitle: "Financial, document, and maintenance history for this asset.",
  };
}
