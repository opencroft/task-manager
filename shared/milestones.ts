// Milestones: the project's planning units, a development stage or a goal
// that runs over several releases. A milestone has a free name (unique in the
// project, compared case-insensitively), an optional start and target date,
// and is open or archived. A task is in at most one. Milestones and versions
// are not linked: a version is the release a task ships in, a milestone when
// it is planned to be done. The actions' shapes, shared by the server seam
// (server/milestones) and the UI.

import type { ActionInputs } from './action-inputs.ts'
import type { CalendarDate, MutationResult, TaskKey } from './types.ts'

export type MilestoneState = 'open' | 'archived'
export const MILESTONE_STATES: readonly MilestoneState[] = ['open', 'archived']

/** The longest milestone name, in characters. */
export const MILESTONE_NAME_MAX = 80

/** One milestone of the project, as `milestone_list` returns it with `detail: "full"`. */
export interface Milestone {
  id: number
  name: string
  state: MilestoneState
  /** When work in it starts; null when not set. */
  startDate: CalendarDate | null
  /** When it is meant to be done; null when not set. */
  targetDate: CalendarDate | null
  /** One line. */
  description: string
  /** Its tasks whose status is not in the done category. */
  openCount: number
  /** Its tasks whose status is in the done category. */
  doneCount: number
  createdAt: string
  updatedAt: string
}

/** A milestone as a compact row: empty fields left out, counts only when non-zero. */
export interface MilestoneRow {
  name: string
  state: MilestoneState
  startDate?: CalendarDate
  targetDate?: CalendarDate
  description?: string
  open?: number
  done?: number
}

export interface MilestoneActionMap {
  milestone_list: { input: ActionInputs['milestone_list']; output: { milestones: Milestone[] } }
  milestone_create: { input: ActionInputs['milestone_create']; output: MutationResult<Milestone> }
  milestone_update: { input: ActionInputs['milestone_update']; output: MutationResult<Milestone> }
  milestone_delete: { input: ActionInputs['milestone_delete']; output: MutationResult<MilestoneDeleted> }
}

/** What deleting a milestone did: its name, and the keys of the tasks it held, which now have no milestone. */
export interface MilestoneDeleted {
  deleted: string
  tasks: TaskKey[]
}

export type MilestoneActionId = keyof MilestoneActionMap

/**
 * The order milestones are listed in everywhere: open ones before archived
 * ones, each by target date with undated ones last, then by name.
 */
export function compareMilestones(
  a: Pick<Milestone, 'name' | 'state' | 'targetDate'>,
  b: Pick<Milestone, 'name' | 'state' | 'targetDate'>,
): number {
  if (a.state !== b.state) {
    return a.state === 'open' ? -1 : 1
  }
  if (a.targetDate !== b.targetDate) {
    if (a.targetDate === null || b.targetDate === null) {
      return a.targetDate === null ? 1 : -1
    }
    return a.targetDate < b.targetDate ? -1 : 1
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}
