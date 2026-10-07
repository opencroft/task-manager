// What the OpenProject import keeps between runs: the one saved connection,
// the mapping and result of the last import, the schedule, and which tasks
// came from which work package. Writing an import itself is in ./apply.ts.

import type { OpenProjectConnection, OpenProjectImportResult, OpenProjectImportState, OpenProjectMapping } from '../../shared/openproject.ts'
import { type Scope, keyOf } from '../service.ts'

/** The `source` column's value for one OpenProject server. */
export const sourceOf = (base: string) => `openproject:${base}`

interface SavedRow {
  url: string
  project: string
  secret_key: string
  mapping: string | null
  keep_numbers: number
  last_at: string | null
  last_by: string | null
  last_result: string | null
  sync_minutes: number | null
  sync_tried_at: string | null
  sync_error: string | null
}

function savedRow(scope: Pick<Scope, 'db'>): SavedRow | undefined {
  return scope.db.prepare('SELECT * FROM openproject_import WHERE id = 1').get() as SavedRow | undefined
}

export function readConnection(scope: Scope): OpenProjectConnection | null {
  const row = savedRow(scope)
  return row ? { url: row.url, project: row.project, secretKey: row.secret_key } : null
}

export function readSavedMapping(scope: Scope): { mapping: Partial<OpenProjectMapping> | null; keepNumbers: boolean } {
  const row = savedRow(scope)
  return { mapping: row?.mapping ? (JSON.parse(row.mapping) as Partial<OpenProjectMapping>) : null, keepNumbers: row ? row.keep_numbers === 1 : true }
}

export function readState(scope: Scope): OpenProjectImportState {
  const row = savedRow(scope)
  return {
    connection: row ? { url: row.url, project: row.project, secretKey: row.secret_key } : null,
    lastImport:
      row?.last_at && row.last_result ? { at: row.last_at, by: row.last_by ?? '', result: JSON.parse(row.last_result) as OpenProjectImportResult } : null,
    sync: {
      minutes: row?.sync_minutes ?? null,
      error: row?.sync_error && row.sync_tried_at ? { at: row.sync_tried_at, message: row.sync_error } : null,
    },
  }
}

/** Remember the connection; a changed address or project forgets the mapping made for the old one. */
export function saveConnection(scope: Scope, connection: OpenProjectConnection): void {
  const before = savedRow(scope)
  const same = before && before.url === connection.url && before.project === connection.project
  scope.db
    .prepare(
      `INSERT INTO openproject_import (id, url, project, secret_key, mapping, keep_numbers) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, project = excluded.project, secret_key = excluded.secret_key,
         mapping = excluded.mapping, keep_numbers = excluded.keep_numbers`,
    )
    .run(connection.url, connection.project, connection.secretKey, same ? before.mapping : null, same ? before.keep_numbers : 1)
}

/** The last import's result, once its relations and attachments are added to what `applyImport` saved. */
export function saveLastResult(scope: Scope, result: OpenProjectImportResult): void {
  scope.db.prepare('UPDATE openproject_import SET last_result = ? WHERE id = 1').run(JSON.stringify(result))
}

/** Import every `minutes` from now on, or stop while null. */
export function saveSync(scope: Scope, minutes: number | null): void {
  scope.db.prepare('UPDATE openproject_import SET sync_minutes = ?, sync_tried_at = NULL, sync_error = NULL WHERE id = 1').run(minutes)
}

/** Whether a scheduled import is due at `at`: on, and `minutes` past both the last import and the last try. */
export function syncDue(scope: Pick<Scope, 'db'>, at: number): boolean {
  const row = savedRow(scope)
  if (!row?.sync_minutes || !row.last_at) {
    return false
  }
  const latest = Math.max(Date.parse(row.last_at), row.sync_tried_at ? Date.parse(row.sync_tried_at) : 0)
  return at - latest >= row.sync_minutes * 60_000
}

/** A scheduled run's outcome: tried now, and its failure or null. */
export function recordSyncTry(scope: Pick<Scope, 'db'>, error: string | null): void {
  scope.db.prepare('UPDATE openproject_import SET sync_tried_at = ?, sync_error = ? WHERE id = 1').run(new Date().toISOString(), error)
}

/** How many of these work packages a previous run imported and the task still exists. */
export function countImported(scope: Scope, base: string, ids: number[]): number {
  const known = importedVersions(scope, base)
  return ids.filter((id) => known.has(String(id))).length
}

/** Each work package imported before, by its id, with the `updatedAt` it had then. */
export function importedVersions(scope: Scope, base: string): Map<string, string> {
  const rows = scope.db.prepare('SELECT source_id, source_updated_at FROM task_source WHERE source = ?').all(sourceOf(base)) as Array<{
    source_id: string
    source_updated_at: string
  }>
  return new Map(rows.map((row) => [row.source_id, row.source_updated_at]))
}

/** A task's key by the work package it came from: what a caller looks an imported task up by. */
export function keyForSource(scope: Scope, base: string, workPackageId: number): string | null {
  const row = scope.db
    .prepare('SELECT t.number FROM task_source ts JOIN task t ON t.id = ts.task_id WHERE ts.source = ? AND ts.source_id = ?')
    .get(sourceOf(base), String(workPackageId)) as { number: number } | undefined
  return row ? keyOf(scope, row.number) : null
}
