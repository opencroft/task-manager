// Every filter the project stores as JSON: each saved view's, and each
// board's preset filter. A change to what a filter value names (a label
// renamed, a version renamed) reaches all of them through here.

import type { ViewFilter } from '../../shared/views.ts'
import type { Db } from '../db.ts'

/** The tables holding a stored filter, each in a `filter` column beside an `id`. */
export const STORED_FILTER_TABLES = ['saved_view', 'board'] as const
export type StoredFilterTable = (typeof STORED_FILTER_TABLES)[number]

/**
 * Passes every filter stored in `tables` through `change`, and writes back
 * those it returns as a different object.
 */
export function rewriteStoredFilters(
  db: Db,
  change: (filter: ViewFilter) => ViewFilter,
  tables: readonly StoredFilterTable[] = STORED_FILTER_TABLES,
): void {
  for (const table of tables) {
    const rows = db.prepare(`SELECT id, filter FROM ${table}`).all() as Array<{ id: string; filter: string }>
    const update = db.prepare(`UPDATE ${table} SET filter = ? WHERE id = ?`)
    for (const row of rows) {
      const filter = JSON.parse(row.filter) as ViewFilter
      const next = change(filter)
      if (next !== filter) {
        update.run(JSON.stringify(next), row.id)
      }
    }
  }
}
