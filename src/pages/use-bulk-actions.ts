// Bulk actions for a page that picks tasks (Tasks and Board). Each change is
// the ordinary action once per picked task, a few at a time, so workflows and
// history see it exactly as a single edit; the bar reports how many went
// through and why the rest did not, and retries only those.

import { useCallback, useMemo, useRef, useState } from 'react'

import type {
  TaskBulkBarAction,
  TaskBulkBarAssignee,
  TaskBulkBarProps,
  TaskBulkBarResult,
  TaskBulkBarStatus,
} from '@/components/ui/tasks/task-bulk-bar'
import type { TaskPriority } from '@/components/ui/tasks/task-priority-icon'
import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { assigneeInput } from '../lib/assignees'
import { toTaskVersion } from '../lib/versions'

/** Calls in flight at once: enough to be quick, few enough not to crowd the server. */
const CONCURRENCY = 4

interface LastRun {
  action: TaskBulkBarAction
  apply: (task: TaskSummary) => Promise<unknown>
}

/**
 * The bulk bar's props for `selection` (keys) among `tasks`. `setSelection`
 * lets the bar clear it, and drops what a delete removed.
 */
export function useBulkActions(
  tasks: TaskSummary[],
  selection: string[],
  setSelection: (keys: string[]) => void,
): TaskBulkBarProps {
  const { api, statuses, assignees, labels, versions } = useProject()
  const kitVersions = useMemo(() => versions.map(toTaskVersion), [versions])
  const [busy, setBusy] = useState<TaskBulkBarAction | null>(null)
  const [result, setResult] = useState<TaskBulkBarResult | null>(null)
  const last = useRef<LastRun | null>(null)

  const byKey = useMemo(() => new Map(tasks.map((task) => [task.key, task])), [tasks])
  const picked = useMemo(() => selection.flatMap((key) => byKey.get(key) ?? []), [selection, byKey])

  const run = useCallback(
    async (action: TaskBulkBarAction, targets: TaskSummary[], apply: (task: TaskSummary) => Promise<unknown>) => {
      last.current = { action, apply }
      setBusy(action)
      setResult(null)
      const failures: TaskBulkBarResult['failures'] = []
      const queue = [...targets]
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let task = queue.shift(); task; task = queue.shift()) {
            try {
              await apply(task)
            } catch (error) {
              failures.push({ key: task.key, message: errorMessage(error) })
            }
          }
        }),
      )
      setBusy(null)
      setResult({ action, done: targets.length - failures.length, total: targets.length, failures })
      if (action === 'delete') {
        const failed = new Set(failures.map((failure) => failure.key))
        setSelection(selection.filter((key) => !targets.some((task) => task.key === key) || failed.has(key)))
      }
    },
    [selection, setSelection],
  )

  const labelCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const task of picked) {
      for (const label of task.labels) {
        counts[label] = (counts[label] ?? 0) + 1
      }
    }
    return counts
  }, [picked])

  // Parents on offer: tasks that already have subtasks, and epics; the picked ones cannot take themselves.
  const parents = useMemo(() => {
    const chosen = new Set(selection)
    return tasks
      .filter((task) => !chosen.has(task.key) && (task.childCount > 0 || task.type === 'epic'))
      .map((task) => ({ key: task.key, summary: task.summary }))
  }, [tasks, selection])

  return {
    selected: picked.map((task) => ({ key: task.key, summary: task.summary })),
    onClear: () => {
      setSelection([])
      setResult(null)
    },
    statuses,
    onChangeStatus: (status: TaskBulkBarStatus) =>
      void run('status', picked, (task) => api.task_change_status({ key: task.key, status: Number(status.id) })),
    assignees: assignees.map((option) => ({
      kind: option.assignee.kind,
      id: option.assignee.id,
      name: option.assignee.name,
    })),
    onChangeAssignee: (assignee: TaskBulkBarAssignee | null) =>
      void run('assignee', picked, (task) => api.task_update({ key: task.key, assignee: assigneeInput(assignee) })),
    onChangePriority: (priority: TaskPriority) =>
      void run('priority', picked, (task) => api.task_update({ key: task.key, priority })),
    labels,
    labelCounts,
    // A label change replaces a task's labels, so only the tasks it changes are touched.
    onAddLabel: (label: string) =>
      void run(
        'labels',
        picked.filter((task) => !task.labels.includes(label)),
        (task) => api.task_update({ key: task.key, labels: [...task.labels, label] }),
      ),
    onRemoveLabel: (label: string) =>
      void run(
        'labels',
        picked.filter((task) => task.labels.includes(label)),
        (task) => api.task_update({ key: task.key, labels: task.labels.filter((other) => other !== label) }),
      ),
    versions: kitVersions,
    // Only the tasks not already in that version are touched.
    onSetVersion: (id: string | null) => {
      const name = id === null ? null : (kitVersions.find((version) => version.id === id)?.name ?? null)
      void run(
        'version',
        picked.filter((task) => (task.version?.name ?? null) !== name),
        (task) => api.task_update({ key: task.key, version: id === null ? null : Number(id) }),
      )
    },
    parents,
    onSetParent: (key: string | null) =>
      void run('parent', picked, (task) => api.task_move({ key: task.key, parent: key })),
    // A task with subtasks is refused rather than taking them along: the confirm lists only what was picked.
    onDelete: () => void run('delete', picked, (task) => api.task_delete({ key: task.key })),
    busy,
    result,
    onRetryFailed: () => {
      const previous = last.current
      if (previous && result) {
        const failed = new Set(result.failures.map((failure) => failure.key))
        void run(
          previous.action,
          picked.filter((task) => failed.has(task.key)),
          previous.apply,
        )
      }
    },
    onDismissResult: () => setResult(null),
  }
}
