// Boards: a project's named boards, each an arrangement of its statuses into
// columns (left to right) and, inside a column, into sections (top to
// bottom), with a preset filter. Nothing makes a board by itself; a project
// has the boards someone set up. The actions' shapes, shared by the server
// seam (server/boards) and the UI.

import type { ActionInputs } from './action-inputs.ts'
import type { Status, StatusRef } from './types.ts'
import type { ViewFilter, ViewFilterInput } from './views.ts'
import type { WorkflowDef } from './workflows.ts'

/**
 * A board's preset filter: a saved view's filter without `status`, which the
 * columns decide, and without `sort`, since the board keeps its own order.
 */
export type BoardFilter = Omit<ViewFilter, 'status' | 'sort'>

/** A preset filter as `board_save` takes it: each list-valued field also as a plain list of values to include. */
export type BoardFilterInput = Omit<ViewFilterInput, 'status' | 'sort'>

export const BOARD_FILTER_KEYS = [
  'query',
  'assignee',
  'type',
  'priority',
  'label',
  'version',
  'parent',
] as const satisfies ReadonlyArray<keyof BoardFilter>

/** A status on a board, by id and its current name. */
export interface BoardStatus {
  id: number
  name: string
}

export interface BoardColumn {
  /** Its own name; null when it is named after its first status. */
  name: string | null
  /** Its statuses, top to bottom: one section each. */
  statuses: BoardStatus[]
}

export interface Board {
  id: string
  name: string
  /** Left to right. */
  columns: BoardColumn[]
  filter: BoardFilter
  createdAt: string
  updatedAt: string
}

/** How a board serves one workflow: the statuses its steps start on or finish into that the board leaves out. */
export interface BoardWorkflowFit {
  workflowId: string
  workflow: string
  /** Empty when the board satisfies the workflow. */
  missing: BoardStatus[]
}

/** `board_get`'s answer: the board and how it serves each of the project's workflows. */
export interface BoardDetail extends Board {
  workflowFit: BoardWorkflowFit[]
}

/** A type rather than an interface, so it is assignable to the `Record<string, unknown>` of `board_save`'s generated input. */
export type BoardColumnInput = {
  /** Omitted, null or blank: named after its first status. */
  name?: string | null
  /** Status names or ids, top to bottom. A status sits in at most one column of a board. */
  statuses: StatusRef[]
}

export interface BoardSaveInput {
  /** Pass to change a board; omit to create one. */
  id?: string
  /** Required for a new board. */
  name?: string
  /** Replaces every column. */
  columns?: BoardColumnInput[]
  /** Replaces the filter; `{}` clears it. */
  filter?: BoardFilterInput
}

export interface BoardActionMap {
  board_list: { input: ActionInputs['board_list']; output: Board[] }
  board_get: { input: ActionInputs['board_get']; output: BoardDetail }
  board_save: { input: BoardSaveInput; output: Board }
  board_delete: { input: ActionInputs['board_delete']; output: { deleted: string } }
}

export type BoardActionId = keyof BoardActionMap

/** What `task_list` narrows to on a board: its statuses and its filter. */
export interface BoardRestriction {
  statusIds: number[]
  filter: BoardFilter
}

/** The name a column shows: its own, else its first status's. */
export function columnTitle(column: BoardColumn): string {
  return column.name ?? column.statuses[0]?.name ?? 'Empty column'
}

/** The ids of every status a board's columns hold. */
export function boardStatusIds(columns: ReadonlyArray<Pick<BoardColumn, 'statuses'>>): Set<number> {
  return new Set(columns.flatMap((column) => column.statuses.map((status) => status.id)))
}

/**
 * For each workflow, the statuses its steps start on (`triggerStatus`) or
 * finish into (`transitions`) that are not `onBoard`, in the order the steps
 * name them. A status the project no longer has is not counted.
 */
export function workflowFit(
  onBoard: ReadonlySet<number>,
  workflows: ReadonlyArray<Pick<WorkflowDef, 'id' | 'name' | 'steps'>>,
  statuses: ReadonlyArray<Pick<Status, 'id' | 'name'>>,
): BoardWorkflowFit[] {
  const byId = new Map(statuses.map((status) => [status.id, status]))
  return workflows.map((workflow) => {
    const used = new Set(
      workflow.steps.flatMap((step) => [step.triggerStatus, ...step.transitions.map((t) => t.status)]),
    )
    const missing = [...used]
      .filter((id) => !onBoard.has(id))
      .map((id) => byId.get(id))
      .filter((status) => status !== undefined)
      .map((status) => ({ id: status.id, name: status.name }))
    return { workflowId: workflow.id, workflow: workflow.name, missing }
  })
}
