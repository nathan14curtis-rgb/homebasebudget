import { getChange, listChanges, markReverted, recordChange } from "../db/changeLog";
import { listRules, deleteRule } from "../db/rules";
import { listCategories } from "../db/categories";
import { AgentToolError, num, required, str, type AgentTool } from "./agentToolKit";
import { applyUndo, parseUndo, UndoNotPossibleError } from "./undo";

/**
 * Taking something back, and seeing what there is to take back.
 *
 * A text message has no undo stack of its own, so the household's is
 * stored (src/db/changeLog.ts): every write the agent makes leaves a row
 * saying what it was, in the words a person would use, and how to reverse
 * it. That makes both halves of "undo the grocery thing from Tuesday"
 * answerable — the model reads the recent changes, matches the
 * description, and reverses that one by id.
 */

const listRecentChanges: AgentTool = {
  mutates: false,
  access: "read",
  definition: {
    name: "list_recent_changes",
    description:
      "What has been changed lately and can still be undone, newest first, each with the id undo_change needs. Read this whenever someone says 'undo that', 'put it back', or 'what did you just do?' — match their description against these summaries rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back to look. Defaults to 14." },
        limit: { type: "number", description: "Defaults to 15, max 50." },
        include_undone: { type: "boolean", description: "Also show changes that have already been reversed. Defaults to false." },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const days = Math.min(Math.max(num(input, "days") ?? 14, 1), 365);
    const limit = Math.min(num(input, "limit") ?? 15, 50);
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const changes = await listChanges(env.DB, ctx.householdId, {
      limit,
      sinceIso,
      includeReverted: input.include_undone === true,
    });
    return {
      changes: changes.map((change) => ({
        change_id: change.id,
        what: change.summary,
        when: change.created_at,
        tool: change.tool_name,
        already_undone: change.reverted_at !== null,
        reversible: !change.undo.includes('"kind":"none"'),
      })),
    };
  },
};

const undoChange: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "undo_change",
    description:
      "Reverse one earlier change by its id, from list_recent_changes. The reversal is booked as its own entry — money goes back, a rename is renamed back, a new category is retired — so the history still shows what happened. Say which change you undid, not just that you did. A few changes can't be reversed (a merge, a deletion); this will tell you so rather than pretending.",
    input_schema: {
      type: "object",
      properties: { change_id: { type: "string", description: "From list_recent_changes." } },
      required: ["change_id"],
    },
  },
  async run(env, ctx, input) {
    const changeId = required(input, "change_id");
    const change = await getChange(env.DB, ctx.householdId, changeId);
    if (!change) throw new AgentToolError(`No change '${changeId}' — call list_recent_changes for the current ids.`);
    if (change.reverted_at) throw new AgentToolError(`That one was already undone (${change.summary}).`);

    try {
      await applyUndo(env, ctx.householdId, parseUndo(change.undo), ctx.userId);
    } catch (err) {
      if (err instanceof UndoNotPossibleError) {
        throw new AgentToolError(`That can't be undone: ${err.message}. Say so plainly and offer to fix it forwards instead.`);
      }
      throw err;
    }

    // The reversal is itself a change, so it shows up in the log — but it
    // isn't offered back for undoing, since "undo the undo" is just the
    // original ask again and re-running a before-image twice is how a
    // ledger gets confusing.
    const reversal = await recordChange(env.DB, ctx.householdId, {
      userId: ctx.userId,
      toolName: "undo_change",
      summary: `undid: ${change.summary}`,
      undo: { kind: "none", reason: "this row is itself an undo" },
    });
    await markReverted(env.DB, ctx.householdId, change.id, reversal.id);

    return { undone: change.summary, change_id: change.id, when_it_happened: change.created_at };
  },
};

const listRulesTool: AgentTool = {
  mutates: false,
  access: "read",
  definition: {
    name: "list_rules",
    description: "The standing rules that file charges automatically — what each one matches and where it sends the charge. Use it for 'why did that get filed as X?' and before making a rule that already exists.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(env, ctx) {
    const [rules, categories] = await Promise.all([listRules(env.DB, ctx.householdId), listCategories(env.DB, ctx.householdId)]);
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));
    return {
      rules: rules.map((rule) => {
        const actions = JSON.parse(rule.actions) as Array<{ type: string; categoryId?: string }>;
        const target = actions.find((a) => a.type === "setCategory")?.categoryId;
        return {
          rule_id: rule.id,
          matches: rule.conditions,
          files_as: target ? (categoryById.get(target) ?? null) : null,
          times_matched: rule.match_count,
          source: rule.source,
        };
      }),
    };
  },
};

const deleteRuleTool: AgentTool = {
  mutates: true,
  access: "plan",
  definition: {
    name: "delete_rule",
    description:
      "Remove a standing rule, so charges it was catching go back to being categorized normally — 'stop always filing Amazon as shopping'. Charges it already filed keep their categories. Get the id from list_rules.",
    input_schema: { type: "object", properties: { rule_id: { type: "string" } }, required: ["rule_id"] },
  },
  async run(env, ctx, input) {
    const ruleId = required(input, "rule_id");
    const rules = await listRules(env.DB, ctx.householdId);
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) throw new AgentToolError(`No rule '${ruleId}' — call list_rules for the current ids.`);
    await deleteRule(env.DB, ctx.householdId, ruleId);
    ctx.record({
      summary: `removed the rule matching ${rule.conditions}`,
      undo: { kind: "none", reason: "a deleted rule can be recreated with always_categorize_merchant" },
    });
    return { deleted_rule: ruleId, matched: rule.conditions };
  },
};

export const UNDO_TOOLS: AgentTool[] = [listRecentChanges, undoChange, listRulesTool, deleteRuleTool];
