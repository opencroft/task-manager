// The task manager's operations: every read and write the UI and agents
// perform, against one instance's database. The action layer (actions.ts)
// builds a Scope per call; nothing here knows about the host, so the whole
// module runs under `node --test` against an in-memory database.
//
// `changeStatus` is the ONLY writer of a task's status: create sets the
// initial one, and every later change — an update, a board move, a status
// deletion, the workflow engine — goes through it and its hooks.

import {
  type Actor,
  type ActivityEntry,
  type Assignee,
  type AssigneeInput,
  type AssigneeOption,
  CALENDAR_DATE_PATTERN,
  type Comment,
  type MutationResult,
  PRIORITIES,
  type PersonAvatar,
  type Position,
  type Priority,
  STATUS_CATEGORIES,
  type Status,
  type StatusCategory,
  type StatusCreateInput,
  type StatusDeleteInput,
  type StatusRef,
  type StatusReorderInput,
  type StatusUpdateInput,
  TASK_KEY_PATTERN,
  TASK_LIST_MAX_LIMIT,
  TASK_TYPES,
  type Task,
  type TaskChangeStatusInput,
  type TaskCommentDeleteInput,
  type TaskCommentInput,
  type TaskCommentUpdateInput,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskKey,
  type TaskListInput,
  type TaskListResult,
  type TaskMoveInput,
  type TaskParent,
  type TaskSortField,
  type TaskSummary,
  type TaskType,
  type TaskUpdateInput,
  type TasksEvent,
} from '../shared/types.ts'
import type { BoardRestriction } from '../shared/boards.ts'
import { type FieldFilterInput, fieldFilterOf, isFieldFilter } from '../shared/filters.ts'
import { RELATION_GROUPS, type RelationGroup } from '../shared/dependencies.ts'
import { readTaskKeyQuery } from '../src/components/ui/navigation/task-key-query.ts'
import { didYouMean } from './closest-names.ts'
import { type Db, transaction } from './db.ts'
import {
  type Invocation,
  type StatusChangeEvent,
  type TaskEvent,
  runAfterStatusChange,
  runBeforeStatusChange,
  runTaskEvent,
} from './hooks.ts'
import { removeGoneFiles } from './attachments/files.ts'
import { attachBlockers, relatedIds } from './dependencies/store.ts'
import { evenRanks, rankBetween } from './rank.ts'
import { findStatus } from './status-refs.ts'
import { OPEN_PR_NUMBERS, countPullRequests, pullRequestsOf } from './forge/store.ts'
import { resolveVersion, versionIdFor } from './versions/store.ts'

/** A refusal meant for the caller: wrong input, missing task, a rule. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

export interface AgentInfo {
  id: string
  name: string
  detail?: string
  /** The picture the host's group chat shows for the agent; null or absent without one. */
  avatarUrl?: string | null
}

/** Everything one call needs: the instance's database, who asked, and how to announce changes. */
export interface Scope {
  db: Db
  instanceId: string
  /** The instance's data directory, where attachment files live; absent for a test's in-memory database. */
  dataDir?: string
  projectKey: string
  inv: Invocation
  notify(keys: TaskKey[], kind: TasksEvent['kind']): void
  /** The agents a task can be assigned to. */
  agents(): Promise<AgentInfo[]>
  /** The people in the host's user directory; empty on a host without one. */
  people(): Promise<PersonInfo[]>
}

export interface PersonInfo {
  id: string
  name: string
  /** The account's picture in the host's user directory; null or absent without one. */
  avatarUrl?: string | null
}

// ─── Rows ──────────────────────────────────────────────────────────────────

interface TaskRow {
  id: number
  number: number
  summary: string
  description: string
  status_id: number
  type: TaskType
  priority: Priority
  assignee_kind: 'agent' | 'person' | null
  assignee_id: string | null
  assignee_name: string | null
  reporter_kind: 'agent' | 'person'
  reporter_name: string
  parent_id: number | null
  rank: string
  start_date: string | null
  end_date: string | null
  created_at: string
  updated_at: string
  s_name: string
  s_category: StatusCategory
  s_color: string | null
  s_position: number
  parent_number: number | null
  child_count: number
  child_done_count: number
  labels: string | null
  version_id: number | null
  version_name: string | null
  version_state: 'planned' | 'released' | 'archived' | null
  /** The states of the pull requests mentioning the task, comma-separated; null for none. */
  pr_states: string | null
}

interface StatusRow {
  id: number
  name: string
  category: StatusCategory
  color: string | null
  position: number
}

const SUMMARY_SELECT = `
  SELECT t.*, s.name AS s_name, s.category AS s_category, s.color AS s_color, s.position AS s_position,
    p.number AS parent_number,
    (SELECT count(*) FROM task c WHERE c.parent_id = t.id) AS child_count,
    (SELECT count(*) FROM task c JOIN status cs ON cs.id = c.status_id WHERE c.parent_id = t.id AND cs.category = 'done') AS child_done_count,
    (SELECT group_concat(l.label, char(31)) FROM task_label l WHERE l.task_id = t.id) AS labels,
    (SELECT v.name FROM version v WHERE v.id = t.version_id) AS version_name,
    (SELECT v.state FROM version v WHERE v.id = t.version_id) AS version_state,
    (SELECT group_concat(pr.state) FROM pull_request_mention m JOIN pull_request pr ON pr.id = m.pr_id WHERE m.number = t.number) AS pr_states
  FROM task t
  JOIN status s ON s.id = t.status_id
  LEFT JOIN task p ON p.id = t.parent_id`

const now = () => new Date().toISOString()

export function keyOf(scope: Scope, number: number): TaskKey {
  return `${scope.projectKey}-${number}`
}

function toStatus(row: StatusRow): Status {
  return { id: row.id, name: row.name, category: row.category, color: row.color, position: row.position }
}

function toAssignee(row: Pick<TaskRow, 'assignee_kind' | 'assignee_id' | 'assignee_name'>): Assignee | null {
  if (row.assignee_kind === 'agent') {
    return { kind: 'agent', id: row.assignee_id ?? '', name: row.assignee_name ?? '' }
  }
  if (row.assignee_kind === 'person') {
    return row.assignee_id
      ? { kind: 'person', id: row.assignee_id, name: row.assignee_name ?? '' }
      : { kind: 'person', name: row.assignee_name ?? '' }
  }
  return null
}

