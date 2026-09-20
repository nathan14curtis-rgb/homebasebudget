import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { CategoryKind, Env } from "../types";
import {
  archiveCategory,
  createCategory,
  createEnvelopeForCategory,
  findActiveCategoryByName,
  listCategories,
  renameCategory,
  unarchiveCategory,
} from "../db/categories";
import { listUncategorizedMerchantSummary } from "../db/transactions";
import { suggestCategories } from "../categorization/categorySuggestions";

const CATEGORY_KINDS: CategoryKind[] = ["expense", "income", "savings", "transfer"];

export const categoriesRoute = new Hono<{ Bindings: Env }>();

categoriesRoute.get("/", async (c) => {
  const categories = await listCategories(c.env.DB, requireParam(c, "householdId"));
  return c.json(categories);
});

categoriesRoute.post("/", async (c) => {
  const body = await c.req.json<{
    name?: string;
    kind?: string;
    parentId?: string;
    groupName?: string;
    monthlyTargetCents?: number;
    targetDate?: string;
  }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.kind || !CATEGORY_KINDS.includes(body.kind as CategoryKind)) {
    return c.json({ error: `kind must be one of ${CATEGORY_KINDS.join(", ")}` }, 400);
  }

  const householdId = requireParam(c, "householdId");
  // Two active "Groceries" is never what anyone meant, and the schema
  // can't stop it (see findActiveCategoryByName) — say so instead of
  // quietly making a twin the person then has to notice and archive.
  const duplicate = await findActiveCategoryByName(c.env.DB, householdId, body.name);
  if (duplicate) return c.json({ error: `You already have a category called "${duplicate.name}" — edit that one instead.` }, 409);

  const category = await createCategory(c.env.DB, householdId, {
    name: body.name.trim(),
    kind: body.kind as CategoryKind,
    parentId: body.parentId,
  });

  // Expense/savings categories are envelopes (PLAN §3) — created together
  // so "an envelope you create here is immediately available as an answer
  // over text" (§9) instead of a second setup step.
  if (category.kind === "expense" || category.kind === "savings") {
    const envelope = await createEnvelopeForCategory(c.env.DB, householdId, category, {
      groupName: body.groupName,
      monthlyTargetCents: body.monthlyTargetCents ?? null,
      targetDate: body.targetDate ?? null,
    });
    return c.json({ category, envelope }, 201);
  }

  return c.json({ category, envelope: null }, 201);
});

// Registered before "/:categoryId" for the same reason envelopesRoute's
// "/summary" is (see src/routes/envelopes.ts) — Hono prioritizes a literal
// segment regardless of order, but this is still the right spot for it.
// Propose-only: never creates anything (PLAN.md-style "a person approves
// before it lands" — see the Spending Plan page's "Suggest categories"
// button). A household with no uncategorized merchant activity gets an
// empty list rather than an LLM call that has nothing to work with.
categoriesRoute.get("/suggest", async (c) => {
  const householdId = requireParam(c, "householdId");
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "AI category suggestions aren't configured" }, 503);

  const [existing, merchants] = await Promise.all([
    listCategories(c.env.DB, householdId),
    listUncategorizedMerchantSummary(c.env.DB, householdId),
  ]);
  if (merchants.length === 0) return c.json([]);

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const suggestions = await suggestCategories(
    client,
    existing.filter((cat) => !cat.archived_at).map((cat) => ({ name: cat.name, kind: cat.kind })),
    merchants,
  );
  return c.json(suggestions);
});

// Rename only — kind can't change after creation (renameCategory's doc
// comment explains why); use archive + create-new for that.
categoriesRoute.patch("/:categoryId", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const categoryId = requireParam(c, "categoryId");
  const duplicate = await findActiveCategoryByName(c.env.DB, requireParam(c, "householdId"), body.name);
  if (duplicate && duplicate.id !== categoryId) {
    return c.json({ error: `You already have a category called "${duplicate.name}".` }, 409);
  }
  const category = await renameCategory(c.env.DB, requireParam(c, "householdId"), categoryId, body.name.trim());
  return c.json(category);
});

categoriesRoute.post("/:categoryId/archive", async (c) => {
  const category = await archiveCategory(c.env.DB, requireParam(c, "householdId"), requireParam(c, "categoryId"));
  return c.json(category);
});

categoriesRoute.post("/:categoryId/unarchive", async (c) => {
  const category = await unarchiveCategory(c.env.DB, requireParam(c, "householdId"), requireParam(c, "categoryId"));
  return c.json(category);
});
