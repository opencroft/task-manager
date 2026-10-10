// A task as its details show it, on its own page or in the peek: loaded by
// key, refreshed live when it, one of its subtasks or ancestors, or the
// project's statuses change, and edited field by field.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { Task, TaskSummary, TaskUpdateInput } from '../../shared/types'
import { useProject } from '../app/project'
import { useTasksLive } from '../lib/live'
import { listAllTasks } from '../lib/task-list'

export interface TaskDetailsState {
  /** Null until this key's task has loaded, and when it could not load. */
  task: Task | null
  /** Why there is no such task, as the server said it. */
  missing: string | null
  /** Why the first load failed; a later failure is a toast, and the task stays shown. */
  loadError: string | null
  load: () => Promise<void>
  /** Loads again after a failed first load, showing the loading state meanwhile. */
  retry: () => void
  /** Saves fields, shows the server's warnings, and reports a refusal before rethrowing it. */
  update: (patch: Omit<TaskUpdateInput, 'key'>) => Promise<void>
}

function withoutPrefix(message: string): string {
  return message.replace(/^(Error|TaskError):\s*/, '')
}

export function useTaskDetails(taskKey: string): TaskDetailsState {
  const { api, instanceId, fail } = useProject()
  const [task, setTask] = useState<Task | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Whether this key's task has loaded yet: a failing first load shows the error state, a later one a toast.
  const loaded = useRef(false)
  // The key shown now; answers about a key the view has moved on from are dropped.
  const shown = useRef(taskKey)
  shown.current = taskKey

  const load = useCallback(async () => {
    try {
      const next = await api.task_get({ key: taskKey })
      if (shown.current !== taskKey) {
        return
      }
      setTask(next)
      setMissing(null)
      setLoadError(null)
      loaded.current = true
    } catch (error) {
      if (shown.current !== taskKey) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (/No task/.test(message)) {
        setMissing(withoutPrefix(message))
        setTask(null)
      } else if (loaded.current) {
        fail(error)
      } else {
        setLoadError(withoutPrefix(message))
      }
    }
  }, [api, taskKey, fail])

  useEffect(() => {
    loaded.current = false
    setMissing(null)
    setLoadError(null)
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    const related = new Set([
      taskKey,
      ...(task?.subtasks.map((s) => s.key) ?? []),
      ...(task?.ancestors.map((a) => a.key) ?? []),
    ])
    if (
      events.some(
        (event) => event.kind === 'status' || event.kind === 'workflow' || event.keys.some((key) => related.has(key)),
      )
    ) {
      void load()
    }
  })

  const retry = useCallback(() => {
    setLoadError(null)
    void load()
  }, [load])

  const update = useCallback(
    async (patch: Omit<TaskUpdateInput, 'key'>) => {
      try {
        const { result, warnings } = await api.task_update({ key: taskKey, ...patch })
        setTask(result)
        for (const warning of warnings ?? []) {
          toast.warning(warning)
        }
      } catch (error) {
        fail(error)
        throw error
      }
    },
    [api, taskKey, fail],
  )

  // Until the new key's task arrives, the previous one is not shown under it.
  return { task: task?.key === taskKey ? task : null, missing, loadError, load, retry, update }
}

/**
 * The project's tasks, for the Dependencies picker, fetched once per mount:
 * task-dependencies has no "opened" callback to fetch them lazily, only
 * onSearch, which fires after the first keystroke — too late for the list a
 * picker shows before anyone types.
 */
export function useTaskCandidates(): TaskSummary[] {
  const { api } = useProject()
  const [candidates, setCandidates] = useState<TaskSummary[]>([])

  useEffect(() => {
    let live = true
    void listAllTasks(api)
      .then((result) => {
        if (live) {
          setCandidates(result)
        }
      })
      .catch(() => {
        // The Dependencies section still shows existing links without candidates; the picker
        // just offers nothing to add until a reload succeeds.
      })
    return () => {
      live = false
    }
  }, [api])

  return candidates
}
