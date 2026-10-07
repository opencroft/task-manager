// Seam owned by the OpenProject import: its schema migrations, applied after
// the versions' by the runner in ../db.ts. Forward-only: never edit or reorder
// an entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const openProjectMigrations: Migration[] = [
  {
    id: 'openproject-0001-init',
    up(db) {
      db.exec(`
        -- Where an imported task came from, so a re-run finds it again instead
        -- of adding it twice. source is the OpenProject address; source_id the
        -- work package's id there. Deleting the task forgets it.
        CREATE TABLE task_source (
          task_id INTEGER PRIMARY KEY REFERENCES task (id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          -- The work package's updatedAt when it was last brought in: a re-run
          -- changes the task only when OpenProject has changed since.
          source_updated_at TEXT NOT NULL,
          UNIQUE (source, source_id)
        );

        -- The same for comments, by the OpenProject activity id.
        CREATE TABLE comment_source (
          comment_id INTEGER PRIMARY KEY REFERENCES comment (id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          UNIQUE (source, source_id)
        );

        -- The one saved connection: address, project and the Secrets Store key
        -- NAME (never the token), the mapping last used, and the last result.
        CREATE TABLE openproject_import (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          url TEXT NOT NULL,
          project TEXT NOT NULL,
          secret_key TEXT NOT NULL,
          mapping TEXT,
          keep_numbers INTEGER NOT NULL DEFAULT 1,
          last_at TEXT,
          last_by TEXT,
          last_result TEXT
        );
      `)
    },
  },
  {
    id: 'openproject-0002-refresh',
    up(db) {
      db.exec(`
        -- The values the import last wrote to the task, as JSON: a field that
        -- differs from them now was edited here since, and a re-run keeps it.
        ALTER TABLE task_source ADD COLUMN imported TEXT;

        -- Import again every sync_minutes, off while null; the last scheduled
        -- run's failure, and when it was tried, so a failing one waits too.
        ALTER TABLE openproject_import ADD COLUMN sync_minutes INTEGER;
        ALTER TABLE openproject_import ADD COLUMN sync_tried_at TEXT;
        ALTER TABLE openproject_import ADD COLUMN sync_error TEXT;
      `)
      // Tasks imported before this: what they hold now is taken as what was
      // imported, since nothing recorded the difference until here.
      db.exec(`
        UPDATE task_source SET imported = (
          SELECT json_object(
            'summary', t.summary, 'description', t.description, 'status', t.status_id, 'type', t.type, 'priority', t.priority,
            'assignee', CASE WHEN t.assignee_name IS NULL THEN NULL ELSE json_object('kind', t.assignee_kind, 'id', t.assignee_id, 'name', t.assignee_name) END,
            'start', t.start_date, 'end', t.end_date, 'parent', t.parent_id)
          FROM task t WHERE t.id = task_source.task_id)
      `)
    },
  },
  {
    id: 'openproject-0003-relations',
    up(db) {
      db.exec(`
        -- Each OpenProject relation imported once, by its id there: a re-run
        -- adds only new ones, and never one removed here since.
        CREATE TABLE relation_source (
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY (source, source_id)
        );
      `)
    },
  },
  {
    id: 'openproject-0004-attachments',
    up(db) {
      db.exec(`
        -- Each OpenProject attachment imported once, by its id there, with the
        -- attachment it became. The row outlives that attachment, so one
        -- removed here is not brought back; it goes with the task, so a task
        -- deleted and imported again gets its files again.
        CREATE TABLE attachment_source (
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          attachment_id TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY (source, source_id)
        );
        CREATE INDEX attachment_source_task ON attachment_source (task_id);

        -- The work package's updatedAt when its attachments were last read: an
        -- attachment added in OpenProject changes it, so the others are not
        -- read again. Null until the first read.
        ALTER TABLE task_source ADD COLUMN attachments_read_at TEXT;
      `)
    },
  },
]
