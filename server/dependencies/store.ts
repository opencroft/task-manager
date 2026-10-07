// Relations between tasks, each "from <type> to": blocks, duplicates, follows,
// and relates, which runs both ways. Only blocks holds a task back, so only it
// is refused when it would close a loop, since a loop of blockers could never
// be worked off. The reads are batched: a task list gets every task's blockers
// from one query, not one per row.

import {
  INVERSE_RELATION_TYPES,
  RELATION_GROUPS,
  RELATION_GROUP_OF,
  RELATION_TYPES,
  RELATION_WORDS,
  type RelationGroup,
  type RelationType,
  type TaskLinkInput,
} from '../../shared/dependencies.ts'
import type { StatusCategory, TaskSummary } from '../../shared/types.ts'
import { transaction } from '../db.ts'
import { type Scope, TaskError, keyOf, record, requireRow, touch } from '../service.ts'

interface RelationRow {
  from_id: number
  to_id: number
  type: RelationType
}

/** How each relation reads in a task's history, from each end. */
const HISTORY_FIELD: Record<RelationType, { from: string; to: string }> = {
  blocks: { from: RELATION_WORDS.blocks, to: 'blocked by' },
  relates: { from: RELATION_WORDS.relates, to: RELATION_WORDS.relates },
  duplicates: { from: RELATION_WORDS.duplicates, to: 'duplicated by' },
  follows: { from: RELATION_WORDS.follows, to: 'precedes' },
}

function blockEdges(scope: Scope): Array<{ from: number; to: number }> {
  return scope.db.prepare("SELECT from_id AS 'from', to_id AS 'to' FROM task_relation WHERE type = 'blocks'").all() as Array<{
    from: number
    to: number
  }>
}

/**
 * The chain of blocks from `from` to `to`, as task ids including both ends, or
 * null when `to` cannot be reached. Breadth-first, so the chain named in a
 * refusal is a shortest one.
 */
function chainBetween(edges: Array<{ from: number; to: number }>, from: number, to: number): number[] | null {
  const next = new Map<number, number[]>()
  for (const edge of edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  }
  const cameFrom = new Map<number, number>([[from, from]])
  const queue = [from]
  while (queue.length > 0) {
    const id = queue.shift() as number
    if (id === to) {
      const chain = [to]
      while (chain[0] !== from) {
        chain.unshift(cameFrom.get(chain[0]) as number)
      }
      return chain
    }
    for (const onward of next.get(id) ?? []) {
      if (!cameFrom.has(onward)) {
        cameFrom.set(onward, id)
        queue.push(onward)
      }
    }
  }
  return null
}

function keyOfId(scope: Scope, id: number): string {
  const row = scope.db.prepare('SELECT number FROM task WHERE id = ?').get(id) as { number: number }
  return keyOf(scope, row.number)
}

/** A relation as it is stored: a canonical type, and its ends with relates' lower id first. */
export interface Relation {
  type: RelationType
  from: { id: number; key: string }
  to: { id: number; key: string }
}

/** The relation an input names, as it is stored. */
function resolve(scope: Scope, input: TaskLinkInput): Relation {
  const name = input?.type ?? 'blocks'
  const inverse = Object.hasOwn(INVERSE_RELATION_TYPES, name) ? INVERSE_RELATION_TYPES[name as keyof typeof INVERSE_RELATION_TYPES] : null
  if (!inverse && !(RELATION_TYPES as readonly string[]).includes(name)) {
    throw new TaskError(`"${name}" is not a relation type; use one of: ${[...RELATION_TYPES, ...Object.keys(INVERSE_RELATION_TYPES)].join(', ')}`)
  }
  const type = inverse ?? (name as RelationType)
  const first = requireRow(scope, input?.from)
  const second = requireRow(scope, input?.to)
  const [from, to] = inverse ? [second, first] : [first, second]
  return relationOf(type, { id: from.id, key: keyOf(scope, from.number) }, { id: to.id, key: keyOf(scope, to.number) })
}

/** A relation of `type` from one task to another, as it is stored: relates keeps the lower id first. */
export function relationOf(type: RelationType, from: Relation['from'], to: Relation['to']): Relation {
  return type === 'relates' && from.id > to.id ? { type, from: to, to: from } : { type, from, to }
}

/** Record a relation between two tasks. Recording one already there changes nothing. */
export function linkTasks(scope: Scope, input: TaskLinkInput): void {
  const relation = resolve(scope, input)
  const added = transaction(scope.db, () => addRelation(scope, relation))
  if (added) {
    scope.notify([relation.from.key, relation.to.key], 'task')
  }
}

