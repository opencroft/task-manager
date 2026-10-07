// "My work" for one viewer: the four sections, read from the tasks, the
// workflow runs and the inbox. Pure: a scope and a viewer in, sections out —
// the host is reached only through ./index.ts, so this runs under `node --test`.

import { type MyWorkInput, type MyWorkResult, type MyWorkStep, STARTING_SOON_DAYS } from '../../shared/my-work.ts'
import type { ProjectRef } from '../../shared/projects.ts'
import type { CalendarDate, TaskType } from '../../shared/types.ts'
import type { StepKind } from '../../shared/workflows.ts'
import { listInbox } from '../inbox/store.ts'
import { tagged } from '../projects/across.ts'
import { type Scope, TaskError, keyOf, summariesWhere } from '../service.ts'

/** Who asks. `id` is the agent node id or directory user id; null for an agent no directory lists. */
export interface Viewer {
  kind: 'agent' | 'person'
  id: string | null
  name: string
}

const RECENT_DEFAULT = 8
const RECENT_MAX = 50
const DAY_MS = 24 * 60 * 60 * 1000

const same = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase()

function cleanToday(value: unknown, now: Date): CalendarDate {
  if (value === undefined || value === null || value === '') {
    return now.toISOString().slice(0, 10)
  }
  const text = String(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new TaskError(`today "${text}" is not a date: use YYYY-MM-DD`)
  }
  return text
}

function cleanRecentLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return RECENT_DEFAULT
  }
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_MAX) {
    throw new TaskError(`recentLimit is a whole number, 1–${RECENT_MAX}`)
  }
  return limit
}

