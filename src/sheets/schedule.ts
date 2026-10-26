import { listSheetLinks } from "../db/sheetLinks";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";

/** One sheet_sync job per household with a connected sheet. Queued rather
 * than run inline so each household's pass gets its own retries and a
 * slow Google response can't hold up the cron. */
export async function enqueueSheetSyncs(env: Env): Promise<number> {
  const links = await listSheetLinks(env.DB);
  if (links.length === 0) return 0;
  const messages: { body: TransactionQueueMessage }[] = links.map((l) => ({ body: { type: "sheet_sync", householdId: l.household_id } }));
  await env.TRANSACTION_QUEUE.sendBatch(messages);
  return links.length;
}
