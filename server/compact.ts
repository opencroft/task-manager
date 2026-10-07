// The compact answers of shared/compact.ts, made from the full ones. The
// handlers stay as they are and return the full shape; `withDetail` shortens
// the result on its way out unless the caller asked for `detail: "full"`, and
// bounds the lists that grow without end (a task's comments, the tasks
// assigned to the caller) by the limits the call gives.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import {
  type CommentRow,
  DETAIL_ACTIONS,
  type Detail,
  type DetailAction,
  COMMENTS_MAX,
  MY_WORK_ASSIGNED,
  MY_WORK_ASSIGNED_MAX,
  type NotificationRow,
  type RelatedRow,
  type RunRow,
  TASK_GET_COMMENTS,
  type TaskRow,
} from '../shared/compact.ts'
import { RELATION_GROUPS } from '../shared/dependencies.ts'
import type { InboxListResult, TaskNotification } from '../shared/inbox.ts'
import type { MyWorkResult } from '../shared/my-work.ts'
import type { ProjectRef } from '../shared/projects.ts'
import type { Comment, MutationResult, Task, TaskListResult, TaskSummary } from '../shared/types.ts'
import type { Version, VersionReleaseResult, VersionRow } from '../shared/versions.ts'
import type { WorkflowRun } from '../shared/workflows.ts'
import { limitParam } from './service.ts'

/** The same object without its null, undefined, empty-string and empty-array fields. */
export function withoutEmpty<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null && field !== undefined && field !== '' && !(Array.isArray(field) && field.length === 0)),
  ) as Partial<T>
}

export function taskRow(task: TaskSummary): TaskRow {
  return withoutEmpty({
    key: task.key,
    summary: task.summary,
    status: task.status.name,
    type: task.type,
    priority: task.priority,
    assignee: task.assignee?.name,
    parentKey: task.parentKey,
    childCount: task.childCount || undefined,
    labels: task.labels,
    version: task.version?.name,
    startDate: task.startDate,
    endDate: task.endDate,
    blockedBy: task.blockers.filter((blocker) => blocker.open).map((blocker) => blocker.key),
    openPrs: task.prs.open || undefined,
  }) as TaskRow
}

export function relatedRow(task: TaskSummary): RelatedRow {
  return { key: task.key, summary: task.summary, status: task.status.name }
}

export function commentRow(comment: Comment): CommentRow {
  return {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    ...(comment.updatedAt !== comment.createdAt ? { updatedAt: comment.updatedAt } : {}),
    ...(comment.mine ? { mine: true as const } : {}),
  }
}

/**
 * One task for an agent: its fields with the empty ones left out, related
 * tasks and subtasks as rows, and only the latest comments, oldest of them
 * first, with how many there are (`task_comments` reads the rest).
 */
export function compactTask(task: Task, commentsLimit: number) {
  const { comments, subtasks, ...fields } = task
  const relations = Object.fromEntries(RELATION_GROUPS.map((group) => [group, task[group].map(relatedRow)]))
  return withoutEmpty({
    ...fields,
    subtasks: subtasks.map(relatedRow),
    ...relations,
    comments: comments.slice(-commentsLimit).map(commentRow),
    commentsTotal: comments.length,
  })
}

export function runRow(run: WorkflowRun): RunRow {
  return withoutEmpty({
    taskKey: run.taskKey,
    workflow: run.workflowName,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    steps: run.steps.map((step) =>
      withoutEmpty({
        name: step.name,
        state: step.state,
        agent: step.agentName,
        outcome: step.outcome,
        gate: step.rounds.at(-1)?.gate,
        attempts: step.attempts > 1 ? step.attempts : undefined,
        error: step.error,
      }),
    ),
  }) as RunRow
}

export function versionRow(version: Version): VersionRow {
  return withoutEmpty({
    name: version.name,
    state: version.state,
    targetDate: version.targetDate,
    releasedAt: version.releasedAt,
    description: version.description,
    open: version.openCount || undefined,
    done: version.doneCount || undefined,
  }) as VersionRow
}

export function notificationRow(notification: TaskNotification): NotificationRow {
  return withoutEmpty({ ...notification, from: notification.from?.name, to: notification.to?.name }) as NotificationRow
}

/** A row of an answer across projects keeps only its App's address: the key already names the project. */
function withApp<R extends object>(row: R, source: { project?: ProjectRef }): R & { app?: string } {
  const { project: _project, ...rest } = row as R & { project?: ProjectRef }
  return (source.project ? { ...rest, app: source.project.app } : rest) as R & { app?: string }
}

