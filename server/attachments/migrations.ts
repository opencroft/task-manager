// Seam owned by attachments: its schema migrations, applied after the saved
// views' by the runner in ../db.ts. Forward-only: never edit or reorder an
// entry once it has shipped; append a new one.

import fs from 'node:fs'

import type { Migration } from '../db.ts'
import { attachmentFile, attachmentsDir } from './files.ts'

export const attachmentMigrations: Migration[] = [
  {
    id: 'attachments-0001-init',
    up(db) {
      db.exec(`
        -- The bytes live in the instance's database, beside their metadata, so
        -- deleting a task (or a subtree) removes its files in the same
        -- transaction and nothing is left behind on disk.
        CREATE TABLE task_attachment (
          id TEXT PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          content_type TEXT NOT NULL,
          previewable INTEGER NOT NULL CHECK (previewable IN (0, 1)),
          uploader_kind TEXT NOT NULL CHECK (uploader_kind IN ('agent', 'person')),
          uploader_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX task_attachment_task ON task_attachment (task_id, created_at);

        -- Kept apart so listing attachments never reads their bytes.
        CREATE TABLE task_attachment_content (
          attachment_id TEXT PRIMARY KEY REFERENCES task_attachment (id) ON DELETE CASCADE,
          bytes BLOB NOT NULL
        );
      `)
    },
  },
  {
    // The bytes move out of the database into one file per attachment (see
    // files.ts), so a download can stream from disk and a range can be read
    // without loading the whole file. What 0001 kept together — a deleted
    // task takes its files with it — is kept by the trigger's queue instead.
    id: 'attachments-0002-files',
    up(db, env) {
      const stored = db.prepare('SELECT attachment_id, bytes FROM task_attachment_content').all() as Array<{
        attachment_id: string
        bytes: Uint8Array
      }>
      if (stored.length > 0) {
        if (!env.dataDir) {
          throw new Error(
            'attachments-0002-files moves stored files into the data directory, and this database has none',
          )
        }
        fs.mkdirSync(attachmentsDir(env.dataDir), { recursive: true })
        for (const { attachment_id, bytes } of stored) {
          fs.writeFileSync(attachmentFile(env.dataDir, attachment_id), bytes)
        }
      }
      db.exec(`
        DROP TABLE task_attachment_content;

        -- Ids of deleted attachments whose files are still to be removed.
        CREATE TABLE task_attachment_gone (
          id TEXT PRIMARY KEY
        );
        CREATE TRIGGER task_attachment_on_delete AFTER DELETE ON task_attachment BEGIN
          INSERT OR IGNORE INTO task_attachment_gone (id) VALUES (old.id);
        END;
      `)
    },
  },
]
