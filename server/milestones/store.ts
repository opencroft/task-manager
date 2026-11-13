// The project's milestones: create, rename, re-plan, archive, restore and delete, and
// what a task's write does when the task enters or leaves one. A task's
// milestone is a column on the task, so task_create, task_update and
// task_list reach it through the service; everything about the milestones
// themselves, and the dates a task gets on entering one, lives here. No host
// in sight: the whole module runs under `node --test`.

import type { ActionInputs } from '../../shared/action-inputs.ts'
import { replaceFilterValue } from '../../shared/filters.ts'
import {
  compareMilestones,
  MILESTONE_NAME_MAX,
  type Milestone,
  type MilestoneDeleted,
  type MilestoneState,
} from '../../shared/milestones.ts'
import type { CalendarDate, MutationResult, TaskKey } from '../../shared/types.ts'
import { DEFAULT_SPAN_DAYS, fromDay, toDay } from '../../src/components/ui/timeline/timeline-scale.ts'
import { didYouMean } from '../closest-names.ts'
import { transaction } from '../db.ts'
import { cleanDate, describeDates, keyOf, record, type Scope, TaskError } from '../service.ts'
import { rewriteStoredFilters } from '../views/stored-filters.ts'

const DESCRIPTION_MAX = 200

export interface MilestoneRecord {
  id: number
  name: string
  state: MilestoneState
  start_date: string | null
  target_date: string | null
  description: string
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()
/** Today as the server reads it: the UTC date. */
const today = (): CalendarDate => now().slice(0, 10)

function counts(scope: Scope): Map<number, { open: number; done: number }> {
  const rows = scope.db
    .prepare(
      `SELECT t.milestone_id AS id, SUM(s.category = 'done') AS done, SUM(s.category <> 'done') AS open
       FROM task t JOIN status s ON s.id = t.status_id WHERE t.milestone_id IS NOT NULL GROUP BY t.milestone_id`,
    )
    .all() as Array<{ id: number; open: number; done: number }>
  return new Map(rows.map((row) => [row.id, { open: row.open, done: row.done }]))
}

function toMilestone(row: MilestoneRecord, count = { open: 0, done: 0 }): Milestone {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    startDate: row.start_date,
    targetDate: row.target_date,
    description: row.description,
    openCount: count.open,
    doneCount: count.done,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function records(scope: Scope): MilestoneRecord[] {
  return scope.db.prepare('SELECT * FROM milestone').all() as unknown as MilestoneRecord[]
}

function milestoneById(scope: Scope, id: number): Milestone {
  const row = scope.db.prepare('SELECT * FROM milestone WHERE id = ?').get(id) as unknown as MilestoneRecord
  return toMilestone(row, counts(scope).get(id))
}

/** Every milestone in the listing order (`compareMilestones`), optionally only those in some states. */
export function listMilestones(scope: Scope, input: ActionInputs['milestone_list'] = {}): { milestones: Milestone[] } {
  const states = input.state ?? []
  const count = counts(scope)
  return {
    milestones: records(scope)
      .filter((row) => states.length === 0 || states.includes(row.state))
      .map((row) => toMilestone(row, count.get(row.id)))
      .sort(compareMilestones),
  }
}

/** `"none"` (any case), `""` and null mean no milestone wherever a task names one. */
function namesNone(ref: unknown): boolean {
  return ref === null || ref === '' || (typeof ref === 'string' && ref.trim().toLowerCase() === 'none')
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!name) {
    throw new TaskError('A milestone needs a name')
  }
  if (name.length > MILESTONE_NAME_MAX) {
    throw new TaskError(`A milestone's name is at most ${MILESTONE_NAME_MAX} characters`)
  }
  if (namesNone(name)) {
    throw new TaskError('"none" cannot name a milestone: it means no milestone')
  }
  return name
}

function cleanDescription(value: string): string {
  const description = value.replace(/\s+/g, ' ').trim()
  if (description.length > DESCRIPTION_MAX) {
    throw new TaskError(`A milestone's description is at most ${DESCRIPTION_MAX} characters`)
  }
  return description
}

function checkSpan(start: string | null, target: string | null): void {
  if (start !== null && target !== null && target < start) {
    throw new TaskError(`targetDate ${target} is before startDate ${start}`)
  }
}

/**
 * The milestone `ref` names: a number is its id; text is its name, ignoring
 * case, and only failing that an id written as digits, so a milestone may be
 * named "2027".
 */
export function resolveMilestone(scope: Scope, ref: unknown, field = 'milestone'): MilestoneRecord {
  const byId = (id: number) =>
    scope.db.prepare('SELECT * FROM milestone WHERE id = ?').get(id) as MilestoneRecord | undefined
  if (typeof ref === 'number') {
    const found = byId(ref)
    if (found) {
      return found
    }
  } else if (typeof ref === 'string' && ref.trim()) {
    const wanted = ref.replace(/\s+/g, ' ').trim()
    const found =
      (scope.db.prepare('SELECT * FROM milestone WHERE name = ?').get(wanted) as MilestoneRecord | undefined) ??
      (/^\d+$/.test(wanted) ? byId(Number(wanted)) : undefined)
    if (found) {
      return found
    }
  } else {
    throw new TaskError(`${field} must be a milestone's name`)
  }
  const names = listMilestones(scope).milestones.map((milestone) => milestone.name)
  throw new TaskError(
    `No milestone "${String(ref).trim()}".${didYouMean(String(ref), names)} ${names.length ? `Milestones: ${names.join(', ')}` : 'The project has no milestones yet; milestone_create makes one'}`,
  )
}

/**
 * The milestone a task write puts the task in, or null for none. An archived
 * milestone takes no new tasks, but naming the one the task is already in is
 * not refused: it changes nothing.
 */
export function milestoneFor(scope: Scope, ref: unknown, currentId: number | null = null): MilestoneRecord | null {
  if (namesNone(ref)) {
    return null
  }
  const row = resolveMilestone(scope, ref)
  if (row.state === 'archived' && row.id !== currentId) {
    throw new TaskError(
      `Milestone ${row.name} is archived; restore it (milestone_update with state "open") to put tasks in it`,
    )
  }
  return row
}

function assertNameFree(scope: Scope, name: string, selfId?: number): void {
  const taken = scope.db.prepare('SELECT id, name FROM milestone WHERE name = ?').get(name) as
    | { id: number; name: string }
    | undefined
  if (taken && taken.id !== selfId) {
    throw new TaskError(`Milestone ${taken.name} already exists`)
  }
}

export function createMilestone(scope: Scope, input: ActionInputs['milestone_create']): MutationResult<Milestone> {
  const name = cleanName(input.name)
  const startDate = cleanDate(input.startDate, 'startDate')
  const targetDate = cleanDate(input.targetDate, 'targetDate')
  checkSpan(startDate, targetDate)
  const description = input.description === undefined ? '' : cleanDescription(input.description)
  assertNameFree(scope, name)
  const stamp = now()
  const result = scope.db
    .prepare(
      `INSERT INTO milestone (name, state, start_date, target_date, description, created_at, updated_at)
       VALUES (?, 'open', ?, ?, ?, ?, ?)`,
    )
    .run(name, startDate, targetDate, description, stamp, stamp)
  scope.notify([], 'milestone')
  return { result: milestoneById(scope, Number(result.lastInsertRowid)) }
}

export function updateMilestone(scope: Scope, input: ActionInputs['milestone_update']): MutationResult<Milestone> {
  const row = resolveMilestone(scope, input.milestone)
  const sets: string[] = []
  const args: Array<string | null> = []
  let renamed: string | null = null
  if (input.name !== undefined) {
    const name = cleanName(input.name)
    if (name !== row.name) {
      assertNameFree(scope, name, row.id)
      sets.push('name = ?')
      args.push(name)
      renamed = name
    }
  }
  const startDate = input.startDate === undefined ? row.start_date : cleanDate(input.startDate, 'startDate')
  const targetDate = input.targetDate === undefined ? row.target_date : cleanDate(input.targetDate, 'targetDate')
  checkSpan(startDate, targetDate)
  // Re-planning moves the span only: its tasks keep their dates.
  if (startDate !== row.start_date) {
    sets.push('start_date = ?')
    args.push(startDate)
  }
  if (targetDate !== row.target_date) {
    sets.push('target_date = ?')
    args.push(targetDate)
  }
  if (input.description !== undefined) {
    const description = cleanDescription(input.description)
    if (description !== row.description) {
      sets.push('description = ?')
      args.push(description)
    }
  }
  // Archiving or restoring changes nothing about the milestone's tasks.
  if (input.state !== undefined && input.state !== row.state) {
    sets.push('state = ?')
    args.push(input.state)
  }
  if (sets.length) {
    transaction(scope.db, () => {
      scope.db
        .prepare(`UPDATE milestone SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...args, now(), row.id)
      if (renamed) {
        rewriteStoredFilters(scope.db, (filter) => replaceFilterValue(filter, 'milestone', row.name, renamed))
      }
    })
    scope.notify([], 'milestone')
  }
  return { result: milestoneById(scope, row.id) }
}

/**
 * Delete a milestone. Its tasks leave it as `milestone: "none"` would take
 * them out: each keeps its dates and gets a history entry. Saved views and
 * boards drop it from their milestone filters.
 */
export function deleteMilestone(
  scope: Scope,
  input: ActionInputs['milestone_delete'],
): MutationResult<MilestoneDeleted> {
  const row = resolveMilestone(scope, input.milestone)
  const tasks = scope.db
    .prepare('SELECT id, number, start_date, end_date FROM task WHERE milestone_id = ? ORDER BY rank')
    .all(row.id) as Array<Omit<TaskDatesRow, 'milestone_name'>>
  const moves = tasks.map((task) => moveOf(scope, { ...task, milestone_name: row.name }, null))
  transaction(scope.db, () => {
    applyMoves(scope, moves)
    rewriteStoredFilters(scope.db, (filter) => replaceFilterValue(filter, 'milestone', row.name, null))
    scope.db.prepare('DELETE FROM milestone WHERE id = ?').run(row.id)
  })
  const keys = moves.map((move) => move.key)
  if (keys.length) {
    scope.notify(keys, 'task')
  }
  scope.notify([], 'milestone')
  return { result: { deleted: row.name, tasks: keys } }
}

// ─── Entering and leaving ──────────────────────────────────────────────────

export interface Dates {
  startDate: CalendarDate | null
  endDate: CalendarDate | null
}

/**
 * The dates a task has once it enters `milestone`. Its span runs from its
 * start (today without one) to its target (open-ended without one). Dates
 * that overlap the span are kept; otherwise the task starts on the later of
 * the milestone's start and today and keeps its length, DEFAULT_SPAN_DAYS
 * when it had no dates (the length a drop on the Timeline gives).
 */
export function datesOnEntry(
  task: Dates,
  milestone: Pick<MilestoneRecord, 'start_date' | 'target_date'>,
  now: CalendarDate = today(),
): Dates {
  const spanStart = milestone.start_date ?? now
  const spanEnd = milestone.target_date
  if (task.startDate !== null && task.endDate !== null) {
    const overlaps = task.endDate >= spanStart && (spanEnd === null || task.startDate <= spanEnd)
    if (overlaps) {
      return task
    }
  }
  const start = toDay(milestone.start_date !== null && milestone.start_date > now ? milestone.start_date : now)
  const length =
    task.startDate !== null && task.endDate !== null
      ? toDay(task.endDate) - toDay(task.startDate)
      : DEFAULT_SPAN_DAYS - 1
  return { startDate: fromDay(start), endDate: fromDay(start + length) }
}

/** A task the milestone change reaches: the task itself or a subtask that follows it. */
export interface MilestoneMove {
  id: number
  key: TaskKey
  from: string | null
  to: MilestoneRecord | null
  dates: Dates
  /** Set when entering the milestone gives the task other dates. */
  newDates: Dates | null
}

interface TaskDatesRow {
  id: number
  number: number
  start_date: string | null
  end_date: string | null
  milestone_name: string | null
}

/** One task's move: its new dates by `datesOnEntry` when it enters a milestone, none when it leaves. */
export function moveOf(scope: Scope, task: TaskDatesRow, to: MilestoneRecord | null, keepDates = false): MilestoneMove {
  const dates = { startDate: task.start_date, endDate: task.end_date }
  const entered = to && !keepDates ? datesOnEntry(dates, to) : dates
  const changed = entered.startDate !== dates.startDate || entered.endDate !== dates.endDate
  return {
    id: task.id,
    key: keyOf(scope, task.number),
    from: task.milestone_name,
    to,
    dates,
    newDates: changed ? entered : null,
  }
}

/**
 * The subtasks that follow a task leaving milestone `fromId` (null: none) for
 * `to`: those in `fromId` too, at any depth, through subtasks that follow. A
 * subtask in another milestone stays, and so do the subtasks below it, which
 * follow that one instead.
 */
export function followingSubtasks(
  scope: Scope,
  taskId: number,
  fromId: number | null,
  to: MilestoneRecord | null,
): MilestoneMove[] {
  const rows = scope.db
    .prepare(
      `WITH RECURSIVE following(id) AS (
         SELECT id FROM task WHERE parent_id = ? AND milestone_id IS ?
         UNION ALL
         SELECT t.id FROM task t JOIN following f ON t.parent_id = f.id WHERE t.milestone_id IS ?
       )
       SELECT t.id, t.number, t.start_date, t.end_date, m.name AS milestone_name
       FROM task t JOIN following f ON f.id = t.id LEFT JOIN milestone m ON m.id = t.milestone_id
       ORDER BY t.rank`,
    )
    .all(taskId, fromId, fromId) as unknown as TaskDatesRow[]
  return rows.map((row) => moveOf(scope, row, to))
}

/** Write the subtasks' moves, inside the caller's transaction: each its own history entries. */
export function applyMoves(scope: Scope, moves: MilestoneMove[]): void {
  const stamp = now()
  for (const move of moves) {
    const dates = move.newDates ?? move.dates
    scope.db
      .prepare('UPDATE task SET milestone_id = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?')
      .run(move.to?.id ?? null, dates.startDate, dates.endDate, stamp, move.id)
    record(scope, move.id, 'field', 'milestone', move.from, move.to?.name ?? null)
    if (move.newDates) {
      record(
        scope,
        move.id,
        'field',
        'dates',
        describeDates(move.dates.startDate, move.dates.endDate),
        describeDates(move.newDates.startDate, move.newDates.endDate),
      )
    }
  }
}

/** The warning naming a task whose dates entering a milestone moved. */
export function datesWarning(move: MilestoneMove): string | null {
  if (!move.newDates || !move.to) {
    return null
  }
  const was = describeDates(move.dates.startDate, move.dates.endDate)
  return `${move.key} is dated ${describeDates(move.newDates.startDate, move.newDates.endDate)} to fit milestone ${move.to.name} (${was ? `was ${was}` : 'it had no dates'})`
}
