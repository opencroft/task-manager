// Seam owned by the forge links: its schema migrations, applied after the
// OpenProject import's by the runner in ../db.ts. Forward-only: never edit or
// reorder an entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const forgeMigrations: Migration[] = [
  {
    id: 'forge-0001-init',
    up(db) {
      db.exec(`
        -- Every pull request read from the forge, whether or not it mentions a task.
        CREATE TABLE pull_request (
          id INTEGER PRIMARY KEY,
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
          author TEXT NOT NULL,
          url TEXT NOT NULL,
          -- Kept from while it was open: a merge that deletes the branch leaves the forge reporting refs/pull/N/head.
          branch TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE (repo, number)
        );

        -- The task numbers a pull request mentions, whether or not the task
        -- exists yet: a task gets its links by number when it is read, so one
        -- created (or imported) later finds the pull requests that already
        -- name it. Numbers are never reused, so a deleted task's stay unmatched.
        CREATE TABLE pull_request_mention (
          pr_id INTEGER NOT NULL REFERENCES pull_request (id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          PRIMARY KEY (pr_id, number)
        );
        CREATE INDEX pull_request_mention_number ON pull_request_mention (number);

        -- The one connection: address, owner and the Secrets Store key NAME
        -- (never the token); the read cursor, and how the last read went.
        CREATE TABLE forge_connection (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          url TEXT NOT NULL,
          owner TEXT NOT NULL,
          secret_key TEXT NOT NULL,
          cursor TEXT,
          last_sync_at TEXT,
          last_error TEXT
        );
      `)
    },
  },
]
