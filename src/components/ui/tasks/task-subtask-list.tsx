import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { TaskAssignee, type TaskAssigneeValue } from './task-assignee'
import { type TaskMenuProps, TaskActionsMenu, TaskContextMenu } from './task-menu'
import { type TaskPriority, TaskPriorityIcon } from './task-priority-icon'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskType, TaskTypeIcon } from './task-type-icon'

export interface TaskSubtaskRow {
  key: string
  summary: string
  type: TaskType
  priority: TaskPriority
  status: { id: number; name: string; category: TaskStatusCategory; color?: string | null }
  assignee: TaskAssigneeValue | null
  childCount?: number
}

export interface TaskSubtaskListProps {
  subtasks: TaskSubtaskRow[]
  onOpen?: (key: string) => void
  menuFor?: (row: TaskSubtaskRow) => TaskMenuProps
  /** Drawn under the list, e.g. an inline create. */
  footer?: ReactNode
  className?: string
}

/**
 * A task's subtasks as compact rows with a progress line above them: how many
 * are done out of how many. Each row opens on press and carries the task menu
 * on right-click and behind its "…" button.
 */
export function TaskSubtaskList({ subtasks, onOpen, menuFor, footer, className }: TaskSubtaskListProps) {
  const done = subtasks.filter((subtask) => subtask.status.category === 'done').length
  const percent = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0
  return (
    <div data-slot="task-subtask-list" className={cn('flex flex-col gap-2', className)}>
      {subtasks.length ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 tabular-nums">
            {done} of {subtasks.length} done
          </span>
        </div>
      ) : null}
      <div className="flex flex-col overflow-hidden rounded-md border empty:hidden">
        {subtasks.map((row) => {
          const menu = menuFor?.(row)
          const content = (
            <>
              <TaskTypeIcon type={row.type} />
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{row.key}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{row.summary}</span>
              {row.childCount ? <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{row.childCount}</span> : null}
              <TaskPriorityIcon priority={row.priority} className="hidden sm:inline-flex" />
              <TaskAssignee assignee={row.assignee} size="sm" />
              <TaskStatusBadge name={row.status.name} category={row.status.category} color={row.status.color} size="sm" />
              {menu ? (
                <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <TaskActionsMenu {...menu} label={`Actions for ${row.key}`} />
                </span>
              ) : null}
            </>
          )
          const rowProps = {
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen?.(row.key),
            onKeyDown: (event: { key: string; target: EventTarget; currentTarget: EventTarget }) => {
              if (event.key === 'Enter' && event.target === event.currentTarget) {
                onOpen?.(row.key)
              }
            },
            className:
              'flex h-10 cursor-pointer items-center gap-3 border-b px-3 outline-none last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
          }
          return menu ? (
            <TaskContextMenu key={row.key} {...menu} render={<div {...rowProps} />}>
              {content}
            </TaskContextMenu>
          ) : (
            <div key={row.key} {...rowProps}>
              {content}
            </div>
          )
        })}
      </div>
      {footer}
    </div>
  )
}
