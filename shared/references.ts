// Task keys written in markdown anywhere in the product -- a chat message, a
// documentation page, another extension's text -- recognised and drawn as the
// task they name. The client's markdown resolver asks the two extension-level
// actions below; they read every task-manager App, so no App has to be open.

import type { StatusCategory, TaskKey, TaskType } from './types.ts'

/** A project whose keys are recognised: its key and the App it lives in. */
export interface ReferenceProject {
  key: string
  /** `<space>.<app>`. */
  app: string
  /** What a `tasks.changed` event names the App by. */
  instanceId: string
}

/** What a task key's chip shows. */
export interface TaskReference {
  key: TaskKey
  summary: string
  type: TaskType
  /** As the task manager draws it: `color` is the project's own, when it chose one. */
  status: { name: string; category: StatusCategory; color: string | null }
  /** `<space>.<app>` of the App the task is in. */
  app: string
}

export const REFERENCE_ACTIONS = {
  /** Every project the caller can see: `() => ReferenceProject[]`. */
  projects: 'taskReferenceProjects',
  /** The tasks behind the keys: `(keys: TaskKey[]) => Record<TaskKey, TaskReference | null>`. */
  resolve: 'resolveTaskReferences',
} as const

/** The most keys one resolve answers; the client never batches more than this. */
export const REFERENCE_RESOLVE_MAX = 500

/** The project key of a task key, or null when it is not one. */
export function projectOfKey(key: string): { project: string; number: number } | null {
  const match = /^([A-Z][A-Z0-9]{1,9})-([1-9]\d*)$/.exec(key)
  return match ? { project: match[1], number: Number(match[2]) } : null
}

/** One pattern for every listed project's keys, or null when there are none. */
export function taskKeyPattern(projects: ReferenceProject[]): string | null {
  const keys = [...new Set(projects.map((project) => project.key))].filter(Boolean).sort((a, b) => b.length - a.length)
  return keys.length ? `\\b(?:${keys.join('|')})-[1-9]\\d*\\b` : null
}
