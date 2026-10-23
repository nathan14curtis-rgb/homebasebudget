-- The Google Sheet is the household's editing surface (src/sheets/).
--
-- The database stays the source of truth; the sheet is a two-way mirror.
-- Every few minutes the Worker reads the sheet, compares each row with
-- what it last wrote there (the snapshot), applies only what a person
-- changed — through the same agent tools the texting bot uses, so the
-- change log and "undo that" cover sheet edits too — and then rewrites the
-- sheet from the database.

CREATE TABLE sheet_link (
  household_id    TEXT PRIMARY KEY REFERENCES household(id),
  spreadsheet_id  TEXT NOT NULL,
  -- Which month the Budget and Bills This Month tabs are showing. Set from
  -- the sheet's own month cell; null means "the current month".
  view_month      TEXT,
  -- Bumped in code when the tab layout changes, so formatting, dropdowns
  -- and protections are re-applied once rather than on every sync.
  layout_version  INTEGER NOT NULL DEFAULT 0,
  -- A crude per-household lock: cron and on-demand syncs can overlap, and
  -- two passes diffing against the same snapshot would apply an edit twice.
  locked_until    TEXT,
  last_synced_at  TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- What the Worker last wrote to each tab, normalized per column, keyed by
-- row id. A cell that differs from its snapshot is a person's edit; a cell
-- that matches is left alone even if the database moved underneath it.
-- `errors` holds edits that couldn't be applied, shown in the tab's Sync
-- column until they age out.
CREATE TABLE sheet_tab_snapshot (
  household_id  TEXT NOT NULL REFERENCES household(id),
  tab           TEXT NOT NULL,
  snapshot      TEXT NOT NULL,
  errors        TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (household_id, tab)
);

-- One sheet, one household: every household syncs through the same
-- service account, so a shared sheet would be overwritten by both.
CREATE UNIQUE INDEX sheet_link_spreadsheet ON sheet_link (spreadsheet_id);
