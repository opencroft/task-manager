// Seam owned by boards: its schema migrations, applied last by the runner in
// ../db.ts. Forward-only: never edit or reorder an entry once it has shipped;
// append a new one.

import { compactFilter } from '../../shared/filters.ts'
import type { Migration } from '../db.ts'
import { rewriteStoredFilters } from '../views/stored-filters.ts'

export const boardMigrations: Migration[] = [
  {
    id: 'boards-0001-init',
    up(db) {
      db.exec(`
        -- A named board of the project; filter is its preset filter as JSON.
        CREATE TABLE board (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          filter TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        -- Its columns, left to right; a null name is its first status's.
        CREATE TABLE board_column (
          board_id TEXT NOT NULL REFERENCES board (id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT,
          PRIMARY KEY (board_id, position)
        );
        -- The statuses of each column, top to bottom. A status is in at most
        -- one column of a board, and leaves every board when it is deleted.
        CREATE TABLE board_status (
          board_id TEXT NOT NULL,
          column_position INTEGER NOT NULL,
          position INTEGER NOT NULL,
          status_id INTEGER NOT NULL REFERENCES status (id) ON DELETE CASCADE,
          PRIMARY KEY (board_id, status_id),
          FOREIGN KEY (board_id, column_position) REFERENCES board_column (board_id, position) ON DELETE CASCADE
        );
        CREATE INDEX board_status_status ON board_status (status_id);
      `)
    },
  },
  {
    id: 'boards-0002-field-filters',
    up(db) {
      // Each list-valued field becomes { include, exclude }: a plain list (or a single parent key) is what it includes.
      rewriteStoredFilters(db, (filter) => compactFilter(filter), ['board'])
    },
  },
]
