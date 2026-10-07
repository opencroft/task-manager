import { ChevronRight } from 'lucide-react'
import type { PointerEvent } from 'react'

import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskContextMenu, type TaskMenuProps } from '@/components/ui/tasks/task-menu'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { cn } from '@/lib/utils'

import { type DropZone, isScheduled, type TimelineTask } from './timeline-model'
import { formatRange } from './timeline-scale'

const INDENT_PX = 16

export interface TaskTreeRowProps {
  task: TimelineTask
  depth: number
  hasChildren: boolean
  expanded: boolean
  selected?: boolean
  /** Where a task dragged over this row would land, drawn as a line or a highlight. */
  dropZone?: DropZone | null
  /** True while this row is the one being dragged. */
  dragging?: boolean
  menu: TaskMenuProps
  /** Starts a drag of this row; the surrounding timeline runs it. */
  onDragStart?: (event: PointerEvent<HTMLElement>) => void
  onToggle: () => void
  onSelect: () => void
  onOpen: () => void
}

/**
 * One task in the tree: expand toggle, key, summary, status and assignee. Its
 * accessible name also carries the task's dates, since the bars on the scale
 * are hidden from assistive tech.
 * Drag it onto another row to reorder (top or bottom edge) or to nest it
 * (middle); right-click for its menu; double-click or Enter opens it. The row
 * is a drop target, marked `data-drop="row"` with its key.
 */
export function TaskTreeRow({
  task,
  depth,
  hasChildren,
  expanded,
  selected,
  dropZone,
  dragging,
  menu,
  onDragStart,
  onToggle,
  onSelect,
  onOpen,
}: TaskTreeRowProps) {
  return (
    <TaskContextMenu
      {...menu}
      render={
        <div
          data-drop='row'
          data-key={task.key}
          onPointerDown={onDragStart}
          role='treeitem'
          aria-level={depth + 1}
          aria-expanded={hasChildren || expanded ? expanded : undefined}
          aria-selected={selected}
          onClick={onSelect}
          onDoubleClick={onOpen}
          style={{ paddingLeft: 8 + depth * INDENT_PX }}
        />
      }
      className={cn(
        'relative flex h-8 cursor-default items-center gap-2 pr-2 text-sm outline-none select-none',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
        dragging && 'opacity-50',
        dropZone === 'inside' && 'bg-primary/10 ring-1 ring-primary/50 ring-inset',
      )}
    >
      {dropZone === 'before' && <span className='absolute inset-x-0 top-0 h-0.5 bg-primary' />}
      {dropZone === 'after' && <span className='absolute inset-x-0 bottom-0 h-0.5 bg-primary' />}
      <button
        type='button'
        tabIndex={-1}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground',
          !hasChildren && !expanded && 'invisible',
        )}
      >
        <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
      </button>
      <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
      <span className='min-w-0 flex-1 truncate'>{task.summary}</span>
      <span className='sr-only'>{isScheduled(task) ? `, ${formatRange(task.startDate, task.endDate)},` : ', unscheduled,'}</span>
      <TaskStatusBadge name={task.status.name} category={task.status.category} color={task.status.color} size='sm' className='max-w-28' />
      <TaskAssignee assignee={task.assignee} size='sm' />
    </TaskContextMenu>
  )
}