function toSummary(scope: Scope, row: TaskRow): TaskSummary {
  return {
    key: keyOf(scope, row.number),
    number: row.number,
    summary: row.summary,
    status: { id: row.status_id, name: row.s_name, category: row.s_category, color: row.s_color, position: row.s_position },
    type: row.type,
    priority: row.priority,
    assignee: toAssignee(row),
    reporter: { kind: row.reporter_kind, name: row.reporter_name },
    parentKey: row.parent_number === null ? null : keyOf(scope, row.parent_number),
    childCount: row.child_count,
    childDoneCount: row.child_done_count,
    labels: row.labels ? row.labels.split('\u001f').sort((a, b) => a.localeCompare(b)) : [],
    version: row.version_name && row.version_state ? { name: row.version_name, state: row.version_state } : null,
    startDate: row.start_date,
    endDate: row.end_date,
    rank: row.rank,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Filled in by attachBlockers where a summary leaves this module.
    blockers: [],
    prs: countPullRequests(row.pr_states),
  }
}

// ─── Lookups ───────────────────────────────────────────────────────────────

function numberFromKey(scope: Scope, key: unknown): number {
  if (typeof key === 'number' && Number.isInteger(key)) {
    return key
  }
  if (typeof key !== 'string') {
    throw new TaskError('A task is referenced by its key, e.g. "TASK-12"')
  }
  const trimmed = key.trim().toUpperCase()
  const match = TASK_KEY_PATTERN.exec(trimmed)
  if (match) {
    if (match[1] !== scope.projectKey) {
      throw new TaskError(`${trimmed} belongs to project ${match[1]}, not ${scope.projectKey}`)
    }
    return Number(match[2])
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }
  throw new TaskError(`Not a task key: "${key}". Keys look like ${scope.projectKey}-12`)
}

function findRow(scope: Scope, key: unknown): TaskRow | undefined {
  return scope.db.prepare(`${SUMMARY_SELECT} WHERE t.number = ?`).get(numberFromKey(scope, key)) as TaskRow | undefined
}

export function requireRow(scope: Scope, key: unknown): TaskRow {
  const row = findRow(scope, key)
  if (!row) {
    throw new TaskError(`No task ${typeof key === 'string' ? key.toUpperCase() : key} in project ${scope.projectKey}`)
  }
  return row
}

function rowById(scope: Scope, id: number): TaskRow {
  return scope.db.prepare(`${SUMMARY_SELECT} WHERE t.id = ?`).get(id) as unknown as TaskRow
}

function statuses(scope: Pick<Scope, 'db'>): StatusRow[] {
  return scope.db.prepare('SELECT * FROM status ORDER BY position, id').all() as unknown as StatusRow[]
}

/** The status `ref` names; refused, with the close names, when none does. Needs only the database. */
export function resolveStatus(scope: Pick<Scope, 'db'>, ref: StatusRef): StatusRow {
  const all = statuses(scope)
  const found = findStatus(all, ref)
  if (!found) {
    const names = all.map((s) => s.name)
    throw new TaskError(`No status "${ref}".${didYouMean(String(ref), names)} Statuses: ${names.join(', ')}`)
  }
  return found
}

function defaultStatus(scope: Scope): StatusRow {
  const all = statuses(scope)
  const first = all.find((s) => s.category === 'todo') ?? all[0]
  if (!first) {
    throw new TaskError('The project has no statuses')
  }
  return first
}

/** Ids of `id` and everything below it. */
function subtreeIds(scope: Scope, id: number): number[] {
  const rows = scope.db
    .prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT t.id FROM task t JOIN sub ON t.parent_id = sub.id)
       SELECT id FROM sub`,
    )
    .all(id) as Array<{ id: number }>
  return rows.map((row) => row.id)
}

// ─── Validation ────────────────────────────────────────────────────────────

function cleanSummary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TaskError('A task needs a summary')
  }
  const summary = value.replace(/\s+/g, ' ').trim()
  if (summary.length > 500) {
    throw new TaskError('A summary is at most 500 characters')
  }
  return summary
}

function cleanType(value: unknown): TaskType {
  if (!TASK_TYPES.includes(value as TaskType)) {
    throw new TaskError(`Type must be one of: ${TASK_TYPES.join(', ')}`)
  }
  return value as TaskType
}

function cleanPriority(value: unknown): Priority {
  if (!PRIORITIES.includes(value as Priority)) {
    throw new TaskError(`Priority must be one of: ${PRIORITIES.join(', ')}`)
  }
  return value as Priority
}

function cleanLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TaskError('Labels are a list of strings')
  }
  const labels = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new TaskError('Labels are a list of strings')
    }
    const label = raw.replace(/\s+/g, ' ').trim()
    if (label.length > 50) {
      throw new TaskError(`Label "${label}" is longer than 50 characters`)
    }
    if (label) {
      labels.add(label)
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b))
}

export function cleanDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value !== 'string' || !CALENDAR_DATE_PATTERN.test(value)) {
    throw new TaskError(`${field} must be a date as YYYY-MM-DD`)
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TaskError(`${field} is not a real date: ${value}`)
  }
  return value
}

function checkDates(start: string | null, end: string | null): void {
  if ((start === null) !== (end === null)) {
    throw new TaskError('Set both startDate and endDate, or neither (unscheduled)')
  }
  if (start !== null && end !== null && end < start) {
    throw new TaskError(`endDate ${end} is before startDate ${start}`)
  }
}

/** "me" names the caller, so an agent can assign itself or list its tasks without knowing how it is listed. */
function isMe(name: string): boolean {
  return name.trim().toLowerCase() === 'me'
}

async function resolveAssignee(scope: Scope, input: AssigneeInput | null | undefined): Promise<Assignee | null> {
  if (input === null || input === undefined || input === '') {
    return null
  }
  const agents = await scope.agents()
  const byName = (name: string) => agents.find((a) => a.name.toLowerCase() === name.trim().toLowerCase())
  if (typeof input === 'string') {
    const name = input.replace(/\s+/g, ' ').trim()
    if (name.toLowerCase() === 'none') {
      return null
    }
    const wanted = isMe(name) ? scope.inv.actor.name : name
    const agent = byName(wanted)
    if (agent) {
      return { kind: 'agent', id: agent.id, name: agent.name }
    }
    // A bare name must be someone already known: a typo'd agent name would otherwise become a person.
    const people = (await listAssignees(scope)).flatMap((option) => (option.assignee.kind === 'person' ? [option.assignee] : []))
    const person = people.find((p) => p.name.toLowerCase() === wanted.toLowerCase())
    if (person) {
      return person
    }
    if (isMe(name) && scope.inv.actor.kind === 'person') {
      return { kind: 'person', name: scope.inv.actor.name }
    }
    throw new TaskError(
      `No agent or person "${name}".${didYouMean(name, [...agents.map((a) => a.name), ...people.map((p) => p.name)])} ` +
        'Use assignee_list to see who can be assigned; to assign a new person, pass {kind:"person", name}',
    )
  }
  if (input.kind === 'agent') {
    const agent = input.id ? agents.find((a) => a.id === input.id) : input.name ? byName(input.name) : undefined
    if (!agent) {
      const hint = input.name ? didYouMean(input.name, agents.map((a) => a.name)) : ''
      throw new TaskError(`No agent ${input.id ?? input.name ?? ''}.${hint} Use assignee_list to see who can be assigned`)
    }
    return { kind: 'agent', id: agent.id, name: agent.name }
  }
  if (input.kind === 'person') {
    const people = await scope.people()
    if (typeof input.id === 'string' && input.id) {
      const person = people.find((p) => p.id === input.id)
      if (!person) {
        throw new TaskError(`No person with id ${input.id}. Use assignee_list to see who can be assigned`)
      }
      return { kind: 'person', id: person.id, name: person.name }
    }
    if (typeof input.name === 'string' && input.name.trim()) {
      const name = input.name.replace(/\s+/g, ' ').trim()
      const person = people.find((p) => p.name.toLowerCase() === name.toLowerCase())
      return person ? { kind: 'person', id: person.id, name: person.name } : { kind: 'person', name }
    }
  }
  throw new TaskError('An assignee is a name, {kind:"agent", id|name} or {kind:"person", id|name}')
}

// ─── Activity ──────────────────────────────────────────────────────────────

export function record(
  scope: Scope,
  taskId: number,
  kind: string,
  field: string | null = null,
  from: string | null = null,
  to: string | null = null,
): void {
  scope.db
    .prepare(
      `INSERT INTO activity (task_id, actor_kind, actor_name, kind, field, from_value, to_value, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(taskId, scope.inv.actor.kind, scope.inv.actor.name, kind, field, from, to, now())
}

