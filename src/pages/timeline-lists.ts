// What the Timeline loads: the tasks of the milestone shown, for the tree and
// the scale, and the tasks in no milestone, for the backlog. Two queries, so a
// task is in at most one of the lists. Both are reloaded on every change to
// the project's tasks (this tab's, another tab's or an agent's), keeping the
// unchanged task objects, so their memoised rows skip their render.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Milestone } from '../../shared/milestones'
import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { keepUnchanged, listAllTasks } from '../lib/task-list'

export interface TimelineLists {
  /** The milestone the tree holds, as it was when the lists loaded; null for none. */
  milestoneId: number | null
  tree: TaskSummary[]
  backlog: TaskSummary[]
}

export interface TimelineListsState {
  /** Null until the first load for the milestone shown. */
  lists: TimelineLists | null
  /** Why the first load failed; a failed refresh keeps the lists and reports through the project's toast. */
  loadError: string | null
  reload: () => void
  /** Changes a task where it is listed, for showing a change before the server confirms it. */
  patch: (key: string, change: (task: TaskSummary) => TaskSummary) => void
}

/** Loads the lists for `milestone` (null: no tree, only the backlog) once `ready`, and keeps them fresh. */
export function useTimelineLists(milestone: Milestone | null, ready: boolean): TimelineListsState {
  const { api, instanceId, fail } = useProject()
  const [lists, setLists] = useState<TimelineLists | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestId = useRef(0)
  const loaded = useRef(false)
  const milestoneId = milestone?.id ?? null
  const milestoneName = milestone?.name ?? null

  const load = useCallback(async () => {
    if (!ready) {
      return
    }
    const id = ++requestId.current
    try {
      const [tree, backlog] = await Promise.all([
        milestoneName === null ? Promise.resolve([]) : listAllTasks(api, { milestone: [milestoneName] }),
        listAllTasks(api, { milestone: ['none'] }),
      ])
      if (id !== requestId.current) {
        return
      }
      loaded.current = true
      setLists((previous) => ({
        milestoneId,
        tree: keepUnchanged(previous?.milestoneId === milestoneId ? previous.tree : null, tree),
        backlog: keepUnchanged(previous?.backlog ?? null, backlog),
      }))
      setLoadError(null)
    } catch (error) {
      if (id !== requestId.current) {
        return
      }
      // Before the first load the page has nothing to show but the error; after it, a failed refresh keeps what is on screen.
      if (loaded.current) {
        fail(error)
      } else {
        setLoadError(errorMessage(error))
      }
    }
  }, [api, fail, ready, milestoneId, milestoneName])

  useEffect(() => {
    void load()
  }, [load])
  useTasksLive(instanceId, () => void load())

  const reload = useCallback(() => {
    setLoadError(null)
    void load()
  }, [load])

  const patch = useCallback((key: string, change: (task: TaskSummary) => TaskSummary) => {
    const apply = (list: TaskSummary[]) =>
      list.some((task) => task.key === key) ? list.map((task) => (task.key === key ? change(task) : task)) : list
    setLists((current) => current && { ...current, tree: apply(current.tree), backlog: apply(current.backlog) })
  }, [])

  return { lists, loadError, reload, patch }
}
