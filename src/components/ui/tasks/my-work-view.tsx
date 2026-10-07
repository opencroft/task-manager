import { ExternalLink } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from 'react'

import { Button } from '../button'
import { SegmentedButton } from '../input/segmented-button'
import { Skeleton } from '../skeleton'
import { formatNotificationTime, type TaskNotification, TaskNotificationKindIcon, TaskNotificationRow } from '../notifications/task-notification-row'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskAssignee, type TaskAssigneeValue } from './task-assignee'
import { TaskInlineCreate } from './task-inline-create'
import { TaskActionsMenu, TaskContextMenu, type TaskMenuProps } from './task-menu'
import { type TaskPriority, TaskPriorityIcon } from './task-priority-icon'
import { type TaskProject, TaskProjectChip } from './task-project-chip'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskType, TaskTypeIcon } from './task-type-icon'

/**
 * The project a row comes from, when the page shows all projects: named on the
 * row, and handed back to `onOpen` so the task opens where it lives.
 */
export type MyWorkProject = TaskProject

/** Whose work the page shows: the project it is in, or every project. */
export type MyWorkScope = 'this' | 'all'

/** Which projects an all-projects answer covers. */
export interface MyWorkCoverage {
  read: number
  total: number
  unavailable?: { name: string; error: string }[]
}

/** A task as the sections list it; a task list row passes as it is. Dates are calendar days (YYYY-MM-DD). */
export interface MyWorkTask {
  key: string
  summary: string
  type: TaskType
  priority: TaskPriority
  status: { id?: number; name: string; category: TaskStatusCategory; color?: string | null }
  assignee?: TaskAssigneeValue | null
  startDate?: string | null
  endDate?: string | null
  project?: MyWorkProject
}

/** A workflow step that needs the viewer: its session is theirs and open, it waits on them, or it needs attention. */
export interface MyWorkStep {
  id: string
  state: 'open' | 'waiting' | 'attention'
  task: { key: string; summary: string; type?: TaskType }
  workflow: string
  step: string
  /** When the step reached this state (ISO 8601). */
  since: string
  /** Why it needs attention, as the engine said it. */
  reason?: string | null
  /** The step's session, when there is one to open. */
  sessionHref?: string | null
  project?: MyWorkProject
}

/** A recent change; `project` is set on one of another project's tasks. */
export type MyWorkNotification = TaskNotification & { project?: MyWorkProject }

export interface MyWorkData {
  waiting: MyWorkStep[]
  /** Assigned to the viewer and not done. */
  assigned: MyWorkTask[]
  /** Scheduled to start in the next 7 days. */
  startingSoon: MyWorkTask[]
  /** From the inbox: changes on tasks the viewer reported, is assigned or was mentioned on. Newest first. */
  recent: MyWorkNotification[]
  /** With all projects: which were read, so a cut or a failure shows. */
  projects?: MyWorkCoverage
}

export interface MyWorkViewProps {
  /** Whose work this is; an agent sees the same page about itself. */
  viewer: TaskAssigneeValue
  /** Null until the first answer. */
  data: MyWorkData | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** Opens a task; `project` is set on a row from another project, as the data gave it. */
  onOpen: (key: string, project?: MyWorkProject) => void
  /** This project or all of them. With `onScopeChange`, the header offers the switch. */
  scope?: MyWorkScope
  onScopeChange?: (scope: MyWorkScope) => void
  /** The task the keyboard is on; its rows are drawn selected. */
  selectedKey?: string | null
  /** The task menu for a row: on right-click or long press, and behind its … button. None for a row it returns nothing for. */
  menuFor?: (task: MyWorkTask) => TaskMenuProps | undefined
  /** Creates a task assigned to the viewer. Without it there is no create field. */
  onCreate?: (summary: string) => Promise<unknown> | unknown
  /** Status names in board order, to order the Assigned groups; by category otherwise. */
  statusOrder?: string[]
  /** A waiting step's menu (right-click, long press, the Menu key or Shift+F10): e.g. open the task or the thread. */
  stepMenu?: (step: MyWorkStep) => ItemMenuEntries
  /** A recent change's menu, as in the inbox: e.g. open, mark read or unread, mute. */
  recentMenu?: (notification: MyWorkNotification) => ItemMenuEntries
  /** Opens the whole inbox, under Recently changed. */
  onShowInbox?: () => void
  /** How many recent changes to list. */
  recentLimit?: number
  /** How many rows the other sections list before their "Show all (N)" footer, which expands the section in place. */
  sectionLimit?: number
  /** Today, for overdue and "starts tomorrow"; the current day by default. */
  now?: Date
  className?: string
}

