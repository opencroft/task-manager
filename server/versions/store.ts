// The project's versions: create, edit, release (with release notes) and
// archive, and which version a task is planned into. A task's version is a
// column on the task, so task_update and task_list reach it through the
// service; everything that is about the versions themselves lives here. No
// host in sight: the whole module runs under `node --test`.

import type { ActionInputs } from '../../shared/action-inputs.ts'
import { replaceFilterValue } from '../../shared/filters.ts'
import type { MutationResult, TaskKey, TaskType } from '../../shared/types.ts'
import {
  compareVersionNames,
  VERSION_NAME_PATTERN,
  VERSION_STATES,
  type Version,
  type VersionReleaseResult,
  type VersionState,
} from '../../shared/versions.ts'
import { didYouMean } from '../closest-names.ts'
import { transaction } from '../db.ts'
import { cleanDate, keyOf, record, type Scope, summariesWhere, TaskError, touch } from '../service.ts'
import { rewriteStoredFilters } from '../views/stored-filters.ts'

const DESCRIPTION_MAX = 200

interface VersionRow {
  id: number
  name: string
  state: VersionState
  target_date: string | null
  released_at: string | null
  description: string
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()
const today = () => now().slice(0, 10)

function counts(scope: Scope): Map<number, { open: number; done: number }> {
  const rows = scope.db
    .prepare(
      `SELECT t.version_id AS id, SUM(s.category = 'done') AS done, SUM(s.category <> 'done') AS open
       FROM task t JOIN status s ON s.id = t.status_id WHERE t.version_id IS NOT NULL GROUP BY t.version_id`,
    )
    .all() as Array<{ id: number; open: number; done: number }>
  return new Map(rows.map((row) => [row.id, { open: row.open, done: row.done }]))
}

function toVersion(row: VersionRow, count = { open: 0, done: 0 }): Version {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    targetDate: row.target_date,
    releasedAt: row.released_at,
    description: row.description,
    openCount: count.open,
    doneCount: count.done,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rows(scope: Scope): VersionRow[] {
  return (scope.db.prepare('SELECT * FROM version').all() as unknown as VersionRow[]).sort((a, b) =>
    compareVersionNames(a.name, b.name),
  )
}

function versionById(scope: Scope, id: number): Version {
  const row = scope.db.prepare('SELECT * FROM version WHERE id = ?').get(id) as unknown as VersionRow
  return toVersion(row, counts(scope).get(id))
}

/** Every version, lowest first by semver precedence, optionally only those in some states. */
export function listVersions(scope: Scope, input: ActionInputs['version_list'] = {}): { versions: Version[] } {
  const states = input.state?.map(cleanState)
  const count = counts(scope)
  return {
    versions: rows(scope)
      .filter((row) => !states?.length || states.includes(row.state))
      .map((row) => toVersion(row, count.get(row.id))),
  }
}

/** A version name as written, less a leading `v`; refused unless it is semver. */
export function cleanVersionName(value: unknown, field = 'name'): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    throw new TaskError(`${field} must be a version name, e.g. 1.4.0`)
  }
  const name = /^v\d/i.test(raw) ? raw.slice(1) : raw
  if (!VERSION_NAME_PATTERN.test(name)) {
    throw new TaskError(
      `"${raw}" is not a semantic version: write MAJOR.MINOR.PATCH, optionally with a -pre part, e.g. 1.4.0 or 2.0.0-beta.1`,
    )
  }
  return name
}

function cleanState(value: string): VersionState {
  if (!VERSION_STATES.includes(value as VersionState)) {
    throw new TaskError(`state must be one of: ${VERSION_STATES.join(', ')}`)
  }
  return value as VersionState
}

function cleanDescription(value: string): string {
  const description = value.replace(/\s+/g, ' ').trim()
  if (description.length > DESCRIPTION_MAX) {
    throw new TaskError(`A version's description is at most ${DESCRIPTION_MAX} characters`)
  }
  return description
}