/**
 * Write one relation with its history, inside the caller's transaction, and
 * return whether it was new. Refuses a task related to itself and blocks that
 * would make a loop. The caller tells the pages.
 */
export function addRelation(scope: Scope, relation: Relation): boolean {
  const { type, from, to } = relation
  if (from.id === to.id) {
    throw new TaskError(`${from.key} cannot ${type === 'relates' ? 'relate to' : type.replace(/s$/, '')} itself`)
  }
  const existing = scope.db.prepare('SELECT 1 FROM task_relation WHERE from_id = ? AND to_id = ? AND type = ?').get(from.id, to.id, type)
  if (existing) {
    return false
  }
  if (type === 'blocks') {
    // The new link closes a loop exactly when the blocked task already leads to the blocker.
    const loop = chainBetween(blockEdges(scope), to.id, from.id)
    if (loop) {
      const chain = [...loop, to.id].map((id) => keyOfId(scope, id)).join(' → ')
      throw new TaskError(`${from.key} cannot block ${to.key}: that would make a loop (${chain})`)
    }
  }
  scope.db.prepare('INSERT INTO task_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)').run(from.id, to.id, type, new Date().toISOString())
  record(scope, from.id, 'field', HISTORY_FIELD[type].from, null, to.key)
  record(scope, to.id, 'field', HISTORY_FIELD[type].to, null, from.key)
  touch(scope, from.id)
  touch(scope, to.id)
  return true
}

/** Remove a relation between two tasks. */
export function unlinkTasks(scope: Scope, input: TaskLinkInput): void {
  const { type, from, to } = resolve(scope, input)
  transaction(scope.db, () => {
    const removed = scope.db.prepare('DELETE FROM task_relation WHERE from_id = ? AND to_id = ? AND type = ?').run(from.id, to.id, type)
    if (removed.changes === 0) {
      throw new TaskError(`${from.key} ${HISTORY_FIELD[type].from} ${to.key} is not recorded`)
    }
    record(scope, from.id, 'field', HISTORY_FIELD[type].from, to.key, null)
    record(scope, to.id, 'field', HISTORY_FIELD[type].to, from.key, null)
    touch(scope, from.id)
    touch(scope, to.id)
  })
  scope.notify([from.key, to.key], 'task')
}

/** The ids of the tasks related to one task, by group. */
export function relatedIds(scope: Scope, taskId: number): Record<RelationGroup, number[]> {
  const rows = scope.db.prepare('SELECT from_id, to_id, type FROM task_relation WHERE from_id = ? OR to_id = ?').all(taskId, taskId) as unknown as RelationRow[]
  const groups = Object.fromEntries(RELATION_GROUPS.map((group) => [group, [] as number[]])) as Record<RelationGroup, number[]>
  for (const group of RELATION_GROUPS) {
    const { type, taskIsFrom } = RELATION_GROUP_OF[group]
    for (const row of rows) {
      if (row.type !== type) {
        continue
      }
      if (type === 'relates') {
        // Kept once for both ends: the other end is whichever this task is not.
        if (group === 'relatesTo') {
          groups[group].push(row.from_id === taskId ? row.to_id : row.from_id)
        }
      } else if (taskIsFrom ? row.from_id === taskId : row.to_id === taskId) {
        groups[group].push(taskIsFrom ? row.to_id : row.from_id)
      }
    }
  }
  return groups
}

/** Fill in each summary's `blockers`, from one query over the project's blocks. */
export function attachBlockers<T extends TaskSummary>(scope: Scope, summaries: T[]): T[] {
  if (summaries.length === 0) {
    return summaries
  }
  const rows = scope.db
    .prepare(
      `SELECT blocked.number AS blocked, blocker.number AS blocker, s.category AS category
       FROM task_relation r
       JOIN task blocker ON blocker.id = r.from_id
       JOIN task blocked ON blocked.id = r.to_id
       JOIN status s ON s.id = blocker.status_id
       WHERE r.type = 'blocks'
       ORDER BY blocker.number`,
    )
    .all() as Array<{ blocked: number; blocker: number; category: StatusCategory }>
  const byBlocked = new Map<number, TaskSummary['blockers']>()
  for (const row of rows) {
    const list = byBlocked.get(row.blocked) ?? []
    list.push({ key: keyOf(scope, row.blocker), open: row.category !== 'done' })
    byBlocked.set(row.blocked, list)
  }
  for (const summary of summaries) {
    summary.blockers = byBlocked.get(summary.number) ?? []
  }
  return summaries
}