const DAY = 24 * 60 * 60 * 1000
const CATEGORY_ORDER: Record<TaskStatusCategory, number> = { in_progress: 0, todo: 1, done: 2 }

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY)
}

function todayNumber(now: Date): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY)
}

function formatDay(date: string, withWeekday = false): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    weekday: withWeekday ? 'short' : undefined,
  })
}

function EndDate({ task, today }: { task: MyWorkTask; today: number }) {
  if (!task.endDate) {
    return null
  }
  const overdue = task.status.category !== 'done' && dayNumber(task.endDate) < today
  return (
    <span
      className={cn('shrink-0 text-xs tabular-nums', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}
      title={overdue ? `Overdue: it was to end ${formatDay(task.endDate, true)}` : `Ends ${formatDay(task.endDate, true)}`}
    >
      {overdue ? 'Overdue · ' : 'Ends '}
      {formatDay(task.endDate)}
    </span>
  )
}

function StartDate({ task, today }: { task: MyWorkTask; today: number }) {
  if (!task.startDate) {
    return null
  }
  const days = dayNumber(task.startDate) - today
  const label = days <= 0 ? 'Starts today' : days === 1 ? 'Starts tomorrow' : `Starts ${formatDay(task.startDate, true)}`
  return <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{label}</span>
}

type OpenTask = MyWorkViewProps['onOpen']

/** A row's React key: task keys repeat when two projects share a project key. */
const rowKey = (key: string, project?: MyWorkProject) => (project ? `${project.app ?? project.key}:${key}` : key)

function TaskRow({ task, date, selected, onOpen, menu }: { task: MyWorkTask; date: ReactNode; selected: boolean; onOpen: OpenTask; menu?: TaskMenuProps }) {
  const content = (
    <>
      <TaskTypeIcon type={task.type} />
      <span className='w-16 shrink-0 truncate font-mono text-xs text-muted-foreground @xl:w-20'>{task.key}</span>
      <TaskProjectChip project={task.project} />
      <span className='min-w-0 flex-1 truncate text-sm'>{task.summary}</span>
      {date}
      <TaskPriorityIcon priority={task.priority} className='hidden @xl:inline-flex' />
      <TaskStatusBadge name={task.status.name} category={task.status.category} color={task.status.color} size='sm' className='hidden max-w-28 @xl:inline-flex' />
      {menu ? (
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <TaskActionsMenu {...menu} label={`Actions for ${task.key}`} />
        </span>
      ) : null}
    </>
  )
  const rowProps = {
    role: 'button',
    tabIndex: 0,
    // A page's key handler moves J/K through elements carrying this, in on-screen order;
    // a task of another project is not one its keys can act on.
    'data-task-key': task.project ? undefined : task.key,
    'data-state': selected && !task.project ? 'selected' : undefined,
    onClick: () => onOpen(task.key, task.project),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        onOpen(task.key, task.project)
      }
    },
    className:
      'flex h-10 min-w-0 cursor-pointer items-center gap-2.5 border-b px-3 outline-none last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset data-[state=selected]:bg-muted',
  }
  return menu ? (
    <TaskContextMenu {...menu} render={<div {...rowProps} />}>
      {content}
    </TaskContextMenu>
  ) : (
    <div {...rowProps}>{content}</div>
  )
}

const SCOPES: { value: MyWorkScope; label: string }[] = [
  { value: 'this', label: 'This project' },
  { value: 'all', label: 'All projects' },
]

