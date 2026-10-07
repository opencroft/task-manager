// Seam owned by agent mentions: its schema migrations, applied after the
// attachments' by the runner in ../db.ts. Forward-only: never edit or reorder
// an entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const mentionMigrations: Migration[] = [
  {
    id: 'mentions-0001-init',
    up(db) {
      db.exec(`
        -- One agent's session on one task, reused by every later mention of it.
        -- The project's chat for mentions is 'mention_chat' in project_meta.
        CREATE TABLE mention_session (
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          chat_ref TEXT,
          chat_slug TEXT,
          thread_id TEXT,
          thread_ref TEXT,
          started_at TEXT NOT NULL,
          last_at TEXT NOT NULL,
          note TEXT,
          PRIMARY KEY (task_id, agent_id)
        );

        -- Every mention sent to an agent, for the loop guard: the comment that
        -- carried it (one round, however many agents it named), whether an
        -- agent or a person wrote it, and when.
        CREATE TABLE mention_delivery (
          id INTEGER PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          comment_id INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          by_agent INTEGER NOT NULL CHECK (by_agent IN (0, 1)),
          at TEXT NOT NULL
        );
        CREATE INDEX mention_delivery_task ON mention_delivery (task_id, at);
      `)
    },
  },
  {
    // Mention sessions open in the space's chat: the project's own choice goes.
    // Sessions keep chat_ref/chat_slug, which say where each thread is.
    id: 'mentions-0002-space-chat',
    up(db) {
      db.exec("DELETE FROM project_meta WHERE key = 'mention_chat'")
    },
  },
]
