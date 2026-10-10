// Importing OpenProject's relations between work packages that were imported
// before, as relations between their tasks. Each end is found by the work
// package it came from, not by number. Each relation is imported once: a
// re-run adds only new ones, and never one removed here since. Written in one
// transaction; a preview runs the same and rolls it back.

import type { RelationType } from '../../shared/dependencies.ts'
import type { OpenProjectRelationsResult, OpenProjectSkipped } from '../../shared/openproject.ts'
import { transaction } from '../db.ts'
import { addRelation, relationOf } from '../dependencies/store.ts'
import { keyOf, type Scope, TaskError } from '../service.ts'
import type { SourceRelation } from './api.ts'
import { sourceOf } from './store.ts'

/** OpenProject's relation types as ours, with whether its from and to swap. The rest have no counterpart. */
const TYPE_OF: Record<string, { type: RelationType; swap: boolean }> = {
  relates: { type: 'relates', swap: false },
  blocks: { type: 'blocks', swap: false },
  blocked: { type: 'blocks', swap: true },
  follows: { type: 'follows', swap: false },
  precedes: { type: 'follows', swap: true },
  duplicates: { type: 'duplicates', swap: false },
  duplicated: { type: 'duplicates', swap: true },
}

/** Thrown to roll a preview back, carrying what it would have done. */
class Previewed extends Error {
  readonly result: OpenProjectRelationsResult

  constructor(result: OpenProjectRelationsResult) {
    super('preview')
    this.result = result
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * For a preview: relations not imported yet whose both ends are imported here
 * or among `incoming` (work package ids an import would bring), of a type we
 * have. A loop is only found on import, so this is at most what it adds.
 */
export function countNewRelations(
  scope: Scope,
  base: string,
  relations: SourceRelation[],
  incoming: ReadonlySet<number>,
): number {
  const origin = sourceOf(base)
  const here = new Set(
    (
      scope.db.prepare('SELECT source_id FROM task_source WHERE source = ?').all(origin) as Array<{ source_id: string }>
    ).map((row) => Number(row.source_id)),
  )
  const before = new Set(
    (
      scope.db.prepare('SELECT source_id FROM relation_source WHERE source = ?').all(origin) as Array<{
        source_id: string
      }>
    ).map((row) => row.source_id),
  )
  const lands = (id: number) => here.has(id) || incoming.has(id)
  return relations.filter(
    (relation) =>
      TYPE_OF[relation.type] && !before.has(String(relation.id)) && lands(relation.fromId) && lands(relation.toId),
  ).length
}

export function applyRelations(
  scope: Scope,
  base: string,
  relations: SourceRelation[],
  confirm: boolean,
): OpenProjectRelationsResult {
  const origin = sourceOf(base)
  try {
    const result = transaction(scope.db, () => {
      const outcome = writeRelations(scope, origin, relations, confirm)
      if (!confirm) {
        throw new Previewed(outcome)
      }
      return outcome
    })
    if (Object.values(result.added).some((count) => count > 0)) {
      scope.notify([], 'task')
    }
    return result
  } catch (error) {
    if (error instanceof Previewed) {
      return error.result
    }
    throw error
  }
}

function writeRelations(
  scope: Scope,
  origin: string,
  relations: SourceRelation[],
  confirm: boolean,
): OpenProjectRelationsResult {
  const tasks = new Map(
    (
      scope.db
        .prepare(
          'SELECT ts.source_id, t.id, t.number FROM task_source ts JOIN task t ON t.id = ts.task_id WHERE ts.source = ?',
        )
        .all(origin) as Array<{ source_id: string; id: number; number: number }>
    ).map((row) => [row.source_id, { id: row.id, key: keyOf(scope, row.number) }]),
  )
  const importedBefore = new Set(
    (
      scope.db.prepare('SELECT source_id FROM relation_source WHERE source = ?').all(origin) as Array<{
        source_id: string
      }>
    ).map((row) => row.source_id),
  )
  const remember = scope.db.prepare('INSERT INTO relation_source (source, source_id, imported_at) VALUES (?, ?, ?)')
  const now = new Date().toISOString()

  const added: Record<RelationType, number> = { blocks: 0, relates: 0, duplicates: 0, follows: 0 }
  const skipped: OpenProjectSkipped[] = []
  const unknownTypes = new Map<string, number>()
  let found = 0
  let before = 0
  let alreadyHere = 0
  let halfHere = 0

  for (const relation of relations) {
    const from = tasks.get(String(relation.fromId))
    const to = tasks.get(String(relation.toId))
    if (!from || !to) {
      // With neither end here, it is another project's; with one, the other end was not imported.
      if (from || to) {
        halfHere++
      }
      continue
    }
    found++
    if (importedBefore.has(String(relation.id))) {
      before++
      continue
    }
    const mapped = TYPE_OF[relation.type]
    if (!mapped) {
      unknownTypes.set(relation.type, (unknownTypes.get(relation.type) ?? 0) + 1)
      continue
    }
    const [start, end] = mapped.swap ? [to, from] : [from, to]
    try {
      if (addRelation(scope, relationOf(mapped.type, start, end))) {
        added[mapped.type]++
      } else {
        alreadyHere++
      }
    } catch (error) {
      if (!(error instanceof TaskError)) {
        throw error
      }
      skipped.push({
        source: `${start.key} ${mapped.type} ${end.key}`,
        summary: `OpenProject relation ${relation.id}`,
        reason: error.message,
      })
      continue
    }
    remember.run(origin, String(relation.id), now)
  }
  if (halfHere > 0) {
    skipped.push({
      source: 'Relations',
      summary: plural(halfHere, 'relation', 'relations'),
      reason: 'The work package at the other end is not imported here: in another project, or of a type left out',
    })
  }
  for (const [type, count] of unknownTypes) {
    skipped.push({
      source: 'Relations',
      summary: plural(count, `"${type}" relation`, `"${type}" relations`),
      reason: 'No such relation here',
    })
  }
  return { imported: confirm, found, added, importedBefore: before, alreadyHere, skipped }
}
