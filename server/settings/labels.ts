// The project's labels as a managed set: counts and colours, and rename,
// merge and delete across every task that carries one. A label is a plain
// string on its tasks, so each of these rewrites those tasks (with a history
// entry on each, as a hand edit would leave) and the saved views that filter
// by it. No host in sight: the whole module runs under `node --test`.

import { replaceFilterValue } from '../../shared/filters.ts'
import { LABEL_COLORS, type LabelChange, type LabelColor, type ProjectLabel } from '../../shared/settings.ts'
import type { MutationResult, TaskKey } from '../../shared/types.ts'
import { didYouMean } from '../closest-names.ts'
import { transaction } from '../db.ts'
import { type Scope, TaskError, keyOf, record, touch } from '../service.ts'
import { rewriteStoredFilters } from '../views/stored-filters.ts'

/** The same limit a label set on a task has. */
const LABEL_MAX = 50

/** Every label in use, by name, with how many tasks carry it and its colour. */
export function labelOverview(scope: Scope): ProjectLabel[] {
  const rows = scope.db
    .prepare(
      `SELECT l.label AS name, COUNT(*) AS count, c.color AS color
       FROM task_label l LEFT JOIN label_color c ON c.name = l.label
       GROUP BY l.label ORDER BY l.label COLLATE NOCASE`,
    )
    .all() as Array<{ name: string; count: number; color: string | null }>
  return rows.map((row) => ({ name: row.name, count: row.count, color: row.color as LabelColor | null }))
}

function labelNames(scope: Scope): string[] {
  return (scope.db.prepare('SELECT DISTINCT label FROM task_label').all() as Array<{ label: string }>).map((row) => row.label)
}

function cleanName(value: unknown, field: string): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!name) {
    throw new TaskError(`${field} must be a label name`)
  }
  if (name.length > LABEL_MAX) {
    throw new TaskError(`Label "${name}" is longer than ${LABEL_MAX} characters`)
  }
  return name
}

/** The label `ref` names: its exact name, or the one label it matches ignoring case. */
function resolveLabel(scope: Scope, ref: unknown, field = 'label'): string {
  const wanted = cleanName(ref, field)
  const names = labelNames(scope)
  if (names.includes(wanted)) {
    return wanted
  }
  const byCase = names.filter((name) => name.toLowerCase() === wanted.toLowerCase())
  if (byCase.length === 1) {
    return byCase[0] as string
  }
  if (byCase.length > 1) {
    throw new TaskError(`"${wanted}" matches ${byCase.map((name) => `"${name}"`).join(', ')}; pass the exact name`)
  }
  throw new TaskError(`No label "${wanted}" on any task.${didYouMean(wanted, names)}`)
}

function labelsOf(scope: Scope, taskId: number): string[] {
  return (scope.db.prepare('SELECT label FROM task_label WHERE task_id = ?').all(taskId) as Array<{ label: string }>)
    .map((row) => row.label)
    .sort((a, b) => a.localeCompare(b))
}

/** Put `to` (or nothing) in place of `from` on every task that carries it; the keys of the tasks changed. */
function rewriteTasks(scope: Scope, from: string, to: string | null): TaskKey[] {
  const rows = scope.db
    .prepare('SELECT t.id, t.number FROM task t JOIN task_label l ON l.task_id = t.id WHERE l.label = ? ORDER BY t.number')
    .all(from) as Array<{ id: number; number: number }>
  const remove = scope.db.prepare('DELETE FROM task_label WHERE task_id = ? AND label = ?')
  const add = scope.db.prepare('INSERT OR IGNORE INTO task_label (task_id, label) VALUES (?, ?)')
  for (const row of rows) {
    const before = labelsOf(scope, row.id)
    remove.run(row.id, from)
    if (to !== null) {
      add.run(row.id, to)
    }
    record(scope, row.id, 'field', 'labels', before.join(', ') || null, labelsOf(scope, row.id).join(', ') || null)
    touch(scope, row.id)
  }
  return rows.map((row) => keyOf(scope, row.number))
}

/** The same change in every saved view and board filter that includes or excludes `from`, whoever owns it. */
function rewriteViews(scope: Scope, from: string, to: string | null): void {
  rewriteStoredFilters(scope.db, (filter) => replaceFilterValue(filter, 'label', from, to))
}

function change(scope: Scope, name: string | null, tasks: number): MutationResult<LabelChange> {
  return { result: { label: name === null ? null : (labelOverview(scope).find((label) => label.name === name) ?? null), tasks } }
}

export function renameLabel(scope: Scope, input: { label?: unknown; to?: unknown }): MutationResult<LabelChange> {
  const from = resolveLabel(scope, input.label)
  const to = cleanName(input.to, 'to')
  if (to === from) {
    return change(scope, from, 0)
  }
  const taken = labelNames(scope).find((name) => name !== from && name.toLowerCase() === to.toLowerCase())
  if (taken) {
    throw new TaskError(`"${taken}" already exists; merge "${from}" into it instead (label_merge)`)
  }
  const keys = transaction(scope.db, () => {
    const changed = rewriteTasks(scope, from, to)
    rewriteViews(scope, from, to)
    scope.db.prepare('DELETE FROM label_color WHERE name = ?').run(to)
    scope.db.prepare('UPDATE label_color SET name = ? WHERE name = ?').run(to, from)
    return changed
  })
  scope.notify(keys, 'task')
  return change(scope, to, keys.length)
}

export function mergeLabel(scope: Scope, input: { label?: unknown; into?: unknown }): MutationResult<LabelChange> {
  const from = resolveLabel(scope, input.label)
  const into = resolveLabel(scope, input.into, 'into')
  if (into === from) {
    throw new TaskError(`"${from}" cannot be merged into itself`)
  }
  const keys = transaction(scope.db, () => {
    const changed = rewriteTasks(scope, from, into)
    rewriteViews(scope, from, into)
    scope.db.prepare('DELETE FROM label_color WHERE name = ?').run(from)
    return changed
  })
  scope.notify(keys, 'task')
  return change(scope, into, keys.length)
}

export function deleteLabel(scope: Scope, input: { label?: unknown }): MutationResult<LabelChange> {
  const name = resolveLabel(scope, input.label)
  const keys = transaction(scope.db, () => {
    const changed = rewriteTasks(scope, name, null)
    rewriteViews(scope, name, null)
    scope.db.prepare('DELETE FROM label_color WHERE name = ?').run(name)
    return changed
  })
  scope.notify(keys, 'task')
  return change(scope, null, keys.length)
}

export function colorLabel(scope: Scope, input: { label?: unknown; color?: unknown }): MutationResult<LabelChange> {
  const name = resolveLabel(scope, input.label)
  const color = input.color ?? null
  if (color !== null && !LABEL_COLORS.includes(color as LabelColor)) {
    throw new TaskError(`color must be one of: ${LABEL_COLORS.join(', ')}; or null for none`)
  }
  if (color === null) {
    scope.db.prepare('DELETE FROM label_color WHERE name = ?').run(name)
  } else {
    scope.db
      .prepare('INSERT INTO label_color (name, color) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET color = excluded.color')
      .run(name, color as string)
  }
  scope.notify([], 'label')
  return change(scope, name, 0)
}
