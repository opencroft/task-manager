// Seam owned by milestones: its schema migrations, applied after the boards'
// by the runner in ../db.ts. Forward-only: never edit or reorder an entry once
// it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const milestoneMigrations: Migration[] = [
  {
    id: 'milestones-0001-init',
    up(db) {
      db.exec(`
        CREATE TABLE milestone (
          id INTEGER PRIMARY KEY,
          -- Free text, checked by the service; unique ignoring case, so a
          -- task write naming "beta" finds "Beta".
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'archived')),
          start_date TEXT,
          target_date TEXT,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- A task is in at most one milestone. Deleting a milestone takes its
        -- tasks out (their dates kept) and then removes the row, in one
        -- transaction, so no task points at a missing one. Every existing
        -- task starts in none.
        ALTER TABLE task ADD COLUMN milestone_id INTEGER REFERENCES milestone (id);
        CREATE INDEX task_milestone ON task (milestone_id);
      `)
    },
  },
]
