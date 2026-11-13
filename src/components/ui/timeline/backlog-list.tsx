import { Inbox } from 'lucide-react'
import { type KeyboardEvent, memo, type PointerEvent, type ReactNode, useEffect, useRef } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskInlineCreate } from '@/components/ui/tasks/task-inline-create'
import { TaskContextMenu, type TaskMenuProps } from '@/components/ui/tasks/task-menu'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { TaskTypeIcon } from '@/components/ui/tasks/task-type-icon'
import { useWindowedRows } from '@/components/ui/tasks/use-windowed-rows'
import { cn } from '@/lib/utils'

import { isScheduled, type TimelineTask } from './timeline-model'
import { formatRange } from './timeline-scale'

/** An item's height; every item is one line. */
const ITEM_HEIGHT = 32

export interface BacklogDropTarget {
  key: string
  zone: 'before' | 'after'
}

interface BacklogItemProps {
  task: TimelineTask
  selected: boolean
  dragging: boolean
  dropZone: 'before' | 'after' | null
  /** The one item Tab stops on; arrows move from it, and the Menu key or Shift+F10 opens its menu. */
  tabbable: boolean
  menuFor: (task: TimelineTask) => TaskMenuProps
  onDragStart?: (key: string, event: PointerEvent<HTMLElement>) => void
  onSelect: (key: string) => void
  onOpen: (key: string) => void
}

/**
 * One item. Memoised, and its callbacks take the key, so a change of selection
 * or drop target re-renders only the items it touches. Its menu is built when
 * it opens.
 */
const BacklogItem = memo(function BacklogItem({
  task,
  selected,
  dragging,
  dropZone,
  tabbable,
  menuFor,
  onDragStart,
  onSelect,
  onOpen,
}: BacklogItemProps) {
  return (
    <TaskContextMenu
      build={() => menuFor(task)}
      render={
        <li
          data-drop='backlog-item'
          data-key={task.key}
          data-task-key={task.key}
          tabIndex={tabbable ? 0 : -1}
          onPointerDown={onDragStart && ((event) => onDragStart(task.key, event))}
          aria-selected={selected}
          onClick={() => onSelect(task.key)}
          onDoubleClick={() => onOpen(task.key)}
        />
      }
      className={cn(
        'relative flex h-8 cursor-grab items-center gap-2 px-3 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
        dragging && 'opacity-50',
      )}
    >
      {dropZone === 'before' && <span className='absolute inset-x-0 top-0 h-0.5 bg-primary' />}
      {dropZone === 'after' && <span className='absolute inset-x-0 bottom-0 h-0.5 bg-primary' />}
      <TaskTypeIcon type={task.type} />
      <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
      <span className='min-w-0 flex-1 truncate'>{task.summary}</span>
      {isScheduled(task) ? (
        <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{formatRange(task.startDate, task.endDate)}</span>
      ) : null}
      <TaskStatusBadge name={task.status.name} category={task.status.category} color={task.status.color} size='sm' className='max-w-28' />
      <TaskAssignee assignee={task.assignee} size='sm' />
    </TaskContextMenu>
  )
})

export interface BacklogListProps {
  /** The tasks not on the timeline, already in backlog order. A dated one shows its dates. */
  tasks: TimelineTask[]
  /** What the backlog holds, after its title: e.g. "not in a milestone". */
  description?: string
  selectedKey?: string | null
  /** The key being dragged, if it is one of these. */
  draggingKey?: string | null
  /** True while something from elsewhere is dragged over the list: dropping it here takes it off the timeline. */
  receiving?: boolean
  /** What dropping here does, shown while `receiving`: e.g. "Drop to take out of Beta". */
  dropText?: string
  /** The item a dragged task would land next to. */
  dropTarget?: BacklogDropTarget | null
  /**
   * A task's menu, built when it opens. The items are memoised on this and the
   * other callbacks, so keep them stable (`useCallback`): a new function each
   * render re-renders every item in view.
   */
  menuFor: (task: TimelineTask) => TaskMenuProps
  /** Starts a drag of an item; the surrounding timeline runs it. */
  onDragStart?: (key: string, event: PointerEvent<HTMLElement>) => void
  onSelect: (key: string) => void
  onOpen: (key: string) => void
  /** A task typed into the list's last row; it starts in the backlog, undated, at its end. */
  onCreate: (summary: string) => Promise<unknown> | unknown
  /** Shown below the create row, centred in the pane's remaining height, while the backlog holds no task. */
  empty?: ReactNode
  className?: string
}

