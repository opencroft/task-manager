import { CheckCheck, Inbox, Loader2 } from 'lucide-react'
import { type MouseEvent, type ReactNode, useState } from 'react'

import { Button } from '../button'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'
import type { ItemMenuEntries } from '../tasks/item-menu'

import { TaskInboxButton } from './task-inbox-button'
import { isNotificationToday, type TaskNotification, type TaskNotificationKind, TaskNotificationRow } from './task-notification-row'

export type TaskInboxFilter = 'all' | 'assigned' | 'mentions' | 'workflows' | 'status'

export const TASK_INBOX_FILTERS: { value: TaskInboxFilter; label: string; empty: string }[] = [
  { value: 'all', label: 'All', empty: '' },
  { value: 'assigned', label: 'Assigned', empty: 'No assignments' },
  { value: 'mentions', label: 'Mentions', empty: 'No mentions' },
  { value: 'workflows', label: 'Workflows', empty: 'No workflow updates' },
  { value: 'status', label: 'Status', empty: 'No status changes' },
]

/** Whether a kind belongs under a filter: workflows is every step_* and workflow_* kind. */
export function taskInboxFilterMatches(filter: TaskInboxFilter, kind: TaskNotificationKind): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'assigned':
      return kind === 'assigned'
    case 'mentions':
      return kind === 'mentioned'
    case 'workflows':
      return kind.startsWith('step_') || kind.startsWith('workflow_')
    case 'status':
      return kind === 'status_changed'
  }
}

export interface TaskInboxPanelProps {
  /** Newest first. With `filter` given, already filtered; without it, filtered here. */
  items: TaskNotification[]
  /** Unread over every kind, for the header; counted from `items` when omitted. */
  unread?: number
  /** The kind filter, when the host filters (on the server). Omit it to filter the loaded items here. */
  filter?: TaskInboxFilter
  onFilterChange?: (filter: TaskInboxFilter) => void
  /** Pressing a row; an unread row is marked read first. */
  onOpen?: (notification: TaskNotification, event: MouseEvent<HTMLElement>) => void
  onMarkRead?: (ids: string[]) => void
  /** A row's menu (right-click, long press, the Menu key or Shift+F10): e.g. open, mark read or unread, mute the task. */
  rowMenu?: (notification: TaskNotification) => ItemMenuEntries
  /** Everything read, loaded or not. Without it the header has no Mark all read. */
  onMarkAllRead?: () => void
  /** A link per row, so a task also opens in a new tab. */
  getHref?: (notification: TaskNotification) => string | undefined
  /** Older notifications exist; a Load earlier row asks for them. */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  /** The first page is loading. */
  loading?: boolean
  /** Loading failed; with items loaded it shows under them instead of replacing them. */
  error?: string | null
  onRetry?: () => void
  /** The time Today and the relative times are counted from; the current time by default. */
  now?: Date
  title?: string
  className?: string
}

function SkeletonRow() {
  return (
    <div aria-hidden='true' className='flex items-start gap-3 px-2.5 py-2.5'>
      <Skeleton className='size-8 shrink-0 rounded-full' />
      <span className='flex flex-1 flex-col gap-2 pt-1'>
        <Skeleton className='h-3 w-3/4' />
        <Skeleton className='h-3 w-1/2' />
      </span>
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className='flex flex-col'>
      <h3 className='sticky top-0 z-10 bg-popover/95 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground backdrop-blur-sm'>{label}</h3>
      <ul className='flex flex-col gap-0.5 px-1'>{children}</ul>
    </section>
  )
}

/**
 * The inbox list: a header with the unread count and Mark all read, the kind
 * filter, then the notifications under Today and Earlier, and Load earlier at
 * the end. It fills its container's height and scrolls inside it.
 */