function addDays(day: CalendarDate, days: number): CalendarDate {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Tasks assigned to the viewer and not done: matched by id where the task
 * keeps one (every agent, a person from the directory), by name where it
 * does not (a person assigned by name).
 */
function assignedCondition(viewer: Viewer): { sql: string; args: string[] } {
  const open = "s.category <> 'done'"
  if (viewer.id) {
    return {
      sql: `${open} AND t.assignee_kind = ? AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND t.assignee_name = ? COLLATE NOCASE))`,
      args: [viewer.kind, viewer.id, viewer.name],
    }
  }
  return { sql: `${open} AND t.assignee_kind = ? AND t.assignee_name = ? COLLATE NOCASE`, args: [viewer.kind, viewer.name] }
}

interface OpenStepRow {
  run_id: string
  workflow_name: string
  started_by_kind: 'agent' | 'person'
  started_by_name: string
  step_id: string
  step_name: string
  state: 'active' | 'waiting'
  agent_node_id: string | null
  agent_name: string | null
  chat_ref: string | null
  thread_id: string | null
  started_at: string | null
  error: string | null
  number: number
  summary: string
  type: TaskType
  assignee_kind: 'agent' | 'person' | null
  assignee_id: string | null
  assignee_name: string | null
  reporter_kind: 'agent' | 'person'
  reporter_name: string
  /** Who the step's open round waits on or is worked by; null while nobody can work it. */
  round_worker: 'agent' | 'person' | null
  step_kind: StepKind | null
  /** For an approval step: whether the viewer is one of its approvers, and has decided in its open round. */
  viewer_approves: number
  viewer_decided: number
}

/** The host's page for one group-chat thread (as the Workflows page links it). */
function threadHref(chatRef: string, threadId: string): string {
  return `/group-chats/${encodeURIComponent(chatRef)}/${encodeURIComponent(threadId)}`
}

/**
 * The open steps of active runs that need the viewer, the way the engine
 * notifies about them: a session opened for the viewer, an agent (`open`); a
 * step waiting on the task's assignee, the viewer, a person, or an approval
 * step the viewer approves and has not decided yet (`waiting`); a step that
 * cannot proceed, for whoever started the run or reported the task (`attention`).
 */
export function waitingSteps(scope: Scope, viewer: Viewer): MyWorkStep[] {
  // Approvers are people, by directory id.
  const approverId = viewer.kind === 'person' ? (viewer.id ?? '') : ''
  const rows = scope.db
    .prepare(
      `SELECT r.id AS run_id, r.workflow_name, r.started_by_kind, r.started_by_name,
         s.step_id, s.name AS step_name, s.state, s.agent_node_id, s.agent_name, s.chat_ref, s.thread_id, s.started_at, s.error,
         t.number, t.summary, t.type, t.assignee_kind, t.assignee_id, t.assignee_name, t.reporter_kind, t.reporter_name,
         (SELECT o.worker_kind FROM workflow_run_round o
          WHERE o.run_id = r.id AND o.step_id = s.step_id AND o.ended_at IS NULL
          ORDER BY o.round_no DESC LIMIT 1) AS round_worker,
         ws.kind AS step_kind,
         EXISTS (SELECT 1 FROM workflow_step_approver a WHERE a.step_id = s.step_id AND a.person_id = ?) AS viewer_approves,
         EXISTS (SELECT 1 FROM workflow_run_vote v
                 WHERE v.run_id = r.id AND v.step_id = s.step_id AND v.person_id = ?
                   AND v.round_no = (SELECT max(o.round_no) FROM workflow_run_round o WHERE o.run_id = r.id AND o.step_id = s.step_id)
         ) AS viewer_decided
       FROM workflow_run r
       JOIN workflow_run_step s ON s.run_id = r.id AND s.state IN ('active', 'waiting')
       JOIN task t ON t.id = r.task_id
       LEFT JOIN workflow_step ws ON ws.id = s.step_id
       WHERE r.state = 'active'`,
    )
    .all(approverId, approverId) as unknown as OpenStepRow[]

  const isViewer = (kind: 'agent' | 'person', id: string | null, name: string | null) =>
    kind === viewer.kind && (viewer.id && id ? id === viewer.id : same(name, viewer.name))

  const steps: MyWorkStep[] = []
  for (const row of rows) {
    let state: MyWorkStep['state'] | null = null
    if (row.state === 'active') {
      state = isViewer('agent', row.agent_node_id, row.agent_name) ? 'open' : null
    } else if (row.step_kind === 'approval') {
      state = row.viewer_approves && !row.viewer_decided ? 'waiting' : null
    } else if (row.round_worker === 'person') {
      state = row.assignee_kind && isViewer(row.assignee_kind, row.assignee_id, row.assignee_name) ? 'waiting' : null
    } else if (isViewer(row.started_by_kind, null, row.started_by_name) || isViewer(row.reporter_kind, null, row.reporter_name)) {
      state = 'attention'
    }
    if (!state) {
      continue
    }
    steps.push({
      id: `${row.run_id}:${row.step_id}`,
      state,
      task: { key: keyOf(scope, row.number), summary: row.summary, type: row.type },
      workflow: row.workflow_name,
      step: row.step_name,
      since: row.started_at ?? '',
      reason: state === 'attention' ? row.error : null,
      sessionHref: state === 'open' && row.chat_ref && row.thread_id ? threadHref(row.chat_ref, row.thread_id) : null,
    })
  }
  return steps.sort((a, b) => a.since.localeCompare(b.since))
}

/** The input's day and recent limit, checked; the defaults where it gives none. */
export function cleanMyWorkInput(input: MyWorkInput, now = new Date()): { today: CalendarDate; recentLimit: number } {
  return { today: cleanToday(input.today, now), recentLimit: cleanRecentLimit(input.recentLimit) }
}

function viewerOut(viewer: Viewer): MyWorkResult['viewer'] {
  return viewer.id ? { kind: viewer.kind, id: viewer.id, name: viewer.name } : { kind: viewer.kind, name: viewer.name }
}

/** Everything the "My work" page shows for the viewer. */
export function myWork(scope: Scope, viewer: Viewer, input: MyWorkInput = {}, now = new Date()): MyWorkResult {
  const { today, recentLimit } = cleanMyWorkInput(input, now)
  const mine = assignedCondition(viewer)
  const assigned = summariesWhere(scope, mine.sql, mine.args, 't.end_date IS NULL, t.end_date, t.rank')
  const startingSoon = summariesWhere(
    scope,
    `${mine.sql} AND t.start_date >= ? AND t.start_date <= ?`,
    [...mine.args, today, addDays(today, STARTING_SOON_DAYS - 1)],
    't.start_date, t.rank',
  )
  // An inbox is keyed by id; an agent no directory lists has none.
  const recent = viewer.id ? listInbox(scope.db, scope.projectKey, `${viewer.kind}:${viewer.id}`, { limit: recentLimit }).items : []
  return {
    viewer: viewerOut(viewer),
    today,
    waiting: waitingSteps(scope, viewer),
    assigned,
    startingSoon,
    recent,
  }
}

/**
 * My work across projects: each project's sections merged, every row tagged
 * with its project, each section in its own order — Waiting oldest first,
 * Assigned by end date with undated last, Starting soon soonest first, Recent
 * newest first and `recentLimit` in all. Rows that tie keep the projects' order.
 */
export function mergeMyWork(
  viewer: Viewer,
  input: MyWorkInput,
  parts: Array<{ project: ProjectRef; value: MyWorkResult }>,
  now = new Date(),
): MyWorkResult {
  const { today, recentLimit } = cleanMyWorkInput(input, now)
  const section = <K extends 'waiting' | 'assigned' | 'startingSoon' | 'recent'>(name: K) =>
    tagged(parts.map(({ project, value }) => ({ project, value: value[name] as Array<MyWorkResult[K][number]> })))
  const undatedLast = (day: string | null) => day ?? '9999-99-99'
  return {
    viewer: viewerOut(viewer),
    today,
    waiting: section('waiting').sort((a, b) => a.since.localeCompare(b.since)),
    assigned: section('assigned').sort((a, b) => undatedLast(a.endDate).localeCompare(undatedLast(b.endDate))),
    startingSoon: section('startingSoon').sort((a, b) => undatedLast(a.startDate).localeCompare(undatedLast(b.startDate))),
    recent: section('recent')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, recentLimit),
  }
}
