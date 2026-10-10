// Saved views: a named slice of the project (filters and sort, on the board
// the grouping, on the tasks page the table's columns) that a person or an
// agent comes back to. The actions' shapes, shared by the server seam
// (server/views) and the UI.

import type { ActionInputs } from './action-inputs.ts'
import type { FieldFilter } from './filters.ts'
import type { Priority, StatusRef, TaskKey, TaskListInput, TaskSort, TaskType } from './types.ts'

/** The pages a view belongs to. */
export const VIEW_PAGES = ['tasks', 'board'] as const
export type ViewPage = (typeof VIEW_PAGES)[number]

/** The tasks page's table columns a view can show. */
export const TASK_COLUMNS = [
  'type',
  'key',
  'summary',
  'priority',
  'status',
  'assignee',
  'reporter',
  'parent',
  'labels',
  'version',
  'dates',
  'created',
  'updated',
] as const
export type TaskColumn = (typeof TASK_COLUMNS)[number]

/** The columns, in order, of a tasks view that names none. */
export const DEFAULT_TASK_COLUMNS: readonly TaskColumn[] = [
  'type',
  'key',
  'summary',
  'priority',
  'status',
  'assignee',
  'reporter',
  'created',
  'updated',
]

/** Columns every tasks view shows: a row has to say which task it is. */
export const REQUIRED_TASK_COLUMNS: readonly TaskColumn[] = ['key', 'summary']

/**
 * What a view restores. The same fields `task_list` takes, so a view's filter
 * can be passed to it as it is. A saved one holds each list-valued field as
 * its non-empty lists only, and leaves out a field that filters nothing.
 */
export interface ViewFilter {
  query?: string
  status?: FieldFilter<StatusRef>
  assignee?: FieldFilter<string>
  type?: FieldFilter<TaskType>
  priority?: FieldFilter<Priority>
  label?: FieldFilter<string>
  /** Version names; `'none'` matches tasks in no version. */
  version?: FieldFilter<string>
  /** Parent task keys; `'none'` matches top-level tasks. */
  parent?: FieldFilter<TaskKey | 'none'>
  sort?: TaskSort
}

/** A filter as `view_save` takes it: the same fields, each list-valued one also as a plain list of values to include. */
export type ViewFilterInput = Pick<TaskListInput, keyof ViewFilter>

/** How the board groups its cards: one swimlane per assignee, or none. */
export type ViewGrouping = 'assignee' | null

export interface SavedView {
  id: string
  name: string
  page: ViewPage
  filter: ViewFilter
  /** The board's grouping; always null on the tasks page. */
  group: ViewGrouping
  /** The tasks page's table columns, in order (the default set when the view names none); always null on the board. */
  columns: TaskColumn[] | null
  /** Shared with everyone in the project; otherwise only its owner sees it. */
  shared: boolean
  /** Who saved it. */
  owner: string
  /** The caller's default view for its page. */
  isDefault: boolean
  /** Whether the caller may change it: only its owner may. */
  editable: boolean
}

export interface ViewSaveInput {
  /** Pass to change a view you own; omit to save a new one. */
  id?: string
  /** Required for a new view. */
  name?: string
  /** Required for a new view; a view never changes page. */
  page?: ViewPage
  filter?: ViewFilterInput
  group?: ViewGrouping
  /** Tasks views only: the table's columns, in order; null goes back to the default set. */
  columns?: TaskColumn[] | null
  shared?: boolean
}

export interface ViewActionMap {
  view_list: { input: ActionInputs['view_list']; output: SavedView[] }
  view_save: { input: ViewSaveInput; output: SavedView }
  view_delete: { input: ActionInputs['view_delete']; output: { deleted: string } }
  /** `view` null clears the page's default. */
  view_set_default: { input: ActionInputs['view_set_default']; output: SavedView | null }
}

export type ViewActionId = keyof ViewActionMap
