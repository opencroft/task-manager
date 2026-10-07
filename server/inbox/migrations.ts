// Seam owned by the inbox: its schema migrations,
// applied after the workflow ones by the runner in ../db.ts. Forward-only:
// never edit or reorder an entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const inboxMigrations: Migration[] = [
  {
    id: 'inbox-0001-init',
    up(db) {
      db.exec(`
        -- One row per notification per recipient. The recipient is
        -- 'person:<directory user id>' or 'agent:<agent node id>'. What the kit
        -- shows beyond the task (workflow, step, statuses, excerpt) is a JSON
        -- snapshot taken when it happened; the task itself is read live, and
        -- deleting it deletes its notifications.
        CREATE TABLE inbox (
          id INTEGER PRIMARY KEY,
          recipient TEXT NOT NULL,
          kind TEXT NOT NULL,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          actor_kind TEXT CHECK (actor_kind IN ('agent', 'person')),
          actor_name TEXT,
          detail TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          read_at TEXT,
          CHECK ((actor_kind IS NULL) = (actor_name IS NULL))
        );
        CREATE INDEX inbox_recipient ON inbox (recipient, id);
        CREATE INDEX inbox_unread ON inbox (recipient) WHERE read_at IS NULL;
        CREATE INDEX inbox_task ON inbox (task_id);
      `)
    },
  },
  {
    id: 'inbox-0002-mute',
    up(db) {
      db.exec(`
        -- A recipient who muted a task gets no new notification about it; the
        -- key is the same 'person:<id>' or 'agent:<id>' the inbox rows use.
        CREATE TABLE inbox_mute (
          recipient TEXT NOT NULL,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (recipient, task_id)
        );
      `)
    },
  },
]