/**
 * The tasks not on the timeline, in backlog order, a dated one with its dates
 * as a quiet chip. Drag an item onto the timeline to put it there, or up and
 * down the list to reorder; drop a task from the timeline here to take it off.
 * The last row creates a task. The list is a drop target marked
 * `data-drop="backlog"`, and each item `data-drop="backlog-item"` with its key.
 */
export function BacklogList({
  tasks,
  description,
  selectedKey,
  draggingKey,
  receiving,
  dropText = 'Drop to take off the timeline',
  dropTarget,
  menuFor,
  onDragStart,
  onSelect,
  onOpen,
  onCreate,
  empty,
  className,
}: BacklogListProps) {
  // Only the items in view are rendered; spacers of the same height stand in for the rest.
  // The scroll area's viewport is what scrolls: the list inside it is as tall as all its items.
  const viewportRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const topSpacer = useRef<HTMLLIElement>(null)
  const windowed = useWindowedRows({ count: tasks.length, rowHeight: ITEM_HEIGHT, listRef: topSpacer, scrollerRef: viewportRef })
  const scrollToIndex = useRef(windowed.scrollToIndex)
  scrollToIndex.current = windowed.scrollToIndex
  const selectedIndex = selectedKey ? tasks.findIndex((task) => task.key === selectedKey) : -1
  useEffect(() => {
    if (selectedIndex >= 0) {
      scrollToIndex.current(selectedIndex)
    }
  }, [selectedIndex])
  const tabbableKey = selectedIndex >= 0 ? selectedKey : (tasks[0]?.key ?? null)

  // Up and Down move through the items and Enter opens one; the focus follows the selection.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = tasks.findIndex((task) => task.key === (event.target as HTMLElement).dataset.taskKey)
    if (index < 0) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onOpen(tasks[index].key)
      return
    }
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : -1
    if (next < 0 || next >= tasks.length) {
      return
    }
    event.preventDefault()
    const key = tasks[next].key
    onSelect(key)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-task-key="${key}"]`)?.focus())
  }

  return (
    <section
      data-drop='backlog'
      aria-label='Backlog'
      className={cn('flex h-full min-h-0 flex-col transition-colors', receiving && 'bg-primary/5', className)}
    >
      <header className='flex h-9 shrink-0 items-center gap-2 border-b px-3'>
        <Inbox className='size-4 text-muted-foreground' />
        <h2 className='text-sm font-semibold'>Backlog</h2>
        {description ? <span className='min-w-0 truncate text-xs text-muted-foreground'>{description}</span> : null}
        <span className='text-xs text-muted-foreground tabular-nums'>{tasks.length}</span>
        {receiving && <span className='ml-auto truncate text-xs font-normal text-primary'>{dropText}</span>}
      </header>
      {/* The list fills the pane's height, so an empty backlog's message centres in the room below the create row. */}
      <ScrollArea ref={viewportRef} className='flex-1' innerClassName='min-h-full'>
        <ul ref={listRef} onKeyDown={onKeyDown} className='flex flex-1 flex-col py-1'>
          <li ref={topSpacer} aria-hidden style={{ height: windowed.padTop }} />
          {tasks.slice(windowed.start, windowed.end).map((task) => (
            <BacklogItem
              key={task.key}
              task={task}
              selected={task.key === selectedKey}
              dragging={task.key === draggingKey}
              dropZone={dropTarget?.key === task.key ? dropTarget.zone : null}
              tabbable={task.key === tabbableKey}
              menuFor={menuFor}
              onDragStart={onDragStart}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
          <li aria-hidden className='shrink-0' style={{ height: windowed.padBottom }} />
          <li className='shrink-0 px-1'>
            <TaskInlineCreate label='Create backlog task' onCreate={onCreate} />
          </li>
          {tasks.length === 0 && empty ? <li className='flex flex-1 items-center justify-center'>{empty}</li> : null}
        </ul>
      </ScrollArea>
    </section>
  )
}