/** The version `ref` names: its id, or its name (a leading `v` is ignored). */
export function resolveVersion(scope: Scope, ref: unknown, field = 'version'): VersionRow {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
    const byId = scope.db.prepare('SELECT * FROM version WHERE id = ?').get(Number(ref)) as VersionRow | undefined
    if (byId) {
      return byId
    }
  }
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new TaskError(`${field} must be a version name, e.g. 1.4.0`)
  }
  const wanted = ref.trim().replace(/^v(?=\d)/i, '')
  const all = rows(scope)
  const found =
    all.find((row) => row.name === wanted) ?? all.find((row) => row.name.toLowerCase() === wanted.toLowerCase())
  if (!found) {
    const names = all.map((row) => row.name)
    throw new TaskError(
      `No version "${ref.trim()}".${didYouMean(wanted, names)} ${names.length ? `Versions: ${names.join(', ')}` : 'The project has no versions yet; version_create makes one'}`,
    )
  }
  return found
}

/**
 * The version id a task write sets: null for none (`null`, `""` or `"none"`).
 * An archived version takes no new tasks.
 */
export function versionIdFor(scope: Scope, ref: unknown): number | null {
  if (ref === null || ref === '' || (typeof ref === 'string' && ref.trim().toLowerCase() === 'none')) {
    return null
  }
  const row = resolveVersion(scope, ref)
  if (row.state === 'archived') {
    throw new TaskError(
      `Version ${row.name} is archived; set it back to planned (version_update) to plan tasks into it`,
    )
  }
  return row.id
}

function assertNameFree(scope: Scope, name: string, selfId?: number): void {
  const taken = scope.db.prepare('SELECT id FROM version WHERE name = ?').get(name) as { id: number } | undefined
  if (taken && taken.id !== selfId) {
    throw new TaskError(`Version ${name} already exists`)
  }
}

export function createVersion(scope: Scope, input: ActionInputs['version_create']): MutationResult<Version> {
  const name = cleanVersionName(input.name)
  const targetDate = cleanDate(input.targetDate, 'targetDate')
  const description = input.description === undefined ? '' : cleanDescription(input.description)
  assertNameFree(scope, name)
  const stamp = now()
  const result = scope.db
    .prepare(
      `INSERT INTO version (name, state, target_date, description, created_at, updated_at) VALUES (?, 'planned', ?, ?, ?, ?)`,
    )
    .run(name, targetDate, description, stamp, stamp)
  scope.notify([], 'version')
  return { result: versionById(scope, Number(result.lastInsertRowid)) }
}

/** The same rename in every saved view and board filter that includes or excludes the old name, whoever owns it. */
function renameInViews(scope: Scope, from: string, to: string): void {
  rewriteStoredFilters(scope.db, (filter) => replaceFilterValue(filter, 'version', from, to))
}

