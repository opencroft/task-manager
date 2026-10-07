// What the App's actions answer an agent by default: compact rows, with null
// and empty fields left out, because every byte of a result is context the
// agent pays for. `detail: "full"` on the same actions gives the shapes the
// UI renders from, so the UI asks for those.

import type { TaskNotification } from './inbox.ts'
import type { RunState, RunStepState, TransitionGate } from './workflows.ts'
import type { CalendarDate, Priority, TaskKey, TaskType } from './types.ts'

/** How much of each record an action returns. */
export type Detail = 'compact' | 'full'

/** The actions that take `detail`; every other action returns one shape. */
export const DETAIL_ACTIONS = [
  'task_list',
  'task_get',
  'my_work',
  'task_create',
  'task_update',
  'task_change_status',
  'task_move',
  'task_link',
  'task_unlink',
  'workflow_runs_list',
  'workflow_start',
  'workflow_step_finish',
  'workflow_step_decide',
  'workflow_step_restart',
  'workflow_run_cancel',
  'inbox_list',
  'version_list',
  'version_create',
  'version_update',
  'version_release',
] as const
export type DetailAction = (typeof DETAIL_ACTIONS)[number]

/** One task as a compact list row. Absent fields are null or empty. */
export interface TaskRow {
  key: TaskKey
  summary: string
  /** The status's name. */
  status: string
  type: TaskType
  priority: Priority
  /** The assignee's name. */
  assignee?: string
  parentKey?: TaskKey
  /** Direct subtasks, when there are any. */
  childCount?: number
  labels?: string[]
  /** The version's name. */
  version?: string
  startDate?: CalendarDate
  endDate?: CalendarDate
  /** The tasks blocking this one that are not done yet. */
  blockedBy?: TaskKey[]
  /** Open pull requests mentioning the task, when there are any. */
  openPrs?: number
  /** `<space>.<app>`, the App the task is in: only on answers across projects. */
  app?: string
}

// A compact answer is also a bounded one: a task's comments and an agent's
// assigned tasks can run to hundreds of rows, so the compact shape returns the
// latest or first few with the total, and says where the rest are.

/** Comments `task_get` returns by default, the latest ones. */
export const TASK_GET_COMMENTS = 5
/** The most comments one answer holds: `task_get`'s `commentsLimit` and `task_comments`'s `limit`. */
export const COMMENTS_MAX = 50
/** Comments a `task_comments` page holds by default. */
export const COMMENTS_PAGE = 10
/** Assigned tasks `my_work` returns by default: the My work page's section limit. */
export const MY_WORK_ASSIGNED = 10
/** The most `assignedLimit` raises `my_work`'s assigned rows to. */
export const MY_WORK_ASSIGNED_MAX = 200

/** A related task or a subtask in `task_get`'s compact answer. */
export interface RelatedRow {
  key: TaskKey
  summary: string
  /** The status's name. */
  status: string
}

/** One comment, with an unedited comment's `updatedAt` and a `mine` that is false left out. */
export interface CommentRow {
  id: number
  author: { kind: 'agent' | 'person'; name: string }
  /** Markdown. */
  body: string
  createdAt: string
  /** Only when the comment was edited. */
  updatedAt?: string
  /** Only when the caller wrote it. */
  mine?: true
}

/** One notification with its statuses by name; empty fields left out. */
export type NotificationRow = Omit<TaskNotification, 'from' | 'to'> & { from?: string; to?: string }

/** One workflow run in brief; `workflow_run_get` gives it in full, with each step's summary and session. */
export interface RunRow {
  taskKey: TaskKey
  workflow: string
  state: RunState
  startedAt: string
  endedAt?: string
  steps: Array<{
    name: string
    state: RunStepState
    /** The agent the step went to. */
    agent?: string
    /** The status the task moved to when the step ended. */
    outcome?: string
    /** The gate result of its last round: pass (moved on) or fail (sent back). */
    gate?: TransitionGate
    /** Entries into the step, when it was reworked (more than one). */
    attempts?: number
    /** Why its session could not be opened or messaged. */
    error?: string
  }>
}
