import { categorizeTransaction } from "../categorization/pipeline";
import { getInboundMessage, markInboundMessageProcessed } from "../db/inboundMessages";
import { describeError } from "../lib/errors";
import { sendDailyDigest } from "../messaging/dailyDigest";
import { processInboundReply } from "../messaging/inboundProcessing";
import { sendHourlyCheckin } from "../messaging/hourlyCheckin";
import { sendToHouseholdGroup } from "../messaging/groupChat";
import { handleItemWebhook, syncPlaidItem } from "../plaid/sync";
import { syncHouseholdSheet } from "../sheets/sync";
import type { MessageQueueMessage, TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";

const MESSAGE_QUEUE_NAME = "curtisclan-messages";

/** One handler for both bound queues (PLAN.md §2 gotcha #2 territory —
 * batches must stay small/fast per invocation), branching on batch.queue.
 * Each message is acked or retried individually so one bad job doesn't
 * block the rest of its batch. */
export async function handleQueueBatch(batch: MessageBatch<TransactionQueueMessage | MessageQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue === MESSAGE_QUEUE_NAME) {
        await handleMessageQueueMessage(message.body as MessageQueueMessage, env);
      } else {
        await handleTransactionQueueMessage(message.body as TransactionQueueMessage, env);
      }
      message.ack();
    } catch (err) {
      const jobType = message.body && (message.body as { type?: string }).type;
      console.error(`queue job failed (${batch.queue}, ${jobType}): ${describeError(err)}`);
      message.retry();
    }
  }
}

async function handleTransactionQueueMessage(msg: TransactionQueueMessage, env: Env): Promise<void> {
  console.log(`[queue] transaction: ${msg.type}`, msg);
  switch (msg.type) {
    case "plaid_sync":
      await syncPlaidItem(env, msg.householdId, msg.plaidItemId);
      return;
    case "item_webhook":
      await handleItemWebhook(env, msg.householdId, msg.plaidItemId, msg.webhookCode);
      return;
    case "categorize":
      await categorizeTransaction(env, msg.householdId, msg.transactionId, { skipClarification: msg.skipClarification });
      return;
    case "resolve_reply": {
      const inbound = await getInboundMessage(env.DB, msg.inboundMessageId);
      if (!inbound) {
        console.error(`[queue] resolve_reply: inbound message ${msg.inboundMessageId} not found — nothing to process`);
        return;
      }
      if (inbound.processed_at) {
        console.log(`[queue] resolve_reply: inbound ${inbound.id} already processed at ${inbound.processed_at} — skipping redelivery`);
        return;
      }
      try {
        await processInboundReply(env, msg.householdId, msg.userId, inbound.content);
      } catch (err) {
        // processInboundReply handles its own expected failures by texting
        // the household back. Anything reaching here is unexpected, and
        // rethrowing would retry five times and then drop the reply
        // silently — the person who texted in never learns their message
        // died. Tell them once, mark it processed, and let the queue ack:
        // a retry of an unexpected error is overwhelmingly likely to fail
        // the same way while re-running whatever partial work succeeded.
        console.error(`[queue] resolve_reply failed for inbound ${inbound.id} (household ${msg.householdId}): ${describeError(err)}`);
        await sendToHouseholdGroup(env, msg.householdId, "Got your text, but something went wrong on my end handling it — try again, or categorize it in the budget sheet.").catch((sendErr) => {
          console.error(`[queue] resolve_reply: could not notify household ${msg.householdId} of the failure: ${describeError(sendErr)}`);
        });
      }
      await markInboundMessageProcessed(env.DB, inbound.id);
      return;
    }
    case "sheet_sync": {
      const result = await syncHouseholdSheet(env, msg.householdId);
      console.log(`[queue] sheet_sync ${msg.householdId}: ${result.status}, ${result.applied} applied, ${result.failed} refused`);
      return;
    }
  }
}

async function handleMessageQueueMessage(msg: MessageQueueMessage, env: Env): Promise<void> {
  console.log(`[queue] message: ${msg.type}`, msg);
  switch (msg.type) {
    case "hourly_checkin":
      await sendHourlyCheckin(env, msg.householdId, async (delaySeconds) => {
        await env.MESSAGE_QUEUE.send(msg, { delaySeconds });
      });
      return;
    case "daily_digest":
      await sendDailyDigest(env, msg.householdId);
      return;
  }
}
