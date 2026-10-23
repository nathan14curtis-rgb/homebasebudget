import { getAccount } from "../db/accounts";
import { listHouseholds } from "../db/households";
import { listQueuedClarificationsForHousehold, markClarificationSent, markClarificationTimedOut } from "../db/clarifications";
import { getTransaction } from "../db/transactions";
import { listVerifiedUsersForHousehold } from "../db/users";
import { describeError } from "../lib/errors";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { recordAssistantMessage } from "./agent";
import { sendToHouseholdGroup } from "./groupChat";
import { householdQuietDelaySeconds } from "./quietHours";

/**
 * The hourly ask.
 *
 * Categorization no longer texts the moment it gets stuck (that produced
 * a message per charge, whenever the charge happened to land). Instead the
 * pipeline leaves a queued clarification behind, and this — running once
 * an hour, right after the hourly Plaid sync — collects everything that
 * piled up in that hour and asks about all of it in one message.
 *
 * The window is the point: the bot only ever brings up charges from the
 * period it just looked at. Anything older than STALE_ASK_HOURS is timed
 * out unasked and left to the dashboard's review queue, so nobody gets a
 * text about a charge from last week that they already forgot about.
 */

// Cloudflare Queues' per-message delaySeconds cap.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

/** An ask that never made it out within a day (a long quiet-hours window,
 * a household that went unverified) stops being worth sending. */
const STALE_ASK_HOURS = 24;

const MAX_ASKS_PER_MESSAGE = 8;

/** Long enough for the hour's /transactions/sync + categorize jobs to
 * drain ahead of the ask, short enough that "new charge" still means this
 * hour to the person reading it. */
export const SYNC_SETTLE_DELAY_SECONDS = 180;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Cron fan-out, same shape as enqueueDailyDigest: one queued job per
 * household so a slow send for one doesn't block the rest. */
export async function enqueueHourlyCheckin(env: Env): Promise<number> {
  const households = await listHouseholds(env.DB);
  for (const household of households) {
    const message: MessageQueueMessage = { type: "hourly_checkin", householdId: household.id };
    // Sent behind the hourly Plaid sync jobs that were enqueued alongside
    // it, so this hour's charges are actually in the database — and on the
    // message queue, whose concurrency of 1 is what keeps sends serialized.
    await env.MESSAGE_QUEUE.send(message, { delaySeconds: SYNC_SETTLE_DELAY_SECONDS });
  }
  return households.length;
}

/**
 * Sends this hour's batched ask for one household — or defers the whole
 * job into the morning during anyone's quiet hours, which is also what
 * turns an overnight pile-up into one message at breakfast rather than
 * six texts at 2am (PLAN.md §5.5).
 */
export async function sendHourlyCheckin(env: Env, householdId: string, requeue: (delaySeconds: number) => Promise<void>): Promise<void> {
  const queued = await listQueuedClarificationsForHousehold(env.DB, householdId);
  if (queued.length === 0) return;

  const staleBefore = isoHoursAgo(STALE_ASK_HOURS);
  const fresh = [];
  for (const clarification of queued) {
    if (clarification.created_at < staleBefore) {
      console.log(`[hourly_checkin] clarification ${clarification.id} is older than ${STALE_ASK_HOURS}h — timing out unasked`);
      await markClarificationTimedOut(env.DB, clarification.id);
      continue;
    }
    fresh.push(clarification);
  }
  if (fresh.length === 0) return;

  const users = await listVerifiedUsersForHousehold(env.DB, householdId);
  if (users.length === 0) {
    console.log(`[hourly_checkin] household ${householdId}: nobody verified — leaving ${fresh.length} ask(s) for the dashboard`);
    return;
  }

  const delaySeconds = householdQuietDelaySeconds(users, new Date());
  if (delaySeconds > 0) {
    console.log(`[hourly_checkin] household ${householdId} within quiet hours — requeuing for ${delaySeconds}s`);
    await requeue(Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS));
    return;
  }

  const asked = fresh.slice(0, MAX_ASKS_PER_MESSAGE);
  const lines: string[] = [];
  const sent = [];
  for (const clarification of asked) {
    try {
      const transaction = await getTransaction(env.DB, householdId, clarification.transaction_id);
      const account = await getAccount(env.DB, householdId, transaction.account_id);
      const dollars = (Math.abs(transaction.amount_cents) / 100).toFixed(2);
      lines.push(`- $${dollars} at ${transaction.normalized_merchant ?? transaction.raw_description} (${account.name})`);
      sent.push(clarification);
    } catch (err) {
      // The transaction went away (a Plaid `removed`, a manual delete)
      // between the ask being queued and now — close it out rather than
      // asking about something that no longer exists.
      console.error(`[hourly_checkin] clarification ${clarification.id} points at a missing transaction: ${describeError(err)}`);
      await markClarificationTimedOut(env.DB, clarification.id);
    }
  }
  if (sent.length === 0) return;

  const remaining = fresh.length - asked.length;
  const header = sent.length === 1 ? "New charge I couldn't place:" : `${sent.length} new charges I couldn't place:`;
  const text = [
    header,
    ...lines,
    ...(remaining > 0 ? [`(plus ${remaining} more waiting in the sheet — Status says Needs category)`] : []),
    "",
    "Just tell me what they were — plain English is fine.",
  ].join("\n");

  const { messageHandle } = await sendToHouseholdGroup(env, householdId, text);
  for (const clarification of sent) {
    await markClarificationSent(env.DB, clarification.id, messageHandle);
  }
  // Part of the thread, not a side channel: a reply of "both were groceries"
  // only makes sense to the agent if it can see what was asked.
  await recordAssistantMessage(env, householdId, text);
  console.log(`[hourly_checkin] household ${householdId}: asked about ${sent.length} charge(s), handle=${messageHandle ?? "none"}`);
}
