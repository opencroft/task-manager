import { AlertTriangle, ArrowRight, ArrowRightLeft, AtSign, Ban, BellOff, CircleCheck, Hourglass, Play, ShieldCheck, UserPlus } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { ItemContextMenu, type ItemMenuEntries } from '../tasks/item-menu'
import { TaskAssignee, type TaskAssigneeValue } from '../tasks/task-assignee'
import { TaskStatusBadge, type TaskStatusCategory } from '../tasks/task-status-badge'
import { TaskTypeIcon, type TaskType } from '../tasks/task-type-icon'

export type TaskNotificationKind =
  | 'assigned'
  | 'mentioned'
  | 'step_open'
  | 'step_waiting'
  | 'step_attention'
  | 'approval_requested'
  | 'workflow_finished'
  | 'workflow_cancelled'
  | 'status_changed'

export interface TaskNotificationStatus {
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface TaskNotification {
  id: string
  kind: TaskNotificationKind
  /** ISO 8601. Grouped and shown in the viewer's local time. */
  createdAt: string
  read: boolean
  /** Who did it; null or omitted when the workflow engine did. */
  actor?: TaskAssigneeValue | null
  task: { key: string; summary: string; type?: TaskType }
  /** The run, on step_* and workflow_* kinds. */
  workflow?: { name: string }
  /** The step, on step_* kinds. */
  step?: { name: string }
  /** The status before, on status_changed. */
  from?: TaskNotificationStatus
  /** The status after, on status_changed; on workflow_finished, the status the task ended in. */
  to?: TaskNotificationStatus
  /** The comment on mentioned, the engine's error on step_attention. Plain text. */
  excerpt?: string
  /** The recipient muted this task: nothing new about it arrives until unmuted. */
  muted?: boolean
}

export const TASK_NOTIFICATION_KINDS: TaskNotificationKind[] = [
  'assigned',
  'mentioned',
  'step_open',
  'step_waiting',
  'step_attention',
  'approval_requested',
  'workflow_finished',
  'workflow_cancelled',
  'status_changed',
]

const KIND: Record<TaskNotificationKind, { icon: typeof Play; tone: string; label: string }> = {
  assigned: { icon: UserPlus, tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', label: 'Assigned to you' },
  mentioned: { icon: AtSign, tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', label: 'Mentioned you' },
  step_open: { icon: Play, tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', label: 'Your step is open' },
  step_waiting: { icon: Hourglass, tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', label: 'Waiting on you' },
  step_attention: { icon: AlertTriangle, tone: 'bg-red-500/15 text-red-700 dark:text-red-300', label: 'Needs attention' },
  approval_requested: { icon: ShieldCheck, tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', label: 'Approval requested' },
  workflow_finished: { icon: CircleCheck, tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', label: 'Workflow finished' },
  workflow_cancelled: { icon: Ban, tone: 'bg-muted text-muted-foreground', label: 'Workflow cancelled' },
  status_changed: { icon: ArrowRightLeft, tone: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300', label: 'Status changed' },
}

export function taskNotificationKindLabel(kind: TaskNotificationKind): string {
  return KIND[kind].label
}

/** A kind's glyph in its tinted circle. */
export function TaskNotificationKindIcon({ kind, size = 'md', className }: { kind: TaskNotificationKind; size?: 'sm' | 'md'; className?: string }) {
  const { icon: Icon, tone } = KIND[kind]
  return (
    <span
      aria-hidden='true'
      data-kind={kind}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full', size === 'sm' ? 'size-4' : 'size-8', tone, className)}
    >
      <Icon className={size === 'sm' ? 'size-2.5' : 'size-4'} strokeWidth={size === 'sm' ? 2.75 : 2} />
    </span>
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whether the notification happened on the same local day as `now`. */
export function isNotificationToday(createdAt: string, now: Date = new Date()): boolean {
  return startOfDay(new Date(createdAt)) === startOfDay(now)
}

/** Short relative time: now, 5m, 3h, Yesterday, a weekday within the week, then a date. */
export function formatNotificationTime(createdAt: string, now: Date = new Date()): string {
  const date = new Date(createdAt)
  const diff = now.getTime() - date.getTime()
  if (diff < MINUTE) {
    return 'now'
  }
  const days = Math.round((startOfDay(now) - startOfDay(date)) / (24 * HOUR))
  if (days <= 0) {
    return diff < HOUR ? `${Math.floor(diff / MINUTE)}m` : `${Math.floor(diff / HOUR)}h`
  }
  if (days === 1) {
    return 'Yesterday'
  }
  if (days < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' })
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

function Strong({ children }: { children: ReactNode }) {
  return <span className='font-semibold text-foreground'>{children}</span>
}

function headline(n: TaskNotification): ReactNode {
  const actor = n.actor ? <Strong>{n.actor.name}</Strong> : null
  const step = <Strong>{n.step?.name ?? 'A step'}</Strong>
  const workflow = n.workflow ? <Strong>{n.workflow.name}</Strong> : null
  switch (n.kind) {
    case 'assigned':
      return actor ? <>{actor} assigned you</> : 'Assigned to you'
    case 'mentioned':
      return <>{actor ?? <Strong>Someone</Strong>} mentioned you</>
    case 'step_open':
      return workflow ? <>Your step {step} in {workflow} is open</> : <>Your step {step} is open</>
    case 'step_waiting':
      return workflow ? <>{step} in {workflow} is waiting on you</> : <>{step} is waiting on you</>
    case 'step_attention':
      return workflow ? <>{step} in {workflow} needs attention</> : <>{step} needs attention</>
    case 'approval_requested':
      return workflow ? <>{step} in {workflow} needs your approval</> : <>{step} needs your approval</>
    case 'workflow_finished':
      return <>{workflow ?? <Strong>The workflow</Strong>} finished</>
    case 'workflow_cancelled':
      return actor ? (
        <>
          {actor} cancelled {workflow ?? 'the workflow'}
        </>
      ) : (
        <>{workflow ?? <Strong>The workflow</Strong>} was cancelled</>
      )
    case 'status_changed':
      return actor ? <>{actor} changed the status</> : 'The status changed'
  }
}

function Detail({ n }: { n: TaskNotification }) {
  if (n.kind === 'status_changed' && n.to) {
    return (
      <span className='flex min-w-0 items-center gap-1.5'>
        {n.from ? (
          <>
            <TaskStatusBadge size='sm' name={n.from.name} category={n.from.category} color={n.from.color} className='min-w-0' />
            <ArrowRight aria-label='to' className='size-3 shrink-0 text-muted-foreground' />
          </>
        ) : null}
        <TaskStatusBadge size='sm' name={n.to.name} category={n.to.category} color={n.to.color} className='min-w-0' />
      </span>
    )
  }
  if (n.kind === 'workflow_finished' && n.to) {
    return (
      <span className='flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
        <span className='shrink-0'>Ended in</span>
        <TaskStatusBadge size='sm' name={n.to.name} category={n.to.category} color={n.to.color} className='min-w-0' />
      </span>
    )
  }
  if (n.excerpt && (n.kind === 'mentioned' || n.kind === 'step_attention')) {
    return (
      <span
        className={cn(
          'line-clamp-2 text-xs break-words',
          n.kind === 'mentioned' ? 'border-l-2 border-border pl-2 text-muted-foreground' : 'text-red-700 dark:text-red-300',
        )}
      >
        {n.excerpt}
      </span>
    )
  }
  return null
}

export interface TaskNotificationRowProps {
  notification: TaskNotification
  /** Pressing the row. An unread row is also marked read first. */
  onOpen?: (notification: TaskNotification, event: MouseEvent<HTMLElement>) => void
  /** Marks the row read; its unread dot is the button. Without it the dot only shows. */
  onMarkRead?: (ids: string[]) => void
  /** Makes the row a real link to the task, so it opens in a new tab too. */
  href?: string
  /** The row's menu on right-click, long press, the Menu key or Shift+F10: e.g. open, mark read or unread, mute. */
  menu?: ItemMenuEntries
  /** The time the relative times are counted from; the current time by default. */
  now?: Date
  className?: string
}

/**
 * One notification: the actor's avatar badged with the kind's glyph (the glyph
 * alone when the engine did it), a sentence saying what happened, the task, and
 * for some kinds a detail line (the comment, the error, the status change).
 * Unread rows are tinted, with a dot that marks them read.
 */
export function TaskNotificationRow({ notification: n, onOpen, onMarkRead, href, menu = [], now, className }: TaskNotificationRowProps) {
  const unread = !n.read
  const time = formatNotificationTime(n.createdAt, now)
  const open = (event: MouseEvent<HTMLElement>) => {
    if (unread) {
      onMarkRead?.([n.id])
    }
    onOpen?.(n, event)
  }
  const body = (
    <>
      <span aria-hidden='true' className='relative mt-0.5 shrink-0'>
        {n.actor ? (
          <>
            <TaskAssignee assignee={n.actor} className='[&>span:first-child]:size-8 [&>span:first-child]:text-xs' />
            <TaskNotificationKindIcon kind={n.kind} size='sm' className='absolute -right-1 -bottom-1 ring-2 ring-background' />
          </>
        ) : (
          <TaskNotificationKindIcon kind={n.kind} />
        )}
      </span>
      <span className='flex min-w-0 flex-1 flex-col gap-1'>
        <span className='flex min-w-0 items-start gap-2'>
          <span className={cn('line-clamp-2 min-w-0 flex-1 text-sm break-words', unread ? 'text-foreground' : 'text-muted-foreground')}>
            {headline(n)}
          </span>
          <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()} className='shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums'>
            {n.muted ? <BellOff aria-label='Muted' className='mr-1 inline size-3 align-[-2px]' /> : null}
            {time}
          </time>
        </span>
        <span className='flex min-w-0 items-center gap-1.5 text-xs'>
          {n.task.type ? <TaskTypeIcon type={n.task.type} /> : null}
          <span className='shrink-0 font-mono text-muted-foreground'>{n.task.key}</span>
          <span className='truncate text-foreground/90'>{n.task.summary}</span>
        </span>
        <Detail n={n} />
        <span className='sr-only'>{unread ? 'Unread' : 'Read'}</span>
      </span>
    </>
  )
  const face = 'flex min-w-0 flex-1 items-start gap-3 rounded-md py-2.5 pr-1 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset'
  return (
    <ItemContextMenu
      entries={menu}
      render={<div data-slot='task-notification-row' data-kind={n.kind} data-unread={unread || undefined} />}
      className={cn('flex min-w-0 items-start rounded-md transition-colors hover:bg-muted/60', unread && 'bg-primary/5', className)}
    >
      {href ? (
        <a href={href} onClick={open} className={face}>
          {body}
        </a>
      ) : (
        <button type='button' onClick={open} className={face}>
          {body}
        </button>
      )}
      <span className='flex w-7 shrink-0 justify-center self-stretch pt-3'>
        {unread ? (
          onMarkRead ? (
            <button
              type='button'
              aria-label='Mark read'
              title='Mark read'
              onClick={() => onMarkRead([n.id])}
              className='inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-primary/10 focus-visible:ring-3 focus-visible:ring-ring/50'
            >
              <span className='size-2 rounded-full bg-primary' />
            </button>
          ) : (
            <span aria-hidden='true' className='mt-2 size-2 rounded-full bg-primary' />
          )
        ) : null}
      </span>
    </ItemContextMenu>
  )
}
