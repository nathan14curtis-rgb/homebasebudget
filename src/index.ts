import { Hono } from "hono";
import type { Env } from "./types";
import { NotFoundError } from "./db/client";
import { getHousehold } from "./db/households";
import { requireSession } from "./lib/authMiddleware";
import { authRoute } from "./routes/auth";
import { householdsRoute } from "./routes/households";
import { usersRoute } from "./routes/users";
import { accountsRoute } from "./routes/accounts";
import { categoriesRoute } from "./routes/categories";
import { envelopesRoute } from "./routes/envelopes";
import { transactionsRoute } from "./routes/transactions";
import { rulesRoute } from "./routes/rules";
import { importRoute } from "./routes/importCsv";
import { plaidRoute } from "./routes/plaid";
import { assetsRoute } from "./routes/assets";
import { documentsRoute } from "./routes/documents";
import { maintenanceRoute } from "./routes/maintenance";
import { recurringPatternsRoute } from "./routes/recurringPatterns";
import { occurrencesRoute } from "./routes/occurrences";
import { tagsRoute } from "./routes/tags";
import { messagingDiagnosticsRoute } from "./routes/messagingDiagnostics";
import { chatRoute } from "./routes/chat";
import { budgetRoute } from "./routes/budgetCsv";
import { plaidWebhookRoute } from "./routes/plaidWebhook";
import { sendblueWebhookRoute } from "./routes/sendblueWebhook";
import { handleQueueBatch } from "./queue/consumer";
import { enqueueDailyDigest } from "./messaging/dailyDigest";
import { enqueueHourlyCheckin } from "./messaging/hourlyCheckin";
import { enqueueHourlyPlaidSync } from "./plaid/reconciliation";
import type { MessageQueueMessage, TransactionQueueMessage } from "./lib/queueMessages";

// Both must match wrangler.jsonc's triggers.crons exactly — ScheduledController
// carries the cron expression and nothing else, so these strings are the
// only way to tell the two schedules apart.
const DAILY_DIGEST_CRON = "0 13 * * *";
const HOURLY_SYNC_CRON = "0 * * * *";

// strict: false so "/webhooks/sendblue/" matches the same route as
// "/webhooks/sendblue". A trailing slash used to fall through to Hono's
// default 404, which logs nothing at all — indistinguishable from the
// provider never calling us, and the single hardest version of this bug
// to diagnose. Nothing here relies on the two paths being distinct.
const app = new Hono<{ Bindings: Env }>({ strict: false });

app.onError((err, c) => {
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.route("/api/auth", authRoute);
app.route("/api/households", householdsRoute);

// Every resource below is scoped to one household (PLAN §10) — confirm it
// exists once, up front, instead of every handler re-deriving that. A
// valid session for *this* household is required too (src/lib/authMiddleware.ts)
// — the highest-consequence data in this app used to be reachable by
// anyone who knew a household id; it no longer is.
const scoped = new Hono<{ Bindings: Env }>();
scoped.use("/:householdId/*", async (c, next) => {
  await getHousehold(c.env.DB, c.req.param("householdId"));
  await next();
});
scoped.use("/:householdId/*", requireSession);
scoped.route("/:householdId/users", usersRoute);
scoped.route("/:householdId/accounts", accountsRoute);
scoped.route("/:householdId/categories", categoriesRoute);
scoped.route("/:householdId/envelopes", envelopesRoute);
scoped.route("/:householdId/transactions", transactionsRoute);
scoped.route("/:householdId/rules", rulesRoute);
scoped.route("/:householdId/import", importRoute);
scoped.route("/:householdId/plaid", plaidRoute);
scoped.route("/:householdId/assets", assetsRoute);
scoped.route("/:householdId/documents", documentsRoute);
scoped.route("/:householdId/maintenance", maintenanceRoute);
scoped.route("/:householdId/recurring-patterns", recurringPatternsRoute);
scoped.route("/:householdId/occurrences", occurrencesRoute);
scoped.route("/:householdId/tags", tagsRoute);
scoped.route("/:householdId/budget", budgetRoute);
scoped.route("/:householdId/messaging", messagingDiagnosticsRoute);
// The same conversational agent the iMessage loop uses, from the dashboard.
scoped.route("/:householdId/chat", chatRoute);

app.route("/api/households", scoped);

// Webhook endpoints are top-level, not under /api/households — Plaid and
// Sendblue don't speak our household-scoped API shape, and each handler
// resolves (or verifies) the household itself (PLAN §4.1, §10).
app.route("/webhooks/plaid", plaidWebhookRoute);
app.route("/webhooks/sendblue", sendblueWebhookRoute);

// Anything else under /webhooks/* is a provider calling a URL we don't
// serve — a typo, a stale path, a webhook pointed at the wrong Worker.
// Hono's default 404 is silent, so this was the one arrival that left no
// trace anywhere and looked exactly like "the request never came".
app.all("/webhooks/*", (c) => {
  console.error(
    `[webhooks] no route for ${c.req.method} ${new URL(c.req.url).pathname} — the provider is calling a URL this Worker does not serve. Valid paths: POST /webhooks/sendblue, POST /webhooks/plaid/:householdId`,
  );
  return c.json({ error: "no such webhook endpoint" }, 404);
});

export default {
  fetch: app.fetch,

  queue: handleQueueBatch,

  // Two cron schedules, both set in wrangler.jsonc — branch on which one
  // fired rather than one handler per schedule, since ScheduledController
  // only carries the cron expression, not a name.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === DAILY_DIGEST_CRON) {
      const count = await enqueueDailyDigest(env);
      console.log(`daily digest: enqueued for ${count} household(s)`);
      return;
    }
    if (controller.cron !== HOURLY_SYNC_CRON) {
      // A schedule in wrangler.jsonc that nothing here branches on — the
      // two lists have drifted. Run the hourly cycle anyway (it's the
      // idempotent one) rather than silently doing nothing, and say so.
      console.warn(`scheduled: unrecognized cron "${controller.cron}" — running the hourly cycle; check wrangler.jsonc against src/index.ts`);
    }
    // The hourly cycle, in one place because the order matters: pull from
    // Plaid first, then ask about whatever that pull couldn't categorize.
    // The check-in job carries its own delay (hourlyCheckin.ts) so the
    // sync jobs ahead of it have drained by the time it runs.
    const items = await enqueueHourlyPlaidSync(env);
    const households = await enqueueHourlyCheckin(env);
    console.log(`hourly cycle: enqueued sync for ${items} plaid item(s) and a check-in for ${households} household(s)`);
  },
} satisfies ExportedHandler<Env, TransactionQueueMessage | MessageQueueMessage>;
