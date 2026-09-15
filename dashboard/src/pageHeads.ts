/**
 * Per-view header copy — eyebrow section label, title, and subtitle,
 * driven by real data.
 *
 * The header used to carry a pair of CTA labels per page, most of which
 * were inert: "Import last month", "Close the month", "Permissions",
 * "Export report" and the rest were mockup copy with nothing behind them,
 * and a button that does nothing when clicked is worse than no button at
 * all. What is left is a single optional action per page, and it only
 * exists where the page genuinely has one — App.tsx routes the click to
 * whatever the page registered (see pageAction.ts), or, failing that, to
 * the page's own add form.
 */

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
  /** Label for the header's one action, or "" for a page with none. */
  primaryCta: string;
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
        primaryCta: "",
      };
    case "Chat":
      return {
        sectionLabel: "Ask the bot",
        title: "Ask the bot",
        subtitle:
          ctx.uncategorizedCount > 0
            ? `Ask anything about the budget, or tell it what to change. ${ctx.uncategorizedCount} charge${ctx.uncategorizedCount === 1 ? "" : "s"} still need a category.`
            : "Ask anything about the budget, or tell it what to change — same thread as your texts.",
        primaryCta: "",
      };
    case "Transactions":
      return {
        sectionLabel: "Transactions",
        title: "Transactions",
        subtitle:
          ctx.uncategorizedCount > 0
            ? `${ctx.uncategorizedCount} transaction${ctx.uncategorizedCount === 1 ? "" : "s"} still need${ctx.uncategorizedCount === 1 ? "s" : ""} a category.`
            : "Every dollar has a home.",
        // No header CTA here on purpose — the page's own "Export CSV"
        // button is tied to the current filters, so it belongs beside them.
        primaryCta: "",
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
        primaryCta: "Add bill or income",
      };
    case "Envelopes":
      return {
        sectionLabel: "Spending Plan",
        title: "Spending Plan",
        subtitle:
          ctx.envelopesNeedingAttention > 0
            ? `${ctx.envelopesNeedingAttention} envelope${ctx.envelopesNeedingAttention === 1 ? "" : "s"} need${ctx.envelopesNeedingAttention === 1 ? "s" : ""} a nudge before the month closes.`
            : "Everyday spending, minus the bills that repeat.",
        primaryCta: "New envelope",
      };
    case "Goals":
      return {
        sectionLabel: "Goals",
        title: "Goals",
        subtitle: `${ctx.goalsCount} thing${ctx.goalsCount === 1 ? "" : "s"} you're saving toward.`,
        primaryCta: "New goal",
      };
    case "Members":
      return {
        sectionLabel: "Members",
        title: "Members",
        subtitle: `${ctx.memberCount} ${ctx.memberCount === 1 ? "person" : "people"}, one shared ledger.`,
        primaryCta: "Invite member",
      };
    case "Summary":
      return {
        sectionLabel: "Assets · Summary",
        title: "Assets · Summary",
        subtitle: "Financial, document, and maintenance history merged per asset.",
        primaryCta: "Add asset",
      };
    case "Settings":
      return {
        sectionLabel: "Settings",
        title: "Settings",
        subtitle: "People, accounts, categories, and importing history.",
        primaryCta: "",
      };
  }

  if (DOCUMENT_VIEWS.has(view)) {
    return {
      sectionLabel: `Documents · ${view}`,
      title: `Documents · ${view}`,
      subtitle: "Every document, in one place.",
      primaryCta: "Add document",
    };
  }

  if (MAINTENANCE_VIEWS.has(view)) {
    return {
      sectionLabel: `Maintenance · ${view}`,
      title: `Maintenance · ${view}`,
      subtitle: view === "House" ? "What the house needs." : "Keep every car road-ready.",
      primaryCta: "Add task",
    };
  }

  // Anything else is a specific asset name — the Assets group's dynamic leaves.
  return {
    sectionLabel: "Assets",
    title: ctx.assetName ?? view,
    subtitle: "Financial, document, and maintenance history for this asset.",
    primaryCta: "",
  };
}