/** Says so when an all-projects answer stopped short or left a project out; nothing when it read them all. */
function Coverage({ projects }: { projects: MyWorkCoverage }) {
  const cut = projects.total > projects.read
  const failed = projects.unavailable ?? []
  if (!cut && failed.length === 0) {
    return null
  }
  return (
    <p role='status' className='text-xs text-muted-foreground'>
      {cut ? `Showing the first ${projects.read} of ${projects.total} projects. ` : null}
      {failed.length > 0 ? (
        <span title={failed.map((p) => `${p.name}: ${p.error}`).join('\n')}>
          {failed.length === 1 ? `${failed[0].name} could not be read.` : `${failed.length} projects could not be read.`}
        </span>
      ) : null}
    </p>
  )
}

const STEP_KIND = { open: 'step_open', waiting: 'step_waiting', attention: 'step_attention' } as const
const STEP_LABEL = { open: 'Your session is open', waiting: 'Waiting on you', attention: 'Needs attention' } as const

function StepRow({ step, selected, onOpen, menu = [], now }: { step: MyWorkStep; selected: boolean; onOpen: OpenTask; menu?: ItemMenuEntries; now?: Date }) {
  const own = !step.project
  return (
    <ItemContextMenu
      entries={menu}
      render={<div data-task-key={own ? step.task.key : undefined} data-state={selected && own ? 'selected' : undefined} />}
      className='flex min-w-0 items-start gap-3 border-b px-3 py-2.5 last:border-b-0 data-[state=selected]:bg-muted'
    >
      <TaskNotificationKindIcon kind={STEP_KIND[step.state]} className='mt-0.5' />
      <button
        type='button'
        onClick={() => onOpen(step.task.key, step.project)}
        className='flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
      >
        <span className='flex min-w-0 items-baseline gap-2'>
          <span className='min-w-0 truncate text-sm'>
            <span className='font-semibold'>{step.step}</span>
            <span className='text-muted-foreground'> in {step.workflow}</span>
          </span>
          <time dateTime={step.since} className='ml-auto shrink-0 text-xs text-muted-foreground tabular-nums' title={new Date(step.since).toLocaleString()}>
            {formatNotificationTime(step.since, now)}
          </time>
        </span>
        <span className='flex min-w-0 items-center gap-1.5 text-xs'>
          {step.task.type ? <TaskTypeIcon type={step.task.type} /> : null}
          <span className='shrink-0 font-mono text-muted-foreground'>{step.task.key}</span>
          <TaskProjectChip project={step.project} />
          <span className='truncate'>{step.task.summary}</span>
        </span>
        <span className={cn('text-xs', step.state === 'attention' ? 'text-destructive' : 'text-muted-foreground')}>
          {STEP_LABEL[step.state]}
          {step.state === 'attention' && step.reason ? <span className='line-clamp-2 break-words'>{step.reason}</span> : null}
        </span>
      </button>
      {step.sessionHref ? (
        <Button variant='ghost' size='icon-sm' className='-my-1 shrink-0' aria-label={`Open the ${step.step} session`} title='Open the session' render={<a href={step.sessionHref} target='_blank' rel='noreferrer' />}>
          <ExternalLink />
        </Button>
      ) : null}
    </ItemContextMenu>
  )
}

function Section({ title, count, empty, children, action, footer }: { title: string; count: number; empty: string; children: ReactNode; action?: ReactNode; footer?: ReactNode }) {
  return (
    <section aria-label={title} className='flex min-w-0 flex-col gap-2'>
      <div className='flex min-w-0 items-center gap-2'>
        <h2 className='text-sm font-semibold'>{title}</h2>
        {count > 0 ? <span className='text-xs text-muted-foreground tabular-nums'>{count}</span> : null}
        {action ? <span className='ml-auto'>{action}</span> : null}
      </div>
      {count === 0 ? <p className='rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground'>{empty}</p> : children}
      {count > 0 ? footer : null}
    </section>
  )
}

