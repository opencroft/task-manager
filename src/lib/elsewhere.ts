// Searching the other projects for what was typed: the palette's "Other
// projects" and the Tasks page's "In other projects". Asked only while there
// is typed text, after a pause — never on idle — through `task_list` with
// `scope: "all"`, one request for every project the person can see.

import { useEffect, useState } from 'react'

import type { ProjectRef } from '../../shared/projects'
import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { isElsewhere } from '../app/task-opener'

type ElsewhereTask = TaskSummary & { project: ProjectRef }

const elsewhereOnly = (task: TaskSummary): task is ElsewhereTask => isElsewhere(task.project)

/** Shorter text matches too much to be worth asking every project. */
const MIN_QUERY = 2
const PAUSE_MS = 250
const LIMIT = 20

export interface ElsewhereSearch {
  /** Other projects' matches, each with its `project`. */
  tasks: ElsewhereTask[]
  searching: boolean
}

const IDLE: ElsewhereSearch = { tasks: [], searching: false }

/** Other projects' tasks matching `query`, while `active`. A failed search is reported like any failed call, and lists nothing. */
export function useElsewhereSearch(query: string, active: boolean): ElsewhereSearch {
  const { api, fail } = useProject()
  const [state, setState] = useState<ElsewhereSearch>(IDLE)
  const text = query.trim()
  const asking = active && text.length >= MIN_QUERY

  useEffect(() => {
    if (!asking) {
      setState(IDLE)
      return
    }
    let current = true
    setState((previous) => ({ ...previous, searching: true }))
    const timer = setTimeout(() => {
      api
        .task_list({ scope: 'all', query: text, limit: LIMIT })
        .then((result) => {
          if (current) {
            setState({ tasks: result.tasks.filter(elsewhereOnly), searching: false })
          }
        })
        .catch((failure) => {
          if (current) {
            setState(IDLE)
            fail(failure)
          }
        })
    }, PAUSE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [api, fail, asking, text])

  return state
}
