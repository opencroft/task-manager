import { Ban, Check, ListChecks, Workflow } from 'lucide-react'
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskAssignee, type TaskAssigneeValue } from './task-assignee'
import { TaskLabelChip } from './task-label-chip'
import { TaskPullRequestChip, type TaskPullRequestCounts } from './task-pull-requests'
import { TaskVersionChip, type TaskVersionState } from './task-version-chip'
import { type TaskPriority, TaskPriorityIcon } from './task-priority-icon'
import { type TaskType, TaskTypeIcon } from './task-type-icon'

/**
 * The fields a card reads, named as the task list returns them, so a list row
 * can be passed in as it is.
 */
export interface BoardCardTask {
  key: string
  summary: string
  type: TaskType
  priority: TaskPriority
  assignee: TaskAssigneeValue | null
  labels?: string[]
  /** The version the task is planned into, if any. */
  version?: { name: string; state: TaskVersionState } | null
  childCount?: number
  /** Subtasks whose status is in the done category; progress shows once this is known. */
  childDoneCount?: number
  /** Only the category is read: a finished task's key is struck through. */
  status?: { category: 'todo' | 'in_progress' | 'done' }
  /** The keys of this task's blockers that are not done yet; any shows a Blocked chip. */
  openBlockers?: string[]
  /** The pull requests mentioning the task, by state; any shows a chip. */
  prs?: TaskPullRequestCounts | null
}

/**
 * `source`: the card left in its column while a copy of it is dragged.
 * `overlay`: that copy, lifted under the pointer.
 */
export type BoardCardDragState = 'idle' | 'source' | 'overlay'

export interface BoardCardProps extends Omit<ComponentProps<'div'>, 'children'> {
  task: BoardCardTask
  /** The workflow step the task is on, if a workflow runs on it. */
  workflowStep?: string | null
  /** The card is the current selection (opened in details, or picked with the keyboard). */
  selected?: boolean
  /** The card is picked for a bulk action: tinted, with a check before the summary. */
  checked?: boolean
  /**
   * Ctrl/Cmd-click (`range` false) or Shift-click (`range` true) on the card:
   * the page adds it to or takes it from the bulk selection. Without it, those
   * clicks open the card like any other.
   */
  onSelectToggle?: (range: boolean) => void
  dragState?: BoardCardDragState
  /** Opens the task; the card's press. Enter and Space open it too. */
  onOpen?: () => void
  /** A control in the top-right corner, usually the task's actions menu. Pressing it neither opens the card nor starts a drag. */
  actions?: ReactNode
  /**
   * The menu of the priority or the assignee chip, on right-click: its values,
   * to change in place. Only that menu opens, not the card's.
   */
  chipMenu?: (chip: 'priority' | 'assignee') => ItemMenuEntries
}

const MAX_LABELS = 3

const DRAG: Record<BoardCardDragState, string> = {
  idle: '',
  source: 'border-dashed opacity-40 shadow-none',
  overlay: 'rotate-2 cursor-grabbing shadow-lg ring-1 ring-foreground/10',
}