export function updateVersion(scope: Scope, input: ActionInputs['version_update']): MutationResult<Version> {
  const row = resolveVersion(scope, input.version)
  const sets: string[] = []
  const args: Array<string | null> = []
  let renamed: string | null = null
  if (input.name !== undefined) {
    const name = cleanVersionName(input.name)
    if (name !== row.name) {
      assertNameFree(scope, name, row.id)
      sets.push('name = ?')
      args.push(name)
      renamed = name
    }
  }
  if (input.targetDate !== undefined) {
    sets.push('target_date = ?')
    args.push(cleanDate(input.targetDate, 'targetDate'))
  }
  if (input.description !== undefined) {
    sets.push('description = ?')
    args.push(cleanDescription(input.description))
  }
  if (input.state !== undefined) {
    const state = input.state
    if (state !== row.state) {
      sets.push('state = ?')
      args.push(state)
      // Back to planned, it has not been released after all.
      if (state === 'planned') {
        sets.push('released_at = NULL')
      }
    }
  }
  if (sets.length) {
    transaction(scope.db, () => {
      scope.db.prepare(`UPDATE version SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), row.id)
      if (renamed) {
        renameInViews(scope, row.name, renamed)
      }
    })
    scope.notify([], 'version')
  }
  return { result: versionById(scope, row.id) }
}

/** Release notes' sections, in the order they are written. */
const TYPE_HEADINGS: Array<[TaskType, string]> = [
  ['epic', 'Epics'],
  ['story', 'Stories'],
  ['task', 'Tasks'],
  ['bug', 'Bugs'],
]

/** The version's done tasks grouped by type, as markdown, with what was left open named at the end. */
export function releaseNotes(scope: Scope, versionId: number): string {
  const version = versionById(scope, versionId)
  const tasks = summariesWhere(scope, 't.version_id = ?', [versionId], 't.rank')
  const done = tasks.filter((task) => task.status.category === 'done')
  const open = tasks.filter((task) => task.status.category !== 'done')
  const lines = [`## ${version.name}${version.releasedAt ? ` (${version.releasedAt})` : ''}`]
  if (version.description) {
    lines.push('', version.description)
  }
  if (!done.length) {
    lines.push('', '_No finished tasks._')
  }
  for (const [type, heading] of TYPE_HEADINGS) {
    const ofType = done.filter((task) => task.type === type)
    if (ofType.length) {
      lines.push('', `### ${heading}`, ...ofType.map((task) => `- ${task.key} ${task.summary}`))
    }
  }
  if (open.length) {
    lines.push('', `Not finished: ${open.map((task) => task.key).join(', ')}.`)
  }
  return lines.join('\n')
}

/** Put the tasks with these ids into another version (or none), with a history entry on each. */
function moveTasks(
  scope: Scope,
  tasks: Array<{ id: number; number: number }>,
  from: string,
  to: VersionRow | null,
): TaskKey[] {
  const set = scope.db.prepare('UPDATE task SET version_id = ? WHERE id = ?')
  for (const task of tasks) {
    set.run(to?.id ?? null, task.id)
    record(scope, task.id, 'field', 'version', from, to?.name ?? null)
    touch(scope, task.id)
  }
  return tasks.map((task) => keyOf(scope, task.number))
}

export function releaseVersion(
  scope: Scope,
  input: ActionInputs['version_release'],
): MutationResult<VersionReleaseResult> {
  const row = resolveVersion(scope, input.version)
  if (row.state === 'released') {
    throw new TaskError(`Version ${row.name} was already released on ${row.released_at}`)
  }
  if (row.state === 'archived') {
    throw new TaskError(`Version ${row.name} is archived; set it back to planned (version_update) before releasing it`)
  }
  const date = input.date === undefined ? today() : cleanDate(input.date, 'date')
  let target: VersionRow | null = null
  const moving = input.moveOpenTo !== undefined && input.moveOpenTo !== null
  if (moving && !(typeof input.moveOpenTo === 'string' && input.moveOpenTo.trim().toLowerCase() === 'none')) {
    target = resolveVersion(scope, input.moveOpenTo, 'moveOpenTo')
    if (target.id === row.id) {
      throw new TaskError(`moveOpenTo must be another version than ${row.name}`)
    }
    if (target.state !== 'planned') {
      throw new TaskError(`moveOpenTo must be a planned version; ${target.name} is ${target.state}`)
    }
  }
  const openTasks = scope.db
    .prepare(
      `SELECT t.id, t.number FROM task t JOIN status s ON s.id = t.status_id
       WHERE t.version_id = ? AND s.category <> 'done' ORDER BY t.rank`,
    )
    .all(row.id) as Array<{ id: number; number: number }>
  const moved = transaction(scope.db, () => {
    scope.db
      .prepare(`UPDATE version SET state = 'released', released_at = ?, updated_at = ? WHERE id = ?`)
      .run(date, now(), row.id)
    return moving ? moveTasks(scope, openTasks, row.name, target) : []
  })
  if (moved.length) {
    scope.notify(moved, 'task')
  }
  scope.notify([], 'version')
  return {
    result: {
      version: versionById(scope, row.id),
      moved: { keys: moved, to: moving ? (target?.name ?? null) : null },
      notes: releaseNotes(scope, row.id),
    },
  }
}
