// Live refresh: every mutation broadcasts one event to all
// connected clients, which refetch what they show. Clients subscribe with
// `useTasksLive` (src/lib/live.ts).

import host from '@opencroft/server'

import { TASKS_EVENT, type TaskKey, type TasksEvent } from '../shared/types.ts'

export function broadcastTasksChanged(instanceId: string, keys: TaskKey[], kind: TasksEvent['kind']): void {
  const payload: TasksEvent = { instanceId, keys, kind }
  try {
    host.events.broadcast(TASKS_EVENT, payload as unknown as Record<string, unknown>)
  } catch (error) {
    // A missed refresh is not worth failing the write that caused it.
    console.error('[task-pipelines] live broadcast failed', error)
  }
}
