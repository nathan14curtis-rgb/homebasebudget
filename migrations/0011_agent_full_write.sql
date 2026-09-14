-- The texting agent gets the whole budget, not a slice of it.
--
-- Two things a fully-capable conversational agent needs that the schema
-- had no room for:
--
--  1. Whether an envelope's leftover money is supposed to carry into next
--     month at all. The balance recurrence (PLAN.md §3) always carried it,
--     which is right for a sinking fund and wrong for "groceries starts
--     fresh on the 1st". Stored per envelope so the answer is the
--     household's, not the app's; 'carry' is the default so nothing about
--     an existing envelope changes when this lands.
--
--  2. A record of what the agent wrote, in enough detail to undo it. A
--     text-message edit has no dialog to cancel and no form to re-open —
--     "undo that" is the only affordance the surface has, so every write
--     the agent makes stores how to reverse itself.

ALTER TABLE envelope ADD COLUMN rollover_mode TEXT NOT NULL DEFAULT 'carry';

-- One row per write an agent turn performed. `summary` is what the person
-- would recognize it as ("set Groceries to $250 for 2026-09"), which is
-- what an "undo the grocery change from Tuesday" has to match against.
-- `undo` is a JSON envelope {kind, ...} interpreted by
-- src/messaging/undo.ts — a before-image, not a diff, so replaying it is
-- idempotent. kind 'none' means the change is recorded but not reversible.
CREATE TABLE agent_change_log (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL REFERENCES household(id),
  -- Who asked for it. Null when the change came from a scheduled job
  -- rather than a person's text.
  user_id        TEXT REFERENCES user(id),
  tool_name      TEXT NOT NULL,
  summary        TEXT NOT NULL,
  undo           TEXT NOT NULL,
  -- Set when this change has been reversed, so it can't be undone twice.
  reverted_at    TEXT,
  -- The change-log row that did the reversing, for an audit trail that
  -- reads in both directions.
  reverted_by_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_change_log_household ON agent_change_log(household_id, created_at);