export function touch(scope: Scope, taskId: number): void {
  scope.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(now(), taskId)
}

// ─── Ranks ─────────────────────────────────────────────────────────────────

/** Longest rank key kept before the whole list is respaced. */
const MAX_RANK_LENGTH = 12

/** Respace every task's rank evenly, keeping the order. Runs inside the caller's transaction. */
function rebalanceRanks(scope: Scope): void {
  const ids = (scope.db.prepare('SELECT id FROM task ORDER BY rank, id').all() as Array<{ id: number }>).map((row) => row.id)
  const keys = evenRanks(ids.length)
  const set = scope.db.prepare('UPDATE task SET rank = ? WHERE id = ?')
  ids.forEach((id, index) => set.run(keys[index], id))
}

/**
 * The rank a task takes for a requested position; `selfId` is excluded from
 * neighbour lookups. Inserting repeatedly at one spot lengthens keys, so a key
 * past MAX_RANK_LENGTH respaces the list first and is computed again.
 */
function rankFor(scope: Scope, position: Position, selfId?: number): string {
  const rank = rankIn(scope, position, selfId)
  if (rank.length <= MAX_RANK_LENGTH) {
    return rank
  }
  rebalanceRanks(scope)
  return rankIn(scope, position, selfId)
}

function rankIn(scope: Scope, position: Position, selfId?: number): string {
  if (position.before && position.after) {
    throw new TaskError('Give either before or after, not both')
  }
  const exclude = selfId ?? -1
  if (position.before || position.after) {
    const anchor = requireRow(scope, position.before ?? position.after)
    if (anchor.id === selfId) {
      throw new TaskError('A task cannot be positioned relative to itself')
    }
    if (position.before) {
      const prev = scope.db
        .prepare('SELECT rank FROM task WHERE rank < ? AND id != ? ORDER BY rank DESC LIMIT 1')
        .get(anchor.rank, exclude) as { rank: string } | undefined
      return rankBetween(prev?.rank ?? null, anchor.rank)
    }
    const next = scope.db
      .prepare('SELECT rank FROM task WHERE rank > ? AND id != ? ORDER BY rank LIMIT 1')
      .get(anchor.rank, exclude) as { rank: string } | undefined
    return rankBetween(anchor.rank, next?.rank ?? null)
  }
  const last = scope.db.prepare('SELECT max(rank) AS rank FROM task WHERE id != ?').get(exclude) as {
    rank: string | null
  }
  return rankBetween(last.rank, null)
}

// ─── Reads ─────────────────────────────────────────────────────────────────

const SORT_SQL: Record<TaskSortField, string> = {
  rank: 't.rank',
  key: 't.number',
  summary: 't.summary COLLATE NOCASE',
  status: 's.position',
  type: "CASE t.type WHEN 'epic' THEN 0 WHEN 'story' THEN 1 WHEN 'task' THEN 2 ELSE 3 END",
  priority:
    "CASE t.priority WHEN 'lowest' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 4 END",
  assignee: 't.assignee_name IS NULL, t.assignee_name COLLATE NOCASE',
  reporter: 't.reporter_name COLLATE NOCASE',
  startDate: 't.start_date IS NULL, t.start_date',
  endDate: 't.end_date IS NULL, t.end_date',
  createdAt: 't.created_at',
  updatedAt: 't.updated_at',
}

/** A piece of a WHERE clause and the values for its placeholders. */
interface SqlCondition {
  sql: string
  args: Array<string | number>
}

function inList(column: string, values: ReadonlyArray<string | number>): SqlCondition {
  return { sql: `${column} IN (${values.map(() => '?').join(',')})`, args: [...values] }
}

/**
 * A match on a nullable column, where `'none'` among `values` matches NULL
 * and `match` takes the rest. It is false on a NULL row, never NULL, so its
 * `NOT` keeps such a row.
 */
function orNone<T>(column: string, values: T[], match: (rest: T[]) => SqlCondition): SqlCondition {
  const rest = values.filter((value) => String(value).trim().toLowerCase() !== 'none')
  const parts: SqlCondition[] = []
  if (rest.length < values.length) {
    parts.push({ sql: `${column} IS NULL`, args: [] })
  }
  if (rest.length) {
    const matched = match(rest)
    parts.push({ sql: `(${column} IS NOT NULL AND ${matched.sql})`, args: matched.args })
  }
  return { sql: `(${parts.map((part) => part.sql).join(' OR ')})`, args: parts.flatMap((part) => part.args) }
}

/** A filter field's include and exclude lists, refusing an object that is not `{ include?, exclude? }` of lists. */
export function checkedFieldFilter<T>(name: string, value: unknown): { include: T[]; exclude: T[] } {
  if (isFieldFilter(value)) {
    const unknown = Object.keys(value).filter((key) => key !== 'include' && key !== 'exclude')
    if (unknown.length) {
      throw new TaskError(`${name} takes a list, or { include, exclude } with a list in each; it has no ${unknown.map((key) => `"${key}"`).join(', ')}`)
    }
    for (const key of ['include', 'exclude'] as const) {
      if (value[key] !== undefined && value[key] !== null && !Array.isArray(value[key])) {
        throw new TaskError(`${name}.${key} must be a list`)
      }
    }
  }
  return fieldFilterOf(value as FieldFilterInput<T>)
}

