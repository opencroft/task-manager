import { Loader2 } from 'lucide-react'
import { type MouseEvent, useState } from 'react'

import { Button } from '../button'
import { type TaskProject, TaskProjectChip } from './task-project-chip'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskType, TaskTypeIcon } from './task-type-icon'
import { cn } from '@/lib/utils'

/** A task of another project, as a search across projects returns it. */
export interface TaskElsewhereTask {
  key: string
  summary: string
  type: TaskType
  status: { name: string; category: TaskStatusCategory; color?: string | null }
  project: TaskProject
}

export interface TaskElsewhereListProps {
  tasks: TaskElsewhereTask[]
  /** Every match elsewhere, when more were found than `tasks` holds. */
  total?: number
  /** The search of other projects is in flight. */
  searching?: boolean
  /** The address a row links to, so a new tab or copy link works on it. */
  hrefFor: (task: TaskElsewhereTask) => string
  /** A click on a row; call `event.preventDefault()` to open it in place instead of following the link. */
  onOpen?: (task: TaskElsewhereTask, event: MouseEvent<HTMLAnchorElement>) => void
  /** Rows listed before "Show all (N)", which expands the list in place. */
  limit?: number
  className?: string
}

/** Other projects' tasks that match a search, beside the project's own results. */
export function TaskElsewhereList({ tasks, total, searching = false, hrefFor, onOpen, limit = 3, className }: TaskElsewhereListProps) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? tasks : tasks.slice(0, limit)
  const count = Math.max(total ?? 0, tasks.length)
  return (
    <section aria-label='In other projects' data-slot='task-elsewhere-list' className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className='flex min-w-0 items-center gap-2 text-xs'>
        <h2 className='font-medium'>In other projects</h2>
        {count > 0 ? <span className='text-muted-foreground tabular-nums'>{count}</span> : null}
        {searching ? <Loader2 aria-label='Searching other projects' className='size-3.5 animate-spin text-muted-foreground' /> : null}
        {!searching && tasks.length === 0 ? <span className='text-muted-foreground'>No task matches there.</span> : null}
      </div>
      {shown.length > 0 ? (
        <div className='flex flex-col overflow-hidden rounded-lg border'>
          {shown.map((task) => (
            <a
              key={`${task.project.app ?? task.project.key}:${task.key}`}
              href={hrefFor(task)}
              onClick={(event) => onOpen?.(task, event)}
              className='flex h-9 min-w-0 items-center gap-2.5 border-b px-3 outline-none last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset'
            >
              <TaskTypeIcon type={task.type} />
              <span className='w-16 shrink-0 truncate font-mono text-xs text-muted-foreground'>{task.key}</span>
              <TaskProjectChip project={task.project} />
              <span className='min-w-0 flex-1 truncate text-sm'>{task.summary}</span>
              <TaskStatusBadge name={task.status.name} category={task.status.category} color={task.status.color} size='sm' className='hidden max-w-28 sm:inline-flex' />
            </a>
          ))}
        </div>
      ) : null}
      {tasks.length > limit ? (
        <Button variant='ghost' size='xs' className='self-start text-muted-foreground' aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Show fewer' : `Show all (${tasks.length})`}
        </Button>
      ) : null}
    </section>
  )
}
