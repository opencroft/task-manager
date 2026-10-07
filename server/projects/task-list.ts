// `task_list` across projects: which filters it takes, and how the projects'
// pages merge into one. Pure, like ./across.ts.

import { ACROSS_LIST_DEFAULT, ACROSS_LIST_MAX, type ProjectRef } from '../../shared/projects.ts'
import type { TaskListInput, TaskListResult, TaskSummary } from '../../shared/types.ts'
import { readTaskKeyQuery } from '../../src/components/ui/navigation/task-key-query.ts'
import { TaskError } from '../service.ts'
import { tagged } from './across.ts'

/** Filters that name something of one project: a status, a version, a parent task, a board, an order or a page of its own. */
const PROJECT_SPECIFIC = ['status', 'version', 'parent', 'board', 'sort', 'offset'] as const

/** What each project is asked, and how many rows the merged answer keeps. */
export function acrossListInput(input: TaskListInput): { perProject: TaskListInput; limit: number } {
  const given = PROJECT_SPECIFIC.filter((name) => input[name] !== undefined && input[name] !== null)
  if (given.length > 0) {
    throw new TaskError(
      `With scope "all", ${given.map((name) => `"${name}"`).join(', ')} cannot be used: ${given.length === 1 ? 'it names' : 'they name'} something of one project. ` +
        "Filter by statusCategory instead of status, or call that project's task_list.",
    )
  }
  const requested = Math.trunc(Number(input.limit ?? ACROSS_LIST_DEFAULT))
  if (!Number.isFinite(requested) || requested < 1 || requested > ACROSS_LIST_MAX) {
    throw new TaskError(`limit is 1–${ACROSS_LIST_MAX} with scope "all"`)
  }
  const { scope: _scope, ...perProject } = input
  // Each project answers up to the whole page, so the merge can take the best rows from any of them.
  return { perProject: { ...perProject, limit: requested }, limit: requested }
}

/**
 * The projects' pages as one: a task whose key is the query first, then the
 * most recently changed. `total` counts every match in every project read.
 */
export function mergeTaskLists(
  query: string | undefined,
  limit: number,
  parts: Array<{ project: ProjectRef; value: TaskListResult }>,
): TaskListResult {
  const named = readTaskKeyQuery(query ?? '')
  const key = named?.project ? `${named.project}-${named.number}` : null
  const exact = (task: TaskSummary) => (task.key === key ? 0 : 1)
  const tasks = tagged(parts.map(({ project, value }) => ({ project, value: value.tasks })))
    .sort((a, b) => exact(a) - exact(b) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
  return { tasks, total: parts.reduce((sum, { value }) => sum + value.total, 0) }
}
