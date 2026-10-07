// The project's boards for the Board page and a board's setup, fetched again
// whenever a board or a status changes (a renamed status renames its section),
// here or elsewhere.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Board } from '../../shared/boards'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'

export interface BoardsState {
  /** Null until the first answer. */
  boards: Board[] | null
  /** Why the first load failed; a later failure is a toast. */
  error: string | null
  reload: () => Promise<void>
}

export function useBoards(): BoardsState {
  const { api, instanceId, fail } = useProject()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loaded = useRef(false)

  const reload = useCallback(async () => {
    try {
      setBoards(await api.board_list({}))
      setError(null)
      loaded.current = true
    } catch (failure) {
      if (loaded.current) {
        fail(failure)
      } else {
        setError(errorMessage(failure))
      }
    }
  }, [api, fail])

  useEffect(() => {
    void reload()
  }, [reload])
  useTasksLive(instanceId, (events) => {
    if (events.some((event) => event.kind === 'board' || event.kind === 'status')) {
      void reload()
    }
  })

  return { boards, error, reload }
}

/** The board this browser last showed in a project, so the bare Board page opens on it. */
export function lastBoard(instanceId: string): { get: () => string | null; set: (id: string | null) => void } {
  const key = `task-pipelines:${instanceId}:board`
  return {
    get: () => localStorage.getItem(key),
    set: (id) => (id === null ? localStorage.removeItem(key) : localStorage.setItem(key, id)),
  }
}