/** A long section's footer: expands it in place, and collapses it again. */
function SectionFooter({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  return (
    <Button variant='ghost' size='xs' className='self-start text-muted-foreground' aria-expanded={expanded} onClick={onToggle}>
      {expanded ? 'Show fewer' : `Show all (${total})`}
    </Button>
  )
}

function SkeletonSection({ rows }: { rows: number }) {
  return (
    <div aria-hidden='true' className='flex flex-col gap-2'>
      <Skeleton className='h-4 w-32' />
      <div className='flex flex-col overflow-hidden rounded-lg border'>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className='flex h-10 items-center gap-2.5 border-b px-3 last:border-b-0'>
            <Skeleton className='size-4' />
            <Skeleton className='h-3 w-14' />
            <Skeleton className='h-3 flex-1' />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The landing page: what needs the viewer now. Waiting on you and Assigned to
 * you come first; Starting soon and Recently changed sit beside them on a wide
 * screen and below them on a narrow one.
 */
export function MyWorkView({
  viewer,
  data,
  loading = false,
  error = null,
  onRetry,
  onOpen,
  scope = 'this',
  onScopeChange,
  selectedKey = null,
  menuFor,
  onCreate,
  statusOrder,
  stepMenu,
  recentMenu,
  onShowInbox,
  recentLimit = 8,
  sectionLimit = 10,
  now,
  className,
}: MyWorkViewProps) {
  const today = todayNumber(now ?? new Date())
  const own = viewer.kind === 'agent'
  // The sections expanded past `sectionLimit`, by name.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const shown = <T,>(section: string, items: T[]) => (expanded[section] ? items : items.slice(0, sectionLimit))
  const footer = (section: string, total: number) =>
    total > sectionLimit ? (
      <SectionFooter total={total} expanded={Boolean(expanded[section])} onToggle={() => setExpanded((open) => ({ ...open, [section]: !open[section] }))} />
    ) : null

  const header = (
    <div className='flex min-w-0 flex-col gap-3'>
      <div className='flex min-w-0 items-center gap-2.5'>
        <TaskAssignee assignee={viewer} className='[&>span:first-child]:size-7' />
        <div className='flex min-w-0 flex-col'>
          <h1 className='truncate text-lg font-semibold'>My work</h1>
          <p className='truncate text-xs text-muted-foreground'>{own ? `What needs ${viewer.name}, the agent, now` : `What needs you now, ${viewer.name}`}</p>
        </div>
        <div className='ml-auto flex shrink-0 items-center gap-2'>
          {loading && data ? <span className='text-xs text-muted-foreground'>Updating…</span> : null}
          {onScopeChange ? <SegmentedButton size='sm' value={scope} onChange={(next) => next !== scope && onScopeChange(next)} options={SCOPES} /> : null}
        </div>
      </div>
      {data?.projects ? <Coverage projects={data.projects} /> : null}
      {onCreate ? (
        <div className='rounded-lg border'>
          <TaskInlineCreate label='Create a task assigned to you' onCreate={onCreate} className='h-10' />
        </div>
      ) : null}
    </div>
  )

  let body: ReactNode
  if (!data && loading) {
    body = (
      <div role='status' aria-label='Loading your work' className='grid gap-6 @4xl:grid-cols-2'>
        <div className='flex flex-col gap-6'>
          <SkeletonSection rows={2} />
          <SkeletonSection rows={4} />
        </div>
        <div className='flex flex-col gap-6'>
          <SkeletonSection rows={3} />
          <SkeletonSection rows={4} />
        </div>
      </div>
    )
  } else if (!data) {
    body = <TaskManagerError title='Your work could not load' message={error} onRetry={onRetry} />
  } else {
    const rank = (name: string, category: TaskStatusCategory) => {
      const at = statusOrder?.indexOf(name) ?? -1
      return at >= 0 ? at : 1000 + CATEGORY_ORDER[category]
    }
    const groups: { name: string; category: TaskStatusCategory; color?: string | null; tasks: MyWorkTask[] }[] = []
    for (const task of data.assigned) {
      const group = groups.find((g) => g.name === task.status.name)
      if (group) {
        group.tasks.push(task)
      } else {
        groups.push({ name: task.status.name, category: task.status.category, color: task.status.color, tasks: [task] })
      }
    }
    groups.sort((a, b) => rank(a.name, a.category) - rank(b.name, b.category))
    // The limit counts rows, not groups: the first rows in on-screen order, each group keeping its full count.
    let room = expanded.assigned ? Number.POSITIVE_INFINITY : sectionLimit
    const shownGroups = groups
      .map((group) => {
        const tasks = group.tasks.slice(0, Math.max(0, room))
        room -= tasks.length
        return { ...group, shownTasks: tasks }
      })
      .filter((group) => group.shownTasks.length > 0)
    const overdue = data.assigned.filter((t) => t.endDate && dayNumber(t.endDate) < today).length
    const recent = data.recent.slice(0, recentLimit)

    body = (
      <div className='flex flex-col gap-6'>
        {error ? <TaskManagerError variant='inline' title='Could not refresh' message={error} onRetry={onRetry} /> : null}
        <div className='grid gap-6 @4xl:grid-cols-2'>
          <div className='flex min-w-0 flex-col gap-6'>
            <Section
              title='Waiting on you'
              count={data.waiting.length}
              empty='Nothing is waiting on you. Workflow steps that are yours, wait on you or need your attention show up here.'
              footer={footer('waiting', data.waiting.length)}
            >
              <div className='flex flex-col overflow-hidden rounded-lg border'>
                {shown('waiting', data.waiting).map((step) => (
                  <StepRow key={rowKey(step.id, step.project)} step={step} selected={step.task.key === selectedKey} onOpen={onOpen} menu={stepMenu?.(step)} now={now} />
                ))}
              </div>
            </Section>
            <Section
              title='Assigned to you'
              count={data.assigned.length}
              empty='Nothing assigned to you is open. Tasks assigned to you show up here until they are done.'
              action={overdue > 0 ? <span className='text-xs font-medium text-destructive'>{overdue} overdue</span> : undefined}
              footer={footer('assigned', data.assigned.length)}
            >
              <div className='flex flex-col gap-3'>
                {shownGroups.map((group) => (
                  <div key={group.name} className='flex flex-col gap-1.5'>
                    <div className='flex items-center gap-2'>
                      <TaskStatusBadge name={group.name} category={group.category} color={group.color} size='sm' />
                      <span className='text-xs text-muted-foreground tabular-nums'>{group.tasks.length}</span>
                    </div>
                    <div className='flex flex-col overflow-hidden rounded-lg border'>
                      {group.shownTasks.map((task) => (
                        <TaskRow key={rowKey(task.key, task.project)} task={task} date={<EndDate task={task} today={today} />} selected={task.key === selectedKey} onOpen={onOpen} menu={menuFor?.(task)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
          <div className='flex min-w-0 flex-col gap-6'>
            <Section
              title='Starting soon'
              count={data.startingSoon.length}
              empty='Nothing of yours is scheduled to start in the next 7 days.'
              footer={footer('startingSoon', data.startingSoon.length)}
            >
              <div className='flex flex-col overflow-hidden rounded-lg border'>
                {shown('startingSoon', data.startingSoon).map((task) => (
                  <TaskRow key={rowKey(task.key, task.project)} task={task} date={<StartDate task={task} today={today} />} selected={task.key === selectedKey} onOpen={onOpen} menu={menuFor?.(task)} />
                ))}
              </div>
            </Section>
            <Section
              title='Recently changed'
              count={data.recent.length}
              empty='No recent changes on tasks you reported, are assigned or were mentioned on.'
              action={
                onShowInbox && data.recent.length > 0 ? (
                  <Button variant='ghost' size='xs' onClick={onShowInbox}>
                    Open the inbox
                  </Button>
                ) : undefined
              }
            >
              <div className='flex flex-col gap-0.5 rounded-lg border p-1'>
                {recent.map((n) => (
                  <TaskNotificationRow key={rowKey(n.id, n.project)} notification={n} now={now} menu={recentMenu?.(n)} onOpen={(_item: TaskNotification, event: MouseEvent<HTMLElement>) => {
                    event.preventDefault()
                    onOpen(n.task.key, n.project)
                  }} />
                ))}
              </div>
            </Section>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-slot='my-work-view' className={cn('@container flex min-w-0 flex-col gap-6', className)}>
      {header}
      {body}
    </div>
  )
}