function mutation<T>(result: MutationResult<T>, row: (value: T) => unknown): unknown {
  return { ...result, result: row(result.result) }
}

/** The parameters that bound a compact answer; `detail: "full"` is the page's whole shape and ignores them. */
type Limits = Record<string, unknown>

// biome-ignore lint/suspicious/noExplicitAny: each entry knows its own action's full shape
const COMPACT: Record<DetailAction, (full: any, limits: Limits) => unknown> = {
  task_list: (full: TaskListResult) => ({
    tasks: full.tasks.map((task) => withApp(taskRow(task), task)),
    total: full.total,
    ...(full.projects ? { projects: full.projects } : {}),
  }),
  task_get: (full: Task, limits) => compactTask(full, limitParam('commentsLimit', limits.commentsLimit, TASK_GET_COMMENTS, COMMENTS_MAX)),
  my_work: (full: MyWorkResult, limits) => {
    // Across projects the cap is on the merged list: the first rows of all of them.
    const assigned = full.assigned.slice(0, limitParam('assignedLimit', limits.assignedLimit, MY_WORK_ASSIGNED, MY_WORK_ASSIGNED_MAX))
    const shown = new Set(assigned.map((task) => task.key))
    // Every task starting soon is one of the caller's assigned tasks: by key, not
    // again in full. Those past the cap are named, so no key points at a missing row.
    const startingSoon = full.startingSoon.map((task) => task.key)
    const notShown = startingSoon.filter((key) => !shown.has(key))
    return {
      viewer: { kind: full.viewer.kind, name: full.viewer.name },
      today: full.today,
      waiting: full.waiting.map((step) => withApp(withoutEmpty(step), step)),
      // Every row is the caller's own, so it does not name them again.
      assigned: assigned.map((task) => {
        const { assignee: _assignee, ...row } = taskRow(task)
        return withApp(row, task)
      }),
      assignedTotal: full.assigned.length,
      startingSoon,
      ...(notShown.length ? { startingSoonNotShown: notShown } : {}),
      recent: full.recent.map((notification) => withApp(notificationRow(notification), notification)),
      ...(full.projects ? { projects: full.projects } : {}),
    }
  },
  inbox_list: (full: InboxListResult) => ({ ...full, items: full.items.map(notificationRow) }),
  task_create: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  task_update: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  task_change_status: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  task_move: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  task_link: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  task_unlink: (full: MutationResult<TaskSummary>) => mutation(full, taskRow),
  // With `match`, `total` counts every matching run, so the caller can tell when `runs` stopped at the limit.
  workflow_runs_list: (full: { runs: WorkflowRun[]; total?: number }) => ({
    runs: full.runs.map(runRow),
    ...(full.total !== undefined ? { total: full.total } : {}),
  }),
  workflow_start: runRow,
  workflow_step_finish: runRow,
  workflow_step_decide: runRow,
  workflow_step_restart: runRow,
  workflow_run_cancel: runRow,
  version_list: (full: { versions: Version[] }) => ({ versions: full.versions.map(versionRow) }),
  version_create: (full: MutationResult<Version>) => mutation(full, versionRow),
  version_update: (full: MutationResult<Version>) => mutation(full, versionRow),
  version_release: (full: MutationResult<VersionReleaseResult>) =>
    mutation(full, (released) => ({
      version: versionRow(released.version),
      ...(released.moved.keys.length ? { moved: released.moved } : {}),
      notes: released.notes,
    })),
}

function detailOf(params: Record<string, unknown>): Detail {
  const detail = params.detail ?? 'compact'
  if (detail !== 'compact' && detail !== 'full') {
    throw new Error('"detail" must be "compact" (the default) or "full"')
  }
  return detail
}

/** The actions, with `detail` taken off the parameters of those that have it and applied to what they return. */
export function withDetail(actions: Record<string, AppActionHandler>): Record<string, AppActionHandler> {
  const compacting = new Set<string>(DETAIL_ACTIONS)
  return Object.fromEntries(
    Object.entries(actions).map(([id, handler]) => {
      if (!compacting.has(id)) {
        return [id, handler]
      }
      const compact = COMPACT[id as DetailAction]
      return [
        id,
        async (ctx: AppActionContext, params: Record<string, unknown>) => {
          // Checked before the handler runs, so a bad value never follows a write.
          const detail = detailOf(params ?? {})
          const { detail: _detail, ...rest } = params ?? {}
          const full = await handler(ctx, rest)
          return detail === 'full' ? full : compact(full, rest)
        },
      ]
    }),
  )
}