function stop(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

/**
 * One task on the board. It draws the task and reports a press; dragging,
 * the context menu and selection belong to the page, which spreads its
 * handlers onto the card and sets `dragState` and `selected`.
 */
export function BoardCard({
  task,
  workflowStep,
  selected = false,
  checked = false,
  onSelectToggle,
  dragState = 'idle',
  onOpen,
  actions,
  chipMenu,
  className,
  onClick,
  onKeyDown,
  onMouseDown,
  ...props
}: BoardCardProps) {
  const labels = task.labels ?? []
  const shown = labels.slice(0, MAX_LABELS)
  const hidden = labels.length - shown.length
  const total = task.childCount ?? 0
  const done = task.childDoneCount
  const finished = task.status?.category === 'done'
  const blockers = task.openBlockers ?? []
  const blockedBy = blockers.length > 0 ? `Blocked by ${blockers.join(', ')}` : null
  const hasPrs = Boolean(task.prs && task.prs.open + task.prs.merged + task.prs.closed > 0)

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) {
      return
    }
    if (onSelectToggle && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      onSelectToggle(event.shiftKey)
      return
    }
    onOpen?.()
  }

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    onMouseDown?.(event)
    // A shift-click picks a range; it should not also select the text between.
    if (onSelectToggle && event.shiftKey) {
      event.preventDefault()
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.target !== event.currentTarget) {
      return
    }
    if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <div
      data-slot='board-card'
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      data-drag-state={dragState === 'idle' ? undefined : dragState}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={`${task.key} ${task.summary}${blockedBy ? `, ${blockedBy.toLowerCase()}` : ''}${checked ? ', picked' : ''}`}
      aria-current={selected || undefined}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/card relative flex w-full min-w-0 flex-col gap-2.5 rounded-lg border bg-card p-3 text-left text-card-foreground shadow-xs outline-none transition-[border-color,box-shadow,opacity] select-none [-webkit-touch-callout:none]',
        onOpen && 'cursor-pointer hover:border-foreground/20',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        checked && 'border-primary/60 bg-primary/5 hover:border-primary/80',
        selected && 'border-primary ring-2 ring-primary/25 hover:border-primary',
        DRAG[dragState],
        className,
      )}
      {...props}
    >
      <div className='flex min-w-0 items-start gap-2'>
        {checked ? (
          <span
            aria-hidden='true'
            className='mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground'
          >
            <Check className='size-3' strokeWidth={3} />
          </span>
        ) : null}
        <p className='line-clamp-3 min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]' title={task.summary}>
          {task.summary}
        </p>
        {actions ? (
          <div
            role='presentation'
            className='-mt-1.5 -mr-1.5 shrink-0'
            onClick={stop}
            onKeyDown={stop}
            onPointerDown={stop}
          >
            {actions}
          </div>
        ) : null}
      </div>

      {shown.length > 0 || workflowStep || blockedBy || task.version || hasPrs ? (
        <div className='flex min-w-0 flex-wrap items-center gap-1'>
          {blockedBy ? (
            <span
              data-slot='board-card-blocked'
              className='inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-red-500/10 px-1.5 text-[11px] font-medium text-red-700 dark:text-red-300'
              title={blockedBy}
            >
              <Ban aria-hidden='true' className='size-3 shrink-0' />
              Blocked
              {blockers.length > 1 ? <span className='tabular-nums opacity-80'>{blockers.length}</span> : null}
            </span>
          ) : null}
          {workflowStep ? (
            <span className='inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 text-[11px] font-medium text-primary' title={`Workflow step: ${workflowStep}`}>
              <Workflow aria-hidden='true' className='size-3 shrink-0' />
              <span className='truncate'>{workflowStep}</span>
            </span>
          ) : null}
          <TaskPullRequestChip counts={task.prs} />
          {task.version ? <TaskVersionChip name={task.version.name} state={task.version.state} className='max-w-32' /> : null}
          {/* Each label's colour comes from the TaskLabelColorsProvider above the board, if any. */}
          {shown.map((label) => (
            <TaskLabelChip key={label} name={label} className='max-w-32' />
          ))}
          {hidden > 0 ? (
            <span className='inline-flex h-5 items-center rounded-md px-1 text-[11px] text-muted-foreground' title={labels.slice(MAX_LABELS).join(', ')}>
              +{hidden}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className='flex min-w-0 items-center gap-2 text-xs text-muted-foreground'>
        <TaskTypeIcon type={task.type} />
        <span className={cn('min-w-0 truncate font-mono font-medium', finished && 'line-through')}>{task.key}</span>
        {total > 0 ? (
          <span
            className={cn('inline-flex shrink-0 items-center gap-1 tabular-nums', done !== undefined && done >= total && 'text-emerald-600 dark:text-emerald-400')}
            title={done === undefined ? `${total} subtasks` : `${done} of ${total} subtasks done`}
          >
            <ListChecks aria-hidden='true' className='size-3.5' />
            {done === undefined ? total : `${done}/${total}`}
          </span>
        ) : null}
        <span className='ml-auto flex shrink-0 items-center gap-1.5'>
          <ItemContextMenu entries={chipMenu?.('priority') ?? []} render={<span />} className='inline-flex'>
            <TaskPriorityIcon priority={task.priority} />
          </ItemContextMenu>
          <ItemContextMenu entries={chipMenu?.('assignee') ?? []} render={<span />} className='inline-flex'>
            <TaskAssignee assignee={task.assignee} size='sm' />
          </ItemContextMenu>
        </span>
      </div>
    </div>
  )
}
