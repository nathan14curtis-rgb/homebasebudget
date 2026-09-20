import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type ChatMessage } from "../api";
import { Notice } from "./Notice";

/**
 * The budgeting bot, in the browser. Not a second assistant: this posts to
 * the same conversational agent the iMessage loop runs
 * (src/messaging/agent.ts) and reads the same stored thread, so a question
 * asked here shows up in the context of the next text, and a correction
 * texted from the couch shows up here.
 *
 * Anything the agent writes — a recategorized charge, a retargeted
 * envelope, a new goal — lands in the same tables the rest of the
 * dashboard reads, so `onChanged` refreshes those pages whenever a turn
 * actually changed something.
 */

const SUGGESTIONS = [
  "How much is left on groceries?",
  "Where did the money go last month?",
  "Bump dining out to $400",
  "Start a $4,000 vacation fund by next June",
];

interface Props {
  householdId: string;
  currentUserId: string | null;
  onChanged: () => void;
}

export function ChatPage({ householdId, currentUserId, onChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getChat(householdId)
      .then((result) => setMessages(result.messages))
      .catch((err) => setError(errorMessage(err, "Couldn't load the conversation.")));
  }, [householdId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setError(null);
      setDraft("");
      setSending(true);
      // Shown immediately with a local id — the turn can take a few
      // seconds of tool calls, and a message that vanishes while you wait
      // reads as a failure.
      const pending: ChatMessage = {
        id: `local_${Date.now()}`,
        role: "user",
        content: trimmed,
        channel: "dashboard",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, pending]);
      try {
        const { reply, changed } = await api.sendChat(householdId, trimmed, currentUserId);
        setMessages((prev) => [
          ...prev,
          { id: `local_reply_${Date.now()}`, role: "assistant", content: reply, channel: "dashboard", createdAt: new Date().toISOString() },
        ]);
        if (changed) onChanged();
      } catch (err) {
        setError(errorMessage(err, "That didn't go through. Try again."));
        setDraft(trimmed);
        setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      } finally {
        setSending(false);
      }
    },
    [currentUserId, householdId, onChanged, sending],
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  return (
    <section className="section">
      <div className="card card--padded chat-log">
        {messages.length === 0 && !sending && (
          <p className="hint">
            Ask anything about your money, or tell me what to change — categories, targets, goals, or what a charge really was. This is the same thread as
            your texts.
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble chat-bubble--${message.role}`}>
            {message.content}
            {message.channel === "imessage" && <span className="chat-channel">via text</span>}
            {message.channel === "scheduled" && <span className="chat-channel">sent to you</span>}
          </div>
        ))}
        {sending && <div className="chat-bubble chat-bubble--assistant chat-bubble--pending">Thinking…</div>}
        <div ref={bottomRef} />
      </div>

      {messages.length === 0 && (
        <div className="chat-suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} className="secondary" type="button" onClick={() => void send(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form className="chat-composer" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about the budget, or tell me what to change…"
          aria-label="Message"
        />
        <button type="submit" disabled={sending || draft.trim() === ""}>
          Send
        </button>
      </form>
      <Notice notice={error ? { kind: "error", text: error } : null} onDismiss={() => setError(null)} />
    </section>
  );
}