/** Summary or description containing `text`, case-insensitively: the trigram index from three characters, a scan below. */
function textContains(text: string): SqlCondition {
  if (text.length >= 3) {
    return { sql: 't.id IN (SELECT rowid FROM task_fts WHERE task_fts MATCH ?)', args: [`"${text.replace(/"/g, '""')}"`] }
  }
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return { sql: `(t.summary LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`, args: [pattern, pattern] }
}

/** SQL conditions over `t` (the task) and `s` (its status) for the filters of `input`, ANDed. */
function filterClauses(scope: Scope, input: Omit<TaskListInput, 'board' | 'sort' | 'limit' | 'offset'>): { where: string[]; args: Array<string | number> } {
  const where: string[] = []
  const args: Array<string | number> = []

  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query) {
    const key = readTaskKeyQuery(query)
    const parts: SqlCondition[] = []
    if (key && (key.project === null || key.project === scope.projectKey)) {
      parts.push({ sql: 't.number = ?', args: [key.number] })
    }
    parts.push(textContains(query))
    // A key copied with other dashes or punctuation also finds the tasks that mention it as written.
    const keyText = key?.project ? `${key.project}-${key.number}` : null
    if (keyText && keyText !== query.toUpperCase()) {
      parts.push(textContains(keyText))
    }
    where.push(`(${parts.map((part) => part.sql).join(' OR ')})`)
    args.push(...parts.flatMap((part) => part.args))
  }

  // Each field adds its match for the included values, and the match's negation for the excluded ones.
  const field = <T>(name: string, value: unknown, match: (values: T[]) => SqlCondition) => {
    const { include, exclude } = checkedFieldFilter<T>(name, value)
    for (const [values, negate] of [
      [include, false],
      [exclude, true],
    ] as const) {
      if (values.length) {
        const condition = match(values)
        where.push(negate ? `NOT ${condition.sql}` : condition.sql)
        args.push(...condition.args)
      }
    }
  }

  field<StatusRef>('status', input.status, (refs) => inList('t.status_id', refs.map((ref) => resolveStatus(scope, ref).id)))
  field<StatusCategory>('statusCategory', input.statusCategory, (categories) => {
    for (const category of categories) {
      if (!STATUS_CATEGORIES.includes(category)) {
        throw new TaskError(`statusCategory must be one of: ${STATUS_CATEGORIES.join(', ')}`)
      }
    }
    return inList('s.category', categories)
  })
  field<string>('assignee', input.assignee, (assignees) =>
    orNone(
      't.assignee_name',
      assignees.map((name) => (isMe(name) ? scope.inv.actor.name : name)),
      (names) => inList('t.assignee_name COLLATE NOCASE', names),
    ),
  )
  field<TaskType>('type', input.type, (types) => inList('t.type', types.map(cleanType)))
  field<Priority>('priority', input.priority, (priorities) => inList('t.priority', priorities.map(cleanPriority)))
  field<string>('label', input.label, (labels) => {
    const labelsIn = inList('l.label', labels)
    return { sql: `EXISTS (SELECT 1 FROM task_label l WHERE l.task_id = t.id AND ${labelsIn.sql})`, args: labelsIn.args }
  })
  field<string>('version', input.version, (versions) =>
    orNone('t.version_id', versions, (refs) => inList('t.version_id', refs.map((ref) => resolveVersion(scope, ref).id))),
  )
  field<TaskKey>('parent', input.parent, (parents) =>
    orNone('t.parent_id', parents, (keys) => inList('t.parent_id', keys.map((key) => requireRow(scope, key).id))),
  )
  if (typeof input.scheduled === 'boolean') {
    where.push(input.scheduled ? 't.start_date IS NOT NULL' : 't.start_date IS NULL')
  }
  if (typeof input.hasOpenPr === 'boolean') {
    where.push(`t.number ${input.hasOpenPr ? 'IN' : 'NOT IN'} (${OPEN_PR_NUMBERS})`)
  }
  return { where, args }
}

/**
 * The tasks matching `input`, a page at a time. On a board, only those in its
 * statuses that also match its preset filter.
 */
