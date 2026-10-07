// The status-change hook. `changeStatus` in service.ts is
// the only code that writes a task's status, and it runs these listeners:
//
// - `before` listeners run INSIDE the write transaction. Throwing refuses the
//   transition; the thrown message reaches the caller as the action's error.
// - `after` listeners run once the transaction has committed, awaited in
//   registration order. A throw is logged and handed back as a warning on the
//   action result; the status change itself stands.
//
// Listeners are process-wide and receive the instance they concern in the
// event, so one registration serves every project.

import type { AppActionContext } from '@opencroft/server'

import type { Actor, Assignee, Comment, Status, TaskSummary } from '../shared/types.ts'

/**
 * Who asked, and through what. Built once per action call and handed through
 * to every hook, so a listener acts with the caller's own identity.
 */
export interface Invocation {
  ctx: AppActionContext
  actor: Actor
  /**
   * The host's group-chat API bound to this invocation's caller, when the host
   * provides one. Typed by its consumer.
   */
  groupChats?: unknown
}

export interface StatusChangeEvent {
  instanceId: string
  projectKey: string
  task: TaskSummary
  from: Status
  to: Status
  actor: Actor
  inv: Invocation
}

export type StatusListener = (event: StatusChangeEvent) => void | Promise<void>

interface Registry {
  before: StatusListener[]
  after: StatusListener[]
}

// On globalThis so a hot-reloaded module does not drop listeners registered
// by a module that was not reloaded.
const globalForHooks = globalThis as unknown as { __taskPipelinesStatusHooks?: Registry }

function registry(): Registry {
  return (globalForHooks.__taskPipelinesStatusHooks ??= { before: [], after: [] })
}

/** Register status-change listeners. Each returns an unsubscribe function. */
export const statusHooks = {
  before(fn: StatusListener): () => void {
    const list = registry().before
    list.push(fn)
    return () => list.splice(list.indexOf(fn) >>> 0, 1)
  },
  after(fn: StatusListener): () => void {
    const list = registry().after
    list.push(fn)
    return () => list.splice(list.indexOf(fn) >>> 0, 1)
  },
}

/**
 * Run `before` listeners. Synchronous callers (inside a transaction) need
 * synchronous listeners: a listener that returns a promise is refused, since
 * the transaction cannot wait for it.
 */
export function runBeforeStatusChange(event: StatusChangeEvent): void {
  for (const fn of registry().before) {
    const result = fn(event)
    if (result && typeof (result as Promise<void>).then === 'function') {
      throw new Error('A before-status-change listener must be synchronous')
    }
  }
}

/** Run `after` listeners; returns the messages of those that threw. */
export async function runAfterStatusChange(event: StatusChangeEvent): Promise<string[]> {
  const warnings: string[] = []
  for (const fn of registry().after) {
    try {
      await fn(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[task-pipelines] status hook failed for ${event.task.key}:`, error)
      warnings.push(message)
    }
  }
  return warnings
}

// ─── Other task events ─────────────────────────────────────────────────────
//
// Announced by the task model after the write committed, for listeners that
// only react (the inbox). A listener cannot refuse anything and
// its failure is logged, never shown to the caller: the write stands.

interface TaskEventBase {
  instanceId: string
  projectKey: string
  task: TaskSummary
  actor: Actor
  inv: Invocation
}

export type TaskEvent =
  /** The task got a new assignee (on create, or a change to someone else). */
  | (TaskEventBase & { kind: 'assigned'; assignee: Assignee })
  /** A comment was added, on its own or with a status change. */
  | (TaskEventBase & { kind: 'commented'; comment: Comment })

export type TaskListener = (event: TaskEvent) => void | Promise<void>

const globalForTaskHooks = globalThis as unknown as { __taskPipelinesTaskHooks?: TaskListener[] }

function taskListeners(): TaskListener[] {
  return (globalForTaskHooks.__taskPipelinesTaskHooks ??= [])
}

/** Register a task-event listener. Returns an unsubscribe function. */
export function onTaskEvent(fn: TaskListener): () => void {
  const list = taskListeners()
  list.push(fn)
  return () => list.splice(list.indexOf(fn) >>> 0, 1)
}

/** Run every task-event listener in registration order; a throw is logged. */
export async function runTaskEvent(event: TaskEvent): Promise<void> {
  for (const fn of taskListeners()) {
    try {
      await fn(event)
    } catch (error) {
      console.error(`[task-pipelines] ${event.kind} listener failed for ${event.task.key}:`, error)
    }
  }
}
