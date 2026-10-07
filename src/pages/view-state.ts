// What a Tasks or Board URL shows, as a saved view stores it, and the URL for
// it. The URL is read against a base, the shown view's state or the empty
// one: whatever it leaves out (a filter, the search, the sort, the columns)
// is the base's, so a bare `?view=<id>` link shows the view, and only a
// change from it is written.

import { type FieldFilter, VIEW_FIELD_FILTER_KEYS, compactFilter, fieldFilterOf } from '../../shared/filters'
import type { Priority, TaskSort, TaskSortField, TaskType } from '../../shared/types'
import { DEFAULT_TASK_COLUMNS, type SavedView, type TaskColumn, type ViewFilter, type ViewGrouping, type ViewPage } from '../../shared/views'
import { fieldInput, selectionOfQuery, selectionParams, textOfQuery, textParam } from '../lib/filter-params'
import { columnsOfParam, columnsParam } from './task-columns'

/** What a page's URL shows, as a view stores it. */
export interface ViewState {
  filter: ViewFilter
  group: ViewGrouping
  /** The tasks table's columns; null on the board. */
  columns: TaskColumn[] | null
}

/** A sort as the URL's `sort` spells it, `<field>.<dir>`; empty for the list order. */
export function sortParam(sort: TaskSort | undefined): string {
  return sort ? `${sort.field}.${sort.dir}` : ''
}

function sortOfParam(value: string): TaskSort | undefined {
  return value ? { field: value.split('.')[0] as TaskSortField, dir: value.endsWith('.desc') ? 'desc' : 'asc' } : undefined
}

/** What a page shows with no saved view: no filters, and on Tasks the default columns. */
export function emptyState(page: ViewPage): ViewState {
  return { filter: {}, group: null, columns: page === 'tasks' ? [...DEFAULT_TASK_COLUMNS] : null }
}

export function stateOfView(view: SavedView): ViewState {
  return { filter: view.filter, group: view.group, columns: view.columns }
}

/** The view state a page's URL describes, read against `base`. */
export function viewOfQuery(query: URLSearchParams, page: ViewPage, base: ViewState = emptyState(page)): ViewState {
  const filter: ViewFilter = {}
  const q = textOfQuery(query, 'q', base.filter.query ?? '')
  if (q) {
    filter.query = q
  }
  const field = (key: (typeof VIEW_FIELD_FILTER_KEYS)[number]) => selectionOfQuery(query, key, base.filter[key])
  filter.status = fieldInput(field('status'), Number)
  filter.assignee = fieldInput(field('assignee'))
  filter.type = fieldInput<TaskType>(field('type'))
  filter.priority = fieldInput<Priority>(field('priority'))
  filter.label = fieldInput(field('label'))
  filter.version = fieldInput(field('version'))
  filter.parent = fieldInput(field('parent'))
  filter.sort = sortOfParam(textOfQuery(query, 'sort', sortParam(base.filter.sort)))
  const group = page === 'board' && query.get('group') === 'assignee' ? 'assignee' : null
  return { filter, group, columns: page === 'tasks' ? columnsOfParam(query.get('cols'), base.columns ?? DEFAULT_TASK_COLUMNS) : null }
}

/** The URL parameters that make a page show `state` when read against `base`: only what differs from it. */
export function queryOfState(state: ViewState, base: ViewState): URLSearchParams {
  const params: Record<string, string | null> = {
    q: textParam(state.filter.query ?? '', base.filter.query ?? ''),
    ...Object.assign({}, ...VIEW_FIELD_FILTER_KEYS.map((key) => selectionParams(key, state.filter[key], base.filter[key]))),
    sort: textParam(sortParam(state.filter.sort), sortParam(base.filter.sort)),
    // The board's grouping is not read against a base, so it is always written.
    group: state.group,
    cols: state.columns ? columnsParam(state.columns, base.columns ?? DEFAULT_TASK_COLUMNS) : null,
  }
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) {
      query.set(name, value)
    }
  }
  return query
}

/** The URL that shows `view`, marked as shown: its id, and nothing it already holds. */
export function queryOfView(view: SavedView): URLSearchParams {
  const query = queryOfState(stateOfView(view), stateOfView(view))
  query.set('view', view.id)
  return query
}

/** One spelling per view state, so two can be compared as strings. */
function canonical(state: ViewState): string {
  const fieldKeys: readonly string[] = VIEW_FIELD_FILTER_KEYS
  const entries = Object.entries(compactFilter(state.filter))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (!fieldKeys.includes(key)) {
        return [key, value] as const
      }
      const { include, exclude } = fieldFilterOf(value as FieldFilter<unknown>)
      return [key, [include.map(String).sort(), exclude.map(String).sort()]] as const
    })
    .sort(([a], [b]) => a.localeCompare(b))
  // Columns keep their order: it is part of what the view shows.
  return JSON.stringify([entries, state.group, state.columns])
}

/** Whether two states show the same thing: the same filters, in any order of values, grouping and columns. */
export function sameViewState(a: ViewState, b: ViewState): boolean {
  return canonical(a) === canonical(b)
}