export function listTasks(scope: Scope, input: Omit<TaskListInput, 'board'> = {}, board?: BoardRestriction): TaskListResult {
  const { where, args } = filterClauses(scope, input)
  if (board) {
    // A board with no statuses shows no tasks.
    where.push(board.statusIds.length ? `t.status_id IN (${board.statusIds.map(() => '?').join(',')})` : '0')
    args.push(...board.statusIds)
    const preset = filterClauses(scope, board.filter)
    where.push(...preset.where)
    args.push(...preset.args)
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const sortField = input.sort?.field ?? 'rank'
  if (!(sortField in SORT_SQL)) {
    throw new TaskError(`Cannot sort by ${sortField}. Sort fields: ${Object.keys(SORT_SQL).join(', ')}`)
  }
  const dir = input.sort?.dir === 'desc' ? 'DESC' : 'ASC'
  const order = SORT_SQL[sortField]
    .split(', ')
    .map((part) => (part.endsWith('IS NULL') ? part : `${part} ${dir}`))
    .join(', ')
  const limit = Math.min(Math.max(Math.trunc(Number(input.limit ?? 200)) || 200, 1), TASK_LIST_MAX_LIMIT)
  const offset = Math.max(Math.trunc(Number(input.offset ?? 0)) || 0, 0)

  const rows = scope.db
    .prepare(`${SUMMARY_SELECT}${whereSql} ORDER BY ${order}, t.rank LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as unknown as TaskRow[]
  const total = (
    scope.db
      .prepare(`SELECT count(*) AS n FROM task t JOIN status s ON s.id = t.status_id${whereSql}`)
      .get(...args) as { n: number }
  ).n
  return { tasks: attachBlockers(scope, rows.map((row) => toSummary(scope, row))), total }
}

/**
 * Summaries of the tasks matching a condition, for the modules beside this
 * one that select tasks `listTasks` has no filter for. The condition and the
 * order are SQL over `t` (the task) and `s` (its status).
 */
export function summariesWhere(scope: Scope, where: string, args: Array<string | number>, order: string): TaskSummary[] {
  const rows = scope.db.prepare(`${SUMMARY_SELECT} WHERE ${where} ORDER BY ${order}`).all(...args) as unknown as TaskRow[]
  return attachBlockers(scope, rows.map((row) => toSummary(scope, row)))
}

export function getTask(scope: Scope, key: unknown): Task {
  const row = requireRow(scope, key)
  const summary = toSummary(scope, row)
  const ancestors: Task['ancestors'] = []
  let parentId = row.parent_id
  while (parentId !== null) {
    const parent = scope.db.prepare('SELECT id, number, summary, parent_id FROM task WHERE id = ?').get(parentId) as {
      id: number
      number: number
      summary: string
      parent_id: number | null
    }
    ancestors.unshift({ key: keyOf(scope, parent.number), summary: parent.summary })
    parentId = parent.parent_id
  }
  const subtasks = (
    scope.db.prepare(`${SUMMARY_SELECT} WHERE t.parent_id = ? ORDER BY t.rank`).all(row.id) as unknown as TaskRow[]
  ).map((child) => toSummary(scope, child))
  const related = relatedIds(scope, row.id)
  const summariesOf = (ids: number[]): TaskSummary[] =>
    ids.length === 0
      ? []
      : (
          scope.db
            .prepare(`${SUMMARY_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.rank`)
            .all(...ids) as unknown as TaskRow[]
        ).map((linkedRow) => toSummary(scope, linkedRow))
  const relations = Object.fromEntries(RELATION_GROUPS.map((group) => [group, summariesOf(related[group])])) as Record<RelationGroup, TaskSummary[]>
  attachBlockers(scope, [summary, ...subtasks, ...RELATION_GROUPS.flatMap((group) => relations[group])])
  const comments = (scope.db.prepare('SELECT * FROM comment WHERE task_id = ? ORDER BY created_at, id').all(row.id) as CommentRow[]).map((c) =>
    commentOf(scope, c),
  )
  const activity = (
    scope.db.prepare('SELECT * FROM activity WHERE task_id = ? ORDER BY at, id').all(row.id) as Array<{
      id: number
      actor_kind: 'agent' | 'person'
      actor_name: string
      kind: ActivityEntry['kind']
      field: string | null
      from_value: string | null
      to_value: string | null
      at: string
    }>
  ).map(
    (a): ActivityEntry => ({
      id: a.id,
      actor: { kind: a.actor_kind, name: a.actor_name },
      kind: a.kind,
      field: a.field,
      from: a.from_value,
      to: a.to_value,
      at: a.at,
    }),
  )
  return {
    ...summary,
    description: row.description,
    ancestors,
    subtasks,
    ...relations,
    comments,
    activity,
    pullRequests: pullRequestsOf(scope, row.number),
  }
}

// ─── Status transitions ────────────────────────────────────────────────────

interface PendingStatusChange {
  event: StatusChangeEvent
}

/**
 * Write a status change inside the caller's transaction: run the veto hooks,
 * write, record. Returns the event for the after-commit hooks, or null when
 * the task already has that status.
 */
function applyStatus(scope: Scope, row: TaskRow, to: StatusRow): PendingStatusChange | null {
  if (row.status_id === to.id) {
    return null
  }
  const from: Status = { id: row.status_id, name: row.s_name, category: row.s_category, color: row.s_color, position: row.s_position }
  const event: StatusChangeEvent = {
    instanceId: scope.instanceId,
    projectKey: scope.projectKey,
    task: toSummary(scope, row),
    from,
    to: toStatus(to),
    actor: scope.inv.actor,
    inv: scope.inv,
  }
  runBeforeStatusChange(event)
  scope.db.prepare('UPDATE task SET status_id = ?, updated_at = ? WHERE id = ?').run(to.id, now(), row.id)
  record(scope, row.id, 'field', 'status', from.name, to.name)
  return { event }
}

async function finishStatusChanges(scope: Scope, pending: Array<PendingStatusChange | null>): Promise<string[]> {
  const warnings: string[] = []
  for (const change of pending) {
    if (!change) {
      continue
    }
    const fresh = rowById(scope, (findRow(scope, change.event.task.key) as TaskRow).id)
    warnings.push(...(await runAfterStatusChange({ ...change.event, task: toSummary(scope, fresh) })))
  }
  return warnings
}

function withWarnings<T>(result: T, warnings: string[]): MutationResult<T> {
  return warnings.length ? { result, warnings } : { result }
}

type Announced = { kind: 'assigned'; assignee: Assignee } | { kind: 'commented'; comment: Comment }

/** Tell the task-event listeners (the inbox) about a committed write. */
function announce(scope: Scope, task: TaskSummary, what: Announced): Promise<void> {
  const base = { instanceId: scope.instanceId, projectKey: scope.projectKey, task, actor: scope.inv.actor, inv: scope.inv }
  return runTaskEvent({ ...base, ...what } as TaskEvent)
}

/** Change one task's status — the single path every status change takes. */
export async function changeStatus(scope: Scope, input: TaskChangeStatusInput): Promise<MutationResult<Task>> {
  const row = requireRow(scope, input.key)
  const to = resolveStatus(scope, input.status)
  const body = typeof input.comment === 'string' ? input.comment.trim() : ''
  const [pending, comment] = transaction(scope.db, () => {
    const change = applyStatus(scope, row, to)
    return [change, body ? insertComment(scope, row.id, body) : null] as const
  })
  const key = keyOf(scope, row.number)
  if (pending || body) {
    scope.notify([key], 'task')
  }
  const warnings = await finishStatusChanges(scope, [pending])
  const task = getTask(scope, key)
  if (comment) {
    await announce(scope, task, { kind: 'commented', comment })
  }
  return withWarnings(task, warnings)
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createTask(scope: Scope, input: TaskCreateInput): Promise<MutationResult<Task>> {
  const summary = cleanSummary(input.summary)
  const description = typeof input.description === 'string' ? input.description : ''
  const type = input.type === undefined ? 'task' : cleanType(input.type)
  const priority = input.priority === undefined ? 'medium' : cleanPriority(input.priority)
  const status = input.status === undefined || input.status === null || input.status === '' ? defaultStatus(scope) : resolveStatus(scope, input.status)
  const labels = input.labels === undefined ? [] : cleanLabels(input.labels)
  const startDate = cleanDate(input.startDate, 'startDate')
  const endDate = cleanDate(input.endDate, 'endDate')
  checkDates(startDate, endDate)
  const assignee = await resolveAssignee(scope, input.assignee)
  const parent = input.parent ? requireRow(scope, input.parent) : null
  const versionId = input.version === undefined ? null : versionIdFor(scope, input.version)

  const number = transaction(scope.db, () => {
    const meta = scope.db.prepare("SELECT value FROM project_meta WHERE key = 'next_number'").get() as { value: string }
    const next = Number(meta.value)
    scope.db.prepare("UPDATE project_meta SET value = ? WHERE key = 'next_number'").run(String(next + 1))
    const rank = rankFor(scope, { before: input.before, after: input.after })
    const stamp = now()
    const result = scope.db
      .prepare(
        `INSERT INTO task (number, summary, description, status_id, type, priority, assignee_kind, assignee_id,
           assignee_name, reporter_kind, reporter_name, parent_id, rank, start_date, end_date, created_at, updated_at,
           version_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next,
        summary,
        description,
        status.id,
        type,
        priority,
        assignee?.kind ?? null,
        assignee?.id ?? null,
        assignee?.name ?? null,
        scope.inv.actor.kind,
        scope.inv.actor.name,
        parent?.id ?? null,
        rank,
        startDate,
        endDate,
        stamp,
        stamp,
        versionId,
      )
    const id = Number(result.lastInsertRowid)
    const addLabel = scope.db.prepare('INSERT INTO task_label (task_id, label) VALUES (?, ?)')
    for (const label of labels) {
      addLabel.run(id, label)
    }
    record(scope, id, 'created')
    if (parent) {
      record(scope, parent.id, 'subtask_added', null, null, keyOf(scope, next))
      touch(scope, parent.id)
    }
    return next
  })
  const key = keyOf(scope, number)
  scope.notify(parent ? [key, keyOf(scope, parent.number)] : [key], 'task')
  const task = getTask(scope, key)
  if (assignee) {
    await announce(scope, task, { kind: 'assigned', assignee })
  }
  return { result: task }
}

function describeAssignee(assignee: Assignee | null): string | null {
  return assignee ? assignee.name : null
}

export async function updateTask(scope: Scope, input: TaskUpdateInput): Promise<MutationResult<Task>> {
  const row = requireRow(scope, input.key)
  const sets: string[] = []
  const args: Array<string | number | null> = []
  const changes: Array<[field: string, from: string | null, to: string | null]> = []

  if (input.summary !== undefined) {
    const summary = cleanSummary(input.summary)
    if (summary !== row.summary) {
      sets.push('summary = ?')
      args.push(summary)
      changes.push(['summary', row.summary, summary])
    }
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new TaskError('description is markdown text')
    }
    if (input.description !== row.description) {
      sets.push('description = ?')
      args.push(input.description)
      changes.push(['description', null, null])
    }
  }
  if (input.type !== undefined) {
    const type = cleanType(input.type)
    if (type !== row.type) {
      sets.push('type = ?')
      args.push(type)
      changes.push(['type', row.type, type])
    }
  }
  if (input.priority !== undefined) {
    const priority = cleanPriority(input.priority)
    if (priority !== row.priority) {
      sets.push('priority = ?')
      args.push(priority)
      changes.push(['priority', row.priority, priority])
    }
  }
  let assigned: Assignee | null = null
  if (input.assignee !== undefined) {
    const assignee = await resolveAssignee(scope, input.assignee)
    const before = toAssignee(row)
    const same =
      (assignee === null && before === null) ||
      (assignee !== null &&
        before !== null &&
        assignee.kind === before.kind &&
        assignee.name === before.name &&
        assignee.id === before.id)
    if (!same) {
      sets.push('assignee_kind = ?', 'assignee_id = ?', 'assignee_name = ?')
      args.push(assignee?.kind ?? null, assignee?.id ?? null, assignee?.name ?? null)
      changes.push(['assignee', describeAssignee(before), describeAssignee(assignee)])
      assigned = assignee
    }
  }
  if (input.startDate !== undefined || input.endDate !== undefined) {
    // One side alone moves that side of an existing range; clearing either clears both.
    let start = input.startDate !== undefined ? cleanDate(input.startDate, 'startDate') : row.start_date
    let end = input.endDate !== undefined ? cleanDate(input.endDate, 'endDate') : row.end_date
    if ((input.startDate !== undefined && start === null) || (input.endDate !== undefined && end === null)) {
      start = null
      end = null
    }
    checkDates(start, end)
    if (start !== row.start_date || end !== row.end_date) {
      sets.push('start_date = ?', 'end_date = ?')
      args.push(start, end)
      const describe = (s: string | null, e: string | null) => (s ? `${s} → ${e}` : null)
      changes.push(['dates', describe(row.start_date, row.end_date), describe(start, end)])
    }
  }
  let labels: string[] | undefined
  if (input.labels !== undefined) {
    labels = cleanLabels(input.labels)
    const before = toSummary(scope, row).labels
    if (labels.join('\u001f') === before.join('\u001f')) {
      labels = undefined
    } else {
      changes.push(['labels', before.join(', ') || null, labels.join(', ') || null])
    }
  }
  if (input.version !== undefined) {
    const versionId = versionIdFor(scope, input.version)
    if (versionId !== row.version_id) {
      sets.push('version_id = ?')
      args.push(versionId)
      const name = versionId === null ? null : resolveVersion(scope, versionId).name
      changes.push(['version', row.version_name, name])
    }
  }
  const to = input.status !== undefined && input.status !== null && input.status !== '' ? resolveStatus(scope, input.status) : null

  const pending = transaction(scope.db, () => {
    if (sets.length) {
      scope.db.prepare(`UPDATE task SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), row.id)
    }
    if (labels !== undefined) {
      scope.db.prepare('DELETE FROM task_label WHERE task_id = ?').run(row.id)
      const addLabel = scope.db.prepare('INSERT INTO task_label (task_id, label) VALUES (?, ?)')
      for (const label of labels) {
        addLabel.run(row.id, label)
      }
      touch(scope, row.id)
    }
    for (const [field, from, value] of changes) {
      record(scope, row.id, 'field', field, from, value)
    }
    return to ? applyStatus(scope, rowById(scope, row.id), to) : null
  })
  const key = keyOf(scope, row.number)
  if (changes.length || pending) {
    scope.notify([key], 'task')
  }
  const warnings = await finishStatusChanges(scope, [pending])
  const task = getTask(scope, key)
  if (assigned) {
    await announce(scope, task, { kind: 'assigned', assignee: assigned })
  }
  return withWarnings(task, warnings)
}

export function moveTask(scope: Scope, input: TaskMoveInput): MutationResult<TaskSummary> {
  const row = requireRow(scope, input.key)
  let parentId = row.parent_id
  let newParent: TaskRow | null = null
  if (input.parent !== undefined) {
    if (input.parent === null || input.parent === '' || String(input.parent).toLowerCase() === 'none') {
      parentId = null
    } else {
      newParent = requireRow(scope, input.parent)
      if (subtreeIds(scope, row.id).includes(newParent.id)) {
        throw new TaskError(
          newParent.id === row.id
            ? 'A task cannot be its own parent'
            : `${keyOf(scope, newParent.number)} is inside ${keyOf(scope, row.number)}; moving it there would make a cycle`,
        )
      }
      parentId = newParent.id
    }
  }
  const repositions = Boolean(input.before || input.after)
  const reparents = parentId !== row.parent_id
  if (!repositions && !reparents) {
    return { result: toSummary(scope, row) }
  }
  const affected = new Set<TaskKey>([keyOf(scope, row.number)])
  transaction(scope.db, () => {
    const rank = repositions ? rankFor(scope, { before: input.before, after: input.after }, row.id) : row.rank
    scope.db.prepare('UPDATE task SET parent_id = ?, rank = ?, updated_at = ? WHERE id = ?').run(parentId, rank, now(), row.id)
    if (reparents) {
      const oldParent = row.parent_id === null ? null : rowById(scope, row.parent_id)
      record(
        scope,
        row.id,
        'field',
        'parent',
        oldParent ? keyOf(scope, oldParent.number) : null,
        newParent ? keyOf(scope, newParent.number) : null,
      )
      if (oldParent) {
        record(scope, oldParent.id, 'subtask_removed', null, keyOf(scope, row.number), null)
        touch(scope, oldParent.id)
        affected.add(keyOf(scope, oldParent.number))
      }
      if (newParent) {
        record(scope, newParent.id, 'subtask_added', null, null, keyOf(scope, row.number))
        touch(scope, newParent.id)
        affected.add(keyOf(scope, newParent.number))
      }
    }
  })
  scope.notify([...affected], 'task')
  return { result: attachBlockers(scope, [toSummary(scope, rowById(scope, row.id))])[0] }
}

export function deleteTask(scope: Scope, input: TaskDeleteInput): MutationResult<{ deleted: TaskKey[] }> {
  const row = requireRow(scope, input.key)
  const ids = subtreeIds(scope, row.id)
  if (ids.length > 1 && input.withSubtasks !== true) {
    throw new TaskError(
      `${keyOf(scope, row.number)} has ${ids.length - 1} subtask(s); pass withSubtasks: true to delete them too`,
    )
  }
  const numbers = scope.db
    .prepare(`SELECT number FROM task WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY number`)
    .all(...ids) as Array<{ number: number }>
  const deleted = numbers.map((n) => keyOf(scope, n.number))
  const affected = [...deleted]
  transaction(scope.db, () => {
    scope.db.prepare('DELETE FROM task WHERE id = ?').run(row.id)
    if (row.parent_id !== null) {
      const parent = rowById(scope, row.parent_id)
      record(scope, parent.id, 'subtask_removed', null, keyOf(scope, row.number), null)
      touch(scope, parent.id)
      affected.push(keyOf(scope, parent.number))
    }
  })
  // The deleted tasks' attachments went by cascade; their files go now.
  if (scope.dataDir) {
    removeGoneFiles(scope.db, scope.dataDir)
  }
  scope.notify(affected, 'task')
  return { result: { deleted } }
}

function insertComment(scope: Scope, taskId: number, body: string): Comment {
  const stamp = now()
  const result = scope.db
    .prepare('INSERT INTO comment (task_id, author_kind, author_name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, scope.inv.actor.kind, scope.inv.actor.name, body, stamp, stamp)
  touch(scope, taskId)
  return { id: Number(result.lastInsertRowid), author: scope.inv.actor, body, createdAt: stamp, updatedAt: stamp }
}

export async function addComment(scope: Scope, input: TaskCommentInput): Promise<MutationResult<Comment>> {
  const row = requireRow(scope, input.key)
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) {
    throw new TaskError('A comment needs a body')
  }
  const comment = transaction(scope.db, () => insertComment(scope, row.id, body))
  const key = keyOf(scope, row.number)
  scope.notify([key], 'comment')
  await announce(scope, getTask(scope, key), { kind: 'commented', comment })
  return { result: comment }
}

export type CommentRow = { id: number; task_id: number; author_kind: 'agent' | 'person'; author_name: string; body: string; created_at: string; updated_at: string }

/** Whether the caller wrote the comment. Comments carry the author's kind and name, as history does. */
function isCallers(scope: Scope, comment: Pick<CommentRow, 'author_kind' | 'author_name'>): boolean {
  return comment.author_kind === scope.inv.actor.kind && comment.author_name === scope.inv.actor.name
}

/** A comment as the actions return it, `mine` for the caller. */
export function commentOf(scope: Scope, c: CommentRow): Comment {
  return {
    id: c.id,
    author: { kind: c.author_kind, name: c.author_name },
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    mine: isCallers(scope, c),
  }
}

/** A whole number from `min` to `max`, or `fallback` when the value is absent. */
export function limitParam(name: string, value: unknown, fallback: number, max: number, min = 1): number {
  if (value === undefined || value === null) {
    return fallback
  }
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TaskError(`"${name}" must be a whole number from ${min} to ${max}`)
  }
  return value as number
}

/** One of the caller's own comments on the task, or a refusal saying why not. */
function ownComment(scope: Scope, taskId: number, key: string, id: unknown, verb: string): CommentRow {
  const comment = Number.isInteger(id)
    ? (scope.db.prepare('SELECT * FROM comment WHERE id = ? AND task_id = ?').get(id as number, taskId) as CommentRow | undefined)
    : undefined
  if (!comment) {
    throw new TaskError(`${key} has no comment ${String(id)}`)
  }
  if (!isCallers(scope, comment)) {
    throw new TaskError(`Only its author (${comment.author_name}) can ${verb} this comment`)
  }
  return comment
}

/** Change the text of your own comment. Mentions in the new text notify no one again. */
export function updateComment(scope: Scope, input: TaskCommentUpdateInput): MutationResult<Comment> {
  const row = requireRow(scope, input.key)
  const key = keyOf(scope, row.number)
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) {
    throw new TaskError('A comment needs a body')
  }
  const comment = transaction(scope.db, () => {
    const existing = ownComment(scope, row.id, key, input.id, 'edit')
    const stamp = now()
    scope.db.prepare('UPDATE comment SET body = ?, updated_at = ? WHERE id = ?').run(body, stamp, existing.id)
    touch(scope, row.id)
    return { ...existing, body, updated_at: stamp }
  })
  scope.notify([key], 'comment')
  return {
    result: {
      id: comment.id,
      author: { kind: comment.author_kind, name: comment.author_name },
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      mine: true,
    },
  }
}

/** Delete your own comment. */
export function deleteComment(scope: Scope, input: TaskCommentDeleteInput): MutationResult<{ deleted: number }> {
  const row = requireRow(scope, input.key)
  const key = keyOf(scope, row.number)
  const deleted = transaction(scope.db, () => {
    const existing = ownComment(scope, row.id, key, input.id, 'delete')
    scope.db.prepare('DELETE FROM comment WHERE id = ?').run(existing.id)
    touch(scope, row.id)
    return existing.id
  })
  scope.notify([key], 'comment')
  return { result: { deleted } }
}

// ─── Statuses ──────────────────────────────────────────────────────────────

export function listStatuses(scope: Scope): Status[] {
  return statuses(scope).map(toStatus)
}

function cleanStatusName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TaskError('A status needs a name')
  }
  const name = value.replace(/\s+/g, ' ').trim()
  if (name.length > 40) {
    throw new TaskError('A status name is at most 40 characters')
  }
  return name
}

function cleanCategory(value: unknown): StatusCategory {
  if (!STATUS_CATEGORIES.includes(value as StatusCategory)) {
    throw new TaskError(`Category must be one of: ${STATUS_CATEGORIES.join(', ')}`)
  }
  return value as StatusCategory
}

function cleanColor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value !== 'string' || !/^(#[0-9a-fA-F]{3,8}|[a-z-]{1,30})$/.test(value)) {
    throw new TaskError('A color is a hex value (#3b82f6) or a color name (blue)')
  }
  return value
}

function assertNameFree(scope: Scope, name: string, selfId?: number): void {
  const clash = statuses(scope).find((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== selfId)
  if (clash) {
    throw new TaskError(`A status named "${clash.name}" already exists`)
  }
}

export function createStatus(scope: Scope, input: StatusCreateInput): MutationResult<Status> {
  const name = cleanStatusName(input.name)
  const category = cleanCategory(input.category)
  const color = cleanColor(input.color)
  assertNameFree(scope, name)
  const id = transaction(scope.db, () => {
    const max = scope.db.prepare('SELECT coalesce(max(position), -1) AS p FROM status').get() as { p: number }
    return Number(
      scope.db
        .prepare('INSERT INTO status (name, category, color, position) VALUES (?, ?, ?, ?)')
        .run(name, category, color, max.p + 1).lastInsertRowid,
    )
  })
  scope.notify([], 'status')
  return { result: toStatus(resolveStatus(scope, id)) }
}

export function updateStatus(scope: Scope, input: StatusUpdateInput): MutationResult<Status> {
  const status = resolveStatus(scope, input.status)
  const name = input.name === undefined ? status.name : cleanStatusName(input.name)
  const category = input.category === undefined ? status.category : cleanCategory(input.category)
  const color = input.color === undefined ? status.color : cleanColor(input.color)
  assertNameFree(scope, name, status.id)
  if (category !== status.category && category !== 'todo' && !statuses(scope).some((s) => s.id !== status.id && s.category === 'todo')) {
    throw new TaskError('The project needs at least one to-do status, where new tasks start')
  }
  scope.db.prepare('UPDATE status SET name = ?, category = ?, color = ? WHERE id = ?').run(name, category, color, status.id)
  scope.notify([], 'status')
  return { result: toStatus(resolveStatus(scope, status.id)) }
}

export function reorderStatuses(scope: Scope, input: StatusReorderInput): MutationResult<Status[]> {
  const all = statuses(scope)
  const order = Array.isArray(input.order) ? input.order.map((ref) => resolveStatus(scope, ref).id) : []
  if (order.length !== all.length || new Set(order).size !== all.length) {
    throw new TaskError(`order must list every status exactly once, by name or id: ${all.map((s) => s.name).join(', ')}`)
  }
  transaction(scope.db, () => {
    const set = scope.db.prepare('UPDATE status SET position = ? WHERE id = ?')
    order.forEach((id, position) => set.run(position, id))
  })
  scope.notify([], 'status')
  return { result: listStatuses(scope) }
}

export async function deleteStatus(scope: Scope, input: StatusDeleteInput): Promise<MutationResult<{ moved: number }>> {
  const status = resolveStatus(scope, input.status)
  const target = resolveStatus(scope, input.moveTo)
  if (target.id === status.id) {
    throw new TaskError('moveTo must be a different status')
  }
  if (status.category === 'todo' && !statuses(scope).some((s) => s.id !== status.id && s.category === 'todo')) {
    throw new TaskError('The project needs at least one to-do status, where new tasks start')
  }
  const rows = scope.db.prepare(`${SUMMARY_SELECT} WHERE t.status_id = ?`).all(status.id) as unknown as TaskRow[]
  // Every task leaves through the status path, so hooks see the move.
  const pending = transaction(scope.db, () => {
    const changes = rows.map((row) => applyStatus(scope, row, target))
    scope.db.prepare('DELETE FROM status WHERE id = ?').run(status.id)
    return changes
  })
  scope.notify(
    rows.map((row) => keyOf(scope, row.number)),
    'task',
  )
  scope.notify([], 'status')
  const warnings = await finishStatusChanges(scope, pending)
  return withWarnings({ moved: rows.length }, warnings)
}

// ─── People and labels ─────────────────────────────────────────────────────

/**
 * Agents, then the people in the user directory, then names this project has
 * used for people outside it (free-text assignees, and reporters from before
 * the directory) — each person once, the directory's spelling winning.
 */
export async function listAssignees(scope: Scope): Promise<AssigneeOption[]> {
  const agents = await scope.agents()
  const directory = await scope.people()
  const known = new Set(directory.map((p) => p.name.toLowerCase()))
  const others = (
    scope.db
      .prepare(
        `SELECT DISTINCT assignee_name AS name FROM task WHERE assignee_kind = 'person' AND assignee_id IS NULL
         UNION SELECT DISTINCT reporter_name FROM task WHERE reporter_kind = 'person' AND reporter_name != 'user'
         ORDER BY 1 COLLATE NOCASE`,
      )
      .all() as Array<{ name: string }>
  ).filter((p) => !known.has(p.name.toLowerCase()))
  return [
    ...agents
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent): AssigneeOption => ({
        assignee: { kind: 'agent', id: agent.id, name: agent.name },
        ...(agent.detail ? { detail: agent.detail } : {}),
      })),
    ...directory.map((p): AssigneeOption => ({ assignee: { kind: 'person', id: p.id, name: p.name } })),
    ...others.map((p): AssigneeOption => ({ assignee: { kind: 'person', name: p.name } })),
  ]
}

/**
 * Every agent and every person in the user directory with their picture, or
 * null for none: what the App's avatars draw. Its own read rather than part of
 * `listAssignees`, because a picture is often an inline image and an agent
 * picking an assignee has no use for it.
 */
export async function listAvatars(scope: Scope): Promise<PersonAvatar[]> {
  const [agents, people] = await Promise.all([scope.agents(), scope.people()])
  return [
    ...agents.map((a): PersonAvatar => ({ kind: 'agent', id: a.id, name: a.name, avatarUrl: a.avatarUrl ?? null })),
    ...people.map((p): PersonAvatar => ({ kind: 'person', id: p.id, name: p.name, avatarUrl: p.avatarUrl ?? null })),
  ]
}

/** Every task that has subtasks, by key and summary, in key order: what a parent filter offers. */
export function listParents(scope: Scope): TaskParent[] {
  const rows = scope.db
    .prepare('SELECT t.number, t.summary FROM task t WHERE EXISTS (SELECT 1 FROM task c WHERE c.parent_id = t.id) ORDER BY t.number')
    .all() as Array<{ number: number; summary: string }>
  return rows.map((row) => ({ key: keyOf(scope, row.number), summary: row.summary }))
}

export function listLabels(scope: Scope): string[] {
  return (scope.db.prepare('SELECT DISTINCT label FROM task_label ORDER BY label COLLATE NOCASE').all() as Array<{ label: string }>).map(
    (row) => row.label,
  )
}

export type { Actor }
