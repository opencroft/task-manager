// Seam owned by versions: its schema migrations, applied after the project
// settings' by the runner in ../db.ts. Forward-only: never edit or reorder an
// entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const versionMigrations: Migration[] = [
  {
    id: 'versions-0001-init',
    up(db) {
      db.exec(`
        CREATE TABLE version (
          id INTEGER PRIMARY KEY,
          -- Semver, checked by the service; unique as written.
          name TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'released', 'archived')),
          target_date TEXT,
          released_at TEXT,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- A task is planned into at most one version. Versions are archived,
        -- never deleted, so nothing has to happen to a task when one goes.
        ALTER TABLE task ADD COLUMN version_id INTEGER REFERENCES version (id);
        CREATE INDEX task_version ON task (version_id);
      `)
    },
  },
]
