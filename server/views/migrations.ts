// Seam owned by saved views: its schema migrations, applied after the
// dependencies' by the runner in ../db.ts. Forward-only: never edit or reorder
// an entry once it has shipped; append a new one.

import { compactFilter } from '../../shared/filters.ts'
import type { StatusRef } from '../../shared/types.ts'
import type { Migration } from '../db.ts'
import { findStatus } from '../status-refs.ts'
import { rewriteStoredFilters } from './stored-filters.ts'

export const viewMigrations: Migration[] = [
  {
    id: 'views-0001-init',
    up(db) {
      db.exec(`
        -- A named filter set. owner_key is the caller's stable identity
        -- ("person:<user id>" or "agent:<node id>"); owner_name is shown.
        CREATE TABLE saved_view (
          id TEXT PRIMARY KEY,
          page TEXT NOT NULL CHECK (page IN ('tasks', 'board')),
          name TEXT NOT NULL,
          filter TEXT NOT NULL,
          grouping TEXT CHECK (grouping IS NULL OR grouping = 'assignee'),
          shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
          owner_key TEXT NOT NULL,
          owner_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (owner_key, page, name)
        );
        CREATE INDEX saved_view_page ON saved_view (page, shared);
        -- Each caller's default view per page. Deleting the view clears it.
        CREATE TABLE saved_view_default (
          owner_key TEXT NOT NULL,
          page TEXT NOT NULL,
          view_id TEXT NOT NULL REFERENCES saved_view (id) ON DELETE CASCADE,
          PRIMARY KEY (owner_key, page)
        );
      `)
    },
  },
  {
    id: 'views-0002-columns',
    up(db) {
      // A tasks view's table columns as a JSON array, in order; NULL shows the default set.
      db.exec('ALTER TABLE saved_view ADD COLUMN columns TEXT')
    },
  },
  {
    id: 'views-0003-field-filters',
    up(db) {
      // Each list-valued field becomes { include, exclude }: a plain list (or a single parent key) is what it includes.
      rewriteStoredFilters(db, (filter) => compactFilter(filter), ['saved_view'])
    },
  },
  {
    id: 'views-0004-status-ids',
    up(db) {
      // A status saved by name becomes its id, as the pages and their URLs hold it. A name no
      // status has any more matched nothing, and is dropped.
      const statuses = db.prepare('SELECT id, name FROM status').all() as Array<{ id: number; name: string }>
      const ids = (refs: StatusRef[] | undefined) => refs?.flatMap((ref) => findStatus(statuses, ref)?.id ?? [])
      rewriteStoredFilters(
        db,
        (filter) =>
          filter.status
            ? compactFilter({ ...filter, status: { include: ids(filter.status.include), exclude: ids(filter.status.exclude) } })
            : filter,
        ['saved_view'],
      )
    },
  },
]
