// "My work": what needs the caller now, in four sections. The action's shapes,
// shared by the server seam (server/my-work) and the UI; the kit's
// `my-work-view` renders the sections as they are.

import type { ActionInputs } from './action-inputs.ts'
import type { TaskNotification } from './inbox.ts'
import type { ProjectRef, ProjectsRead } from './projects.ts'
import type { CalendarDate, TaskKey, TaskSummary, TaskType } from './types.ts'

/** How many days "Starting soon" looks ahead, today included. */
export const STARTING_SOON_DAYS = 7

/** A workflow step that needs the caller: its session is theirs and open, it waits on them, or it needs attention. */
export interface MyWorkStep {
  /** `<run id>:<step id>`. */
  id: string
  /**
   * `open`: an agent's session for the step is open (the caller is that agent).
   * `waiting`: the step waits on the caller, a person assigned to the task.
   * `attention`: the step cannot proceed; the caller started the run or reported the task.
   */
  state: 'open' | 'waiting' | 'attention'
  task: { key: TaskKey; summary: string; type?: TaskType }
  workflow: string
  step: string
  /** When the step was entered (ISO 8601). */
  since: string
  /** Why it cannot proceed, as the engine recorded it. */
  reason?: string | null
  /** The host's page for the step's session, when it has one. */
  sessionHref?: string | null
  /** The App the task is in; only across projects. */
  project?: ProjectRef
}

/** A recent change, with the App its task is in across projects. */
export type MyWorkNotification = TaskNotification & { project?: ProjectRef }

export interface MyWorkResult {
  /** Whose work this is: the calling agent, or the signed-in person. */
  viewer: { kind: 'agent' | 'person'; id?: string; name: string }
  /** The day Starting soon was counted from. */
  today: CalendarDate
  /** Oldest first. */
  waiting: MyWorkStep[]
  /** Assigned to the caller and not done; the earliest end date first, undated last. */
  assigned: TaskSummary[]
  /** Assigned to the caller, not done, and starting within `STARTING_SOON_DAYS` from today; the soonest first. */
  startingSoon: TaskSummary[]
  /** The caller's inbox, newest first. */
  recent: MyWorkNotification[]
  /** Only across projects. */
  projects?: ProjectsRead
}

export interface MyWorkActionMap {
  my_work: { input: ActionInputs['my_work']; output: MyWorkResult }
}

export type MyWorkActionId = keyof MyWorkActionMap
