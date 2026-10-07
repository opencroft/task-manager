// The task manager's pages, in sidebar order.

import { Columns3, GanttChart, ListTodo, UserRound, Workflow } from 'lucide-react'
import type { ComponentType } from 'react'

import { BoardPage } from '../pages/board-page'
import { MyWorkPage } from '../pages/my-work-page'
import { TasksPage } from '../pages/tasks-page'
import { TimelinePage } from '../pages/timeline-page'
import { WorkflowsPage } from '../workflows/workflows-page'

export interface TasksRoute {
  /** The page's path segment under the App's address: `/<id>`. */
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** Rendered inside the project context (`useProject`). */
  component: ComponentType
  /** The page fills the pane and scrolls inside itself (its lanes, its scale) rather than growing the pane. */
  fills?: boolean
}

export const routes: TasksRoute[] = [
  { id: 'my-work', label: 'My work', icon: UserRound, component: MyWorkPage },
  // The table scrolls its rows between its heads and the create row, so those stay in view.
  { id: 'tasks', label: 'Tasks', icon: ListTodo, component: TasksPage, fills: true },
  { id: 'board', label: 'Board', icon: Columns3, component: BoardPage, fills: true },
  { id: 'timeline', label: 'Timeline', icon: GanttChart, component: TimelinePage, fills: true },
  { id: 'workflows', label: 'Workflows', icon: Workflow, component: WorkflowsPage },
]

/** The page an empty hash opens: what needs the person now. */
export const DEFAULT_ROUTE = 'my-work'
