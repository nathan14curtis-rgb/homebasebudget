import type Anthropic from "@anthropic-ai/sdk";
import type { AccessLevel, Category, Env, Envelope } from "../types";
import { listCategories } from "../db/categories";
import { listEnvelopes } from "../db/envelopes";
import type { UndoEnvelope } from "./undo";

/**
 * The frame every agent tool is built in: what a tool is, who is allowed
 * to call it, how it names money, and how it records what it did.
 *
 * Split out of agentTools.ts so the tool groups (plan, series,
 * transactions, undo) can each be their own readable file while sharing
 * exactly one definition of a category lookup, one dollars→cents
 * conversion, and one permission model.
 */

/**
 * What kind of power a tool exercises, which is what a household member's
 * access_level is checked against:
 *
 *  - `read`        — answers a question, changes nothing.
 *  - `categorize`  — files, tags, flags or excludes individual charges.
 *                    Day-to-day bookkeeping; a 'limited' member does this.
 *  - `plan`        — changes the household's plan: targets, funding, money
 *                    moves, new categories, recurring series.
 *  - `destructive` — throws something away or is hard to take back
 *                    (archiving, merging, ending a series). Also requires
 *                    an explicit `confirmed: true`, so the person hears
 *                    about it before it happens, not after.
 */
export type ToolAccess = "read" | "categorize" | "plan" | "destructive";

const ACCESS_BY_LEVEL: Record<AccessLevel, ToolAccess[]> = {
  view_only: ["read"],
  limited: ["read", "categorize"],
  full: ["read", "categorize", "plan", "destructive"],
};

export function accessLevelAllows(level: AccessLevel, access: ToolAccess): boolean {
  return ACCESS_BY_LEVEL[level].includes(access);
}

/** What the reply says when someone asks for more than their access level
 * covers. Phrased for the model to pass along, not for a log. */
export function accessDeniedMessage(level: AccessLevel, access: ToolAccess): string {
  if (level === "view_only") {
    return "This person's account is view-only — they can ask anything about the budget, but changing it has to come from someone with full access. Tell them that plainly.";
  }
  return `This person's account has limited access: they can categorize and tag charges, but ${
    access === "destructive" ? "removing part of the plan" : "changing the spending plan"
  } is restricted to a full-access member. Tell them that plainly.`;
}

export interface AgentToolContext {
  householdId: string;
  /** Who is talking, for attribution on writes. Null for the dashboard's
   * unauthenticated-in-agent-terms callers and scheduled runs. */
  userId: string | null;
  /** What that person is allowed to do. Defaults to 'full' when a caller
   * has no user to attribute (scheduled jobs act as the household). */
  accessLevel?: AccessLevel;
}

/** A write, described the way the person would recognize it, plus how to
 * take it back (src/messaging/undo.ts). Tools hand these to `ctx.record`;
 * runAgentTool persists them to agent_change_log. */
export interface ChangeRecord {
  summary: string;
  undo: UndoEnvelope;
}

export interface ToolRunContext extends AgentToolContext {
  /** Called by a tool once per write it performs. Recording is what makes
   * "undo that" possible, so a mutating tool that doesn't call this is a
   * bug, not a style choice. */
  record(change: ChangeRecord): void;
}

export interface AgentTool {
  definition: Anthropic.Tool;
  /** True for anything that changes stored data — used to summarize what a
   * turn actually did, and to keep read-only turns cheap to reason about. */
  mutates: boolean;
  access: ToolAccess;
  run(env: Env, ctx: ToolRunContext, input: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Money, dates, arguments
// ---------------------------------------------------------------------------

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function toDollars(cents: number): number {
  return Math.round(cents) / 100;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function num(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key];
  return typeof value === "boolean" ? value : null;
}

export function arr(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

export function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === null) throw new AgentToolError(`'${key}' is required`);
  return value;
}

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A 'YYYY-MM' argument, defaulting to this month. Validated here because
 * a malformed month silently matches no allocations rather than failing,
 * which would look like the write vanished. */
export function monthArg(input: Record<string, unknown>, key = "month"): string {
  const value = str(input, key);
  if (value === null) return currentMonth();
  if (!MONTH_RE.test(value)) throw new AgentToolError(`'${key}' must look like '2026-09'`);
  return value;
}

export function dateArg(input: Record<string, unknown>, key: string): string | null {
  const value = str(input, key);
  if (value === null) return null;
  if (!DATE_RE.test(value)) throw new AgentToolError(`'${key}' must look like '2026-09-14'`);
  return value;
}

/** A tool failure the model is expected to read and recover from (a
 * category name that doesn't exist, an amount that doesn't parse) rather
 * than an internal fault. Surfaces as an is_error tool_result so the model
 * can correct itself in the same turn instead of the whole reply dying. */
export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

/** Destructive tools don't fire on the first ask. The model has to have
 * said what it's about to do and heard back — which, over text, means
 * passing `confirmed: true` on a second call after the person agreed. */
export function requireConfirmation(input: Record<string, unknown>, what: string): void {
  if (bool(input, "confirmed") === true) return;
  throw new AgentToolError(
    `Not done yet — ${what} throws away part of their plan. Ask them to confirm in plain words first, then call this again with confirmed: true.`,
  );
}

/** Categories are addressed by name in conversation ("groceries"), by id
 * in the data. Accept either, and when neither matches, fail with the list
 * of real names so the model's next attempt can be right. */
export async function resolveCategory(env: Env, householdId: string, nameOrId: string): Promise<Category> {
  const categories = await listCategories(env.DB, householdId);
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId;
  const needle = nameOrId.trim().toLowerCase();
  const exact = categories.filter((c) => c.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = categories.filter((c) => c.name.toLowerCase().includes(needle) && !c.archived_at);
  if (partial.length === 1) return partial[0]!;
  const active = categories.filter((c) => !c.archived_at).map((c) => c.name);
  if (partial.length > 1) {
    throw new AgentToolError(`'${nameOrId}' matches more than one category (${partial.map((c) => c.name).join(", ")}) — use the exact name.`);
  }
  throw new AgentToolError(`No category named '${nameOrId}'. Existing categories: ${active.join(", ")}.`);
}

export async function resolveEnvelope(
  env: Env,
  householdId: string,
  categoryNameOrId: string,
): Promise<{ category: Category; envelope: Envelope }> {
  const category = await resolveCategory(env, householdId, categoryNameOrId);
  const envelopes = await listEnvelopes(env.DB, householdId);
  const envelope = envelopes.find((e) => e.category_id === category.id);
  if (!envelope) {
    throw new AgentToolError(
      `'${category.name}' is a ${category.kind} category and has no envelope — only expense and savings categories hold money.`,
    );
  }
  return { category, envelope };
}

/** The before-image of an envelope, in the shape undo wants. Taken before
 * any field is touched, by every tool that touches one. */
export function envelopeUndoEntry(envelope: Envelope) {
  return {
    envelopeId: envelope.id,
    groupName: envelope.group_name,
    monthlyTargetCents: envelope.monthly_target_cents,
    targetDate: envelope.target_date,
    rolloverMode: envelope.rollover_mode,
  };
}

export function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
