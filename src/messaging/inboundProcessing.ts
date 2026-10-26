import type Anthropic from "@anthropic-ai/sdk";
import { describeError } from "../lib/errors";
import type { Env } from "../types";
import { runAgentTurn } from "./agent";
import { sendToHouseholdGroup } from "./groupChat";

/**
 * One inbound text → one turn of the conversation (src/messaging/agent.ts)
 * → one reply in the household's group thread.
 *
 * This used to be a router: a "fix <merchant>" regex, then a batch
 * resolver that paired the reply against open items, then a separate Q&A
 * call for whatever was left over, each with its own failure text. All of
 * that is now the agent's job, including deciding that a message is a
 * question rather than a categorization — the only thing left here is the
 * rule that survived every rewrite: a text that arrives always gets an
 * answer back (PLAN.md §5.3). Silence reads as "my message vanished",
 * which is worse than any error we could send.
 *
 * `userId` is who sent the text; it rides along to the agent purely for
 * attribution on anything the turn writes.
 */
export async function processInboundReply(env: Env, householdId: string, userId: string, content: string, anthropicClient?: Anthropic): Promise<void> {
  if (!env.ANTHROPIC_API_KEY && !anthropicClient) {
    console.error(`[inboundReply] ANTHROPIC_API_KEY not configured — cannot answer household ${householdId}`);
    await sendToHouseholdGroup(env, householdId, "Got your text, but I can't answer yet — that part isn't set up. You can still categorize in the budget sheet.");
    return;
  }

  let reply: string;
  try {
    ({ reply } = await runAgentTurn(env, { householdId, userId, channel: "imessage", text: content }, anthropicClient));
  } catch (err) {
    console.error(`[inboundReply] agent turn failed for household ${householdId}: ${describeError(err)}`);
    await sendToHouseholdGroup(env, householdId, "Got your text, but hit a hiccup working on it — try again in a bit, or use the budget sheet.");
    return;
  }

  await sendToHouseholdGroup(env, householdId, reply);
}
