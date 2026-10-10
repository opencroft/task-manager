// The notifications inbox: what a person — or an agent — needs
// to know without watching the board. One inbox per caller per project; the
// kit's `task-inbox` renders `TaskNotification` as is.

import type { ActionInputs } from './action-inputs.ts'
import type { StatusCategory, TaskKey, TaskType } from './types.ts'

export type TaskNotificationKind =
  /** The task was assigned to you. */
  | 'assigned'
  /** You were `@named` in a comment. */
  | 'mentioned'
  /** A workflow step's session was opened for you (an agent). */
  | 'step_open'
  /** A workflow step reached you, a person: there is no session, the step waits on you. */
  | 'step_waiting'
  /** A step of a run you started, or on a task you reported, cannot proceed: `excerpt` says why. */
  | 'step_attention'
  /** A workflow's approval step reached you, one of its approvers: approve or reject the task. */
  | 'approval_requested'
  /** A run you started finished; `to` is the status the task ended in. */
  | 'workflow_finished'
  /** A run you started was cancelled. */
  | 'workflow_cancelled'
  /** A task you reported or are assigned changed status. */
  | 'status_changed'

/** A status as it was when the notification was made — reads the same after a rename. */
export interface NotificationStatus {
  name: string
  category: StatusCategory
  color?: string | null
}

export interface TaskNotification {
  id: string
  kind: TaskNotificationKind
  /** ISO 8601. */
  createdAt: string
  read: boolean
  /** Who did it; null for the workflow engine itself. */
  actor?: { kind: 'agent' | 'person'; name: string } | null
  /** The task as it is now: a deleted task takes its notifications with it. */
  task: { key: TaskKey; summary: string; type?: TaskType }
  workflow?: { name: string }
  step?: { name: string }
  from?: NotificationStatus
  to?: NotificationStatus
  /** `mentioned`: the comment text. `step_attention`: the reason. Plain text. */
  excerpt?: string
  /** You muted this task: nothing new about it comes to your inbox until you unmute it. */
  muted?: boolean
}

/** The kit's filter chips; `workflows` is every `step_*`, `approval_*` and `workflow_*` kind. */
export type InboxFilter = 'all' | 'assigned' | 'mentions' | 'workflows' | 'status'

export const INBOX_FILTERS: Record<InboxFilter, TaskNotificationKind[] | null> = {
  all: null,
  assigned: ['assigned'],
  mentions: ['mentioned'],
  workflows: [
    'step_open',
    'step_waiting',
    'step_attention',
    'approval_requested',
    'workflow_finished',
    'workflow_cancelled',
  ],
  status: ['status_changed'],
}

export interface InboxListResult {
  /** Newest first. */
  items: TaskNotification[]
  /** Unread notifications of every kind, whatever the filter — the bell's count. */
  unread: number
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: string | null
}

/** Some notifications by id, or every one; the schema can only say both are optional. */
export type InboxMarkReadInput = { ids: string[] } | { all: true }

export interface InboxActionMap {
  inbox_list: { input: ActionInputs['inbox_list']; output: InboxListResult }
  inbox_mark_read: { input: InboxMarkReadInput; output: { unread: number } }
  inbox_mark_unread: { input: ActionInputs['inbox_mark_unread']; output: { unread: number } }
  /** `muted` true stops new notifications about the task for the caller; false lets them come again. */
  inbox_mute: { input: ActionInputs['inbox_mute']; output: { task: TaskKey; muted: boolean } }
}

/**
 * The `host.events` name an inbox change is broadcast under — separate from
 * `tasks.changed`, so a new notification does not refetch every page.
 */
export const INBOX_EVENT = 'tasks.inbox'

export interface InboxEvent {
  instanceId: string
}
