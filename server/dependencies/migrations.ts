// Seam owned by dependencies: its schema migrations, applied after the inbox
// ones by the runner in ../db.ts. Forward-only: never edit or reorder an entry
// once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const dependencyMigrations: Migration[] = [
  {
    id: 'dependencies-0001-init',
    up(db) {
      db.exec(`
        -- One row per "blocker blocks blocked". Deleting either task deletes the
        -- link. Cycles are refused by the store, which the schema cannot express.
        CREATE TABLE task_link (
          blocker_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          blocked_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (blocker_id, blocked_id),
          CHECK (blocker_id <> blocked_id)
        );
        CREATE INDEX task_link_blocked ON task_link (blocked_id);
      `)
    },
  },
  {
    id: 'dependencies-0002-relation-types',
    up(db) {
      db.exec(`
        -- One row per "from <type> to": blocks (the only one that holds a task
        -- back), duplicates, follows, and relates, which runs both ways and is
        -- kept once with the lower id first. The blocks rows move over as they are.
        CREATE TABLE task_relation (
          from_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          to_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('blocks', 'relates', 'duplicates', 'follows')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (from_id, to_id, type),
          CHECK (from_id <> to_id),
          CHECK (type <> 'relates' OR from_id < to_id)
        );
        CREATE INDEX task_relation_to ON task_relation (to_id);
        INSERT INTO task_relation (from_id, to_id, type, created_at)
          SELECT blocker_id, blocked_id, 'blocks', created_at FROM task_link;
        DROP TABLE task_link;
      `)
    },
  },
]
