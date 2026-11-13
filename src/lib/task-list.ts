// Reading a project's task list whole: every page of a query, and a refresh
// that keeps the tasks that did not change. Free of the host, so it runs in
// unit tests as it runs in the page.

import { TASK_LIST_MAX_LIMIT, type TaskListInput, type TaskSummary } from '../../shared/types'
import type { TasksApi } from './api'

// The total each query last answered with, per App instance's client.
const knownTotals = new WeakMap<TasksApi, Map<string, number>>()

/** The page offsets from `from` up to `to`. */
function pageOffsets(from: number, to: number): number[] {
  const offsets: number[] = []
  for (let offset = from; offset < to; offset += TASK_LIST_MAX_LIMIT) {
    offsets.push(offset)
  }
  return offsets
}

/**
 * Pages asked for in the first round of a query with no known total. A page
 * past the end answers an empty list, which costs the server one count and an
 * empty select, while a second round costs a whole page's transfer after the
 * first: so a project of up to this many pages loads in one round trip.
 */
const FIRST_ROUND_PAGES = 2

/**
 * Every task `input` matches, however many. One `task_list` call gives at most
 * a page, so all the pages the same query last had (or `FIRST_ROUND_PAGES`
 * when it has not run yet) are asked for at once, in one round trip; a second
 * round asks only for the pages past those, when there are more.
 */
export async function listAllTasks(
  api: TasksApi,
  input: Omit<TaskListInput, 'limit' | 'offset'> = {},
): Promise<TaskSummary[]> {
  const totals = knownTotals.get(api) ?? new Map<string, number>()
  knownTotals.set(api, totals)
  const query = JSON.stringify(input)
  const page = (offset: number) => api.task_list({ ...input, limit: TASK_LIST_MAX_LIMIT, offset })

  const expected = totals.get(query) ?? FIRST_ROUND_PAGES * TASK_LIST_MAX_LIMIT
  const pages = await Promise.all(pageOffsets(0, Math.max(1, expected)).map(page))
  const total = pages[0].total
  const more = await Promise.all(pageOffsets(pages.length * TASK_LIST_MAX_LIMIT, total).map(page))
  totals.set(query, total)
  return [...pages, ...more].flatMap((result) => result.tasks)
}

/**
 * `next`, with every task that is unchanged since `previous` swapped for its
 * previous object, so the memoised rows and cards showing it skip their render
 * after a refresh.
 */
export function keepUnchanged(previous: TaskSummary[] | null, next: TaskSummary[]): TaskSummary[] {
  if (!previous) {
    return next
  }
  const byKey = new Map(previous.map((task) => [task.key, task]))
  return next.map((task) => {
    const old = byKey.get(task.key)
    return old && JSON.stringify(old) === JSON.stringify(task) ? old : task
  })
}
