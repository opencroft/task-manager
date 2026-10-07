// Live refresh. The server broadcasts `tasks.changed` after
// every mutation, whoever made it — this tab, another tab, an agent. A page
// subscribes and refetches what it shows; calls are debounced so a burst of
// changes (a status deletion moving twenty tasks) costs one refetch.

import { legacy } from '@opencroft/client'
import { useEffect, useRef } from 'react'

import { TASKS_EVENT, type TasksEvent } from '../../shared/types'

interface EventChunk {
  name?: string
  payload?: Record<string, unknown>
}

interface EventStream {
  subscribe(fn: (chunk: EventChunk) => void): () => void
}

/**
 * Call `onChange` with the changes to this instance — to any project's with
 * `instanceId` null — debounced by `delayMs`. Receives every event of the
 * burst, so a page can check whether a key it shows was among them.
 */
export function useTasksLive(instanceId: string | null, onChange: (events: TasksEvent[]) => void, delayMs = 150): void {
  const callback = useRef(onChange)
  callback.current = onChange

  useEffect(() => {
    const stream = legacy.getStream(legacy.extensionId, 'events') as unknown as EventStream
    let pending: TasksEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = stream.subscribe((chunk) => {
      if (chunk?.name !== TASKS_EVENT) {
        return
      }
      const event = chunk.payload as unknown as TasksEvent
      if (!event || (instanceId !== null && event.instanceId !== instanceId)) {
        return
      }
      pending.push(event)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const events = pending
        pending = []
        callback.current(events)
      }, delayMs)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [instanceId, delayMs])
}