export function TaskInboxPanel({
  items,
  unread,
  filter,
  onFilterChange,
  onOpen,
  onMarkRead,
  rowMenu,
  onMarkAllRead,
  getHref,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  loading = false,
  error = null,
  onRetry,
  now,
  title = 'Notifications',
  className,
}: TaskInboxPanelProps) {
  const [localFilter, setLocalFilter] = useState<TaskInboxFilter>('all')
  const controlled = filter !== undefined
  const active = controlled ? filter : localFilter
  const shown = controlled ? items : items.filter((n) => taskInboxFilterMatches(active, n.kind))
  const unreadCount = unread ?? items.filter((n) => !n.read).length
  const clock = now ?? new Date()
  const today = shown.filter((n) => isNotificationToday(n.createdAt, clock))
  const earlier = shown.filter((n) => !isNotificationToday(n.createdAt, clock))
  const activeFilter = TASK_INBOX_FILTERS.find((f) => f.value === active) ?? TASK_INBOX_FILTERS[0]

  const choose = (value: TaskInboxFilter) => {
    if (!controlled) {
      setLocalFilter(value)
    }
    onFilterChange?.(value)
  }

  const row = (n: TaskNotification) => (
    <li key={n.id}>
      <TaskNotificationRow notification={n} now={clock} onOpen={onOpen} onMarkRead={onMarkRead} href={getHref?.(n)} menu={rowMenu?.(n)} />
    </li>
  )

  let body: ReactNode
  if (loading && shown.length === 0) {
    body = (
      <div role='status' aria-label='Loading notifications' className='flex flex-col px-1 py-1'>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    )
  } else if (error && shown.length === 0) {
    body = (
      <div className='p-2'>
        <TaskManagerError variant='inline' title='The notifications could not load' message={error} onRetry={onRetry} />
      </div>
    )
  } else if (shown.length === 0) {
    body =
      active === 'all' ? (
        <div className='flex flex-col items-center gap-2 px-6 py-10 text-center'>
          <span className='inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground'>
            <Inbox aria-hidden='true' className='size-5' />
          </span>
          <p className='text-sm font-medium'>You are all caught up</p>
          <p className='max-w-64 text-xs text-muted-foreground'>Tasks assigned to you, mentions, and workflow steps that need you will show up here.</p>
        </div>
      ) : (
        <div className='flex flex-col items-center gap-2 px-6 py-10 text-center'>
          <p className='text-sm font-medium'>{activeFilter.empty}</p>
          <Button variant='ghost' size='sm' onClick={() => choose('all')}>
            Show all
          </Button>
        </div>
      )
  } else {
    body = (
      <div className='flex flex-col pb-1'>
        {today.length > 0 ? <Section label='Today'>{today.map(row)}</Section> : null}
        {earlier.length > 0 ? <Section label='Earlier'>{earlier.map(row)}</Section> : null}
        {error ? (
          <div className='px-2 pt-1'>
            <TaskManagerError variant='inline' title='Earlier notifications could not load' message={error} onRetry={onRetry} />
          </div>
        ) : null}
        {hasMore && onLoadMore ? (
          <div className='flex justify-center px-2 pt-1'>
            <Button variant='ghost' size='sm' className='w-full text-muted-foreground' disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
              {loadingMore ? 'Loading' : 'Load earlier'}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div data-slot='task-inbox-panel' className={cn('flex min-h-0 flex-col', className)}>
      <div className='flex shrink-0 items-center gap-2 border-b px-3 py-2'>
        <h2 className='min-w-0 truncate text-sm font-semibold'>{title}</h2>
        {unreadCount > 0 ? (
          <span className='shrink-0 rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary tabular-nums'>
            {unreadCount > 99 ? '99+' : unreadCount}
            <span className='sr-only'> unread</span>
          </span>
        ) : null}
        {onMarkAllRead ? (
          <Button variant='ghost' size='sm' className='ml-auto shrink-0' disabled={unreadCount === 0} onClick={onMarkAllRead}>
            <CheckCheck aria-hidden='true' />
            Mark all read
          </Button>
        ) : null}
      </div>
      <ScrollArea
        scrollbars='horizontal'
        viewportProps={{ role: 'group', 'aria-label': 'Show' }}
        className='shrink-0 border-b'
        innerClassName='flex-row gap-1 px-2 py-1.5'
      >
        {TASK_INBOX_FILTERS.map((f) => (
          <button
            key={f.value}
            type='button'
            aria-pressed={f.value === active}
            onClick={() => choose(f.value)}
            className={cn(
              'h-7 shrink-0 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              f.value === active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </ScrollArea>
      <ScrollArea className='flex-1' viewportClassName='overscroll-contain'>
        {body}
      </ScrollArea>
    </div>
  )
}

export interface TaskInboxProps extends TaskInboxPanelProps {
  /** The bell's badge; `unread`, or the loaded unread, when omitted. */
  count?: number
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  /** Classes for the bell. */
  triggerClassName?: string
}

/**
 * The bell and the inbox it opens. Opening a task from it closes it. Open state
 * can be left to it or controlled, e.g. to refetch when it opens.
 */
export function TaskInbox({ count, open, defaultOpen = false, onOpenChange, align = 'end', triggerClassName, onOpen, className, ...panel }: TaskInboxProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const isOpen = open ?? localOpen
  const setOpen = (next: boolean) => {
    if (open === undefined) {
      setLocalOpen(next)
    }
    onOpenChange?.(next)
  }
  const badge = count ?? panel.unread ?? panel.items.filter((n) => !n.read).length
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger render={<TaskInboxButton count={badge} className={triggerClassName} />} />
      <PopoverContent align={align} className='w-[min(26rem,calc(100vw-1rem))] gap-0 overflow-hidden p-0'>
        <TaskInboxPanel
          {...panel}
          onOpen={(notification, event) => {
            onOpen?.(notification, event)
            setOpen(false)
          }}
          className={cn('max-h-[min(36rem,calc(100dvh-5rem))]', className)}
        />
      </PopoverContent>
    </Popover>
  )
}
