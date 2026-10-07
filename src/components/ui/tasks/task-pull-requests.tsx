import { ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/** A pull request's state on the forge: merged is a closed one whose change landed. */
export type TaskPullRequestState = 'open' | 'merged' | 'closed'

/** A pull request that mentions the task in its title, body or branch. */
export interface TaskPullRequest {
  /** `owner/name` on the forge. */
  repo: string
  number: number
  title: string
  state: TaskPullRequestState
  /** The forge login of whoever opened it. */
  author: string
  url: string
  branch?: string | null
  /** When it last changed on the forge (ISO 8601). */
  updatedAt?: string
}

/** How many of a task's pull requests are in each state. */
export interface TaskPullRequestCounts {
  open: number
  merged: number
  closed: number
}

const STATE: Record<TaskPullRequestState, { label: string; icon: LucideIcon; tone: string; soft: string }> = {
  open: { label: 'Open', icon: GitPullRequest, tone: 'text-emerald-600 dark:text-emerald-400', soft: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  merged: { label: 'Merged', icon: GitMerge, tone: 'text-violet-600 dark:text-violet-400', soft: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  closed: { label: 'Closed', icon: GitPullRequestClosed, tone: 'text-muted-foreground', soft: 'bg-muted text-muted-foreground' },
}

export const TASK_PULL_REQUEST_STATE_LABELS: Record<TaskPullRequestState, string> = { open: 'Open', merged: 'Merged', closed: 'Closed' }

const ORDER: Record<TaskPullRequestState, number> = { open: 0, merged: 1, closed: 2 }

function when(iso?: string): string | null {
  if (!iso) {
    return null
  }
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function PullRequestRow({ pr }: { pr: TaskPullRequest }) {
  const state = STATE[pr.state]
  const Icon = state.icon
  const updated = when(pr.updatedAt)
  return (
    <li>
      <a
        href={pr.url}
        target='_blank'
        rel='noreferrer'
        className='group flex min-w-0 items-start gap-2.5 rounded-md px-2 py-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50'
      >
        <Icon aria-hidden='true' className={cn('mt-0.5 size-4 shrink-0', state.tone)} />
        <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span className='flex min-w-0 items-baseline gap-2'>
            <span className='min-w-0 truncate text-sm font-medium'>{pr.title}</span>
            <ExternalLink aria-hidden='true' className='size-3 shrink-0 self-center text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' />
          </span>
          <span className='flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground'>
            <span className={cn('font-medium', state.tone)}>{state.label}</span>
            <span aria-hidden='true'>·</span>
            <span className='font-mono'>
              {pr.repo}#{pr.number}
            </span>
            <span aria-hidden='true'>·</span>
            <span>{pr.author}</span>
            {pr.branch ? (
              <>
                <span aria-hidden='true'>·</span>
                <span className='max-w-48 truncate font-mono' title={pr.branch}>
                  {pr.branch}
                </span>
              </>
            ) : null}
            {updated ? (
              <>
                <span aria-hidden='true'>·</span>
                <time dateTime={pr.updatedAt ?? undefined}>{updated}</time>
              </>
            ) : null}
          </span>
        </span>
      </a>
    </li>
  )
}

export interface TaskPullRequestsProps {
  pullRequests: TaskPullRequest[]
  /** The task's key, for the empty state's hint. */
  taskKey: string
  /** False when no forge is connected: the empty state says so instead of how to link. */
  connected?: boolean
  className?: string
}

/**
 * A task's pull requests: open ones first, then merged, then closed, each
 * opening on the forge in a new tab. The host keeps them current; there is
 * nothing to add or remove here, a pull request links by naming the key.
 */
export function TaskPullRequests({ pullRequests, taskKey, connected = true, className }: TaskPullRequestsProps) {
  if (pullRequests.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        {connected ? (
          <>
            No pull request mentions <span className='font-mono'>{taskKey}</span> yet. Name it in a pull request's title, description or branch and it shows here within a minute.
          </>
        ) : (
          'No forge is connected, so pull requests are not linked. Connect one in Settings.'
        )}
      </p>
    )
  }
  const sorted = [...pullRequests].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return (
    <ul data-slot='task-pull-requests' className={cn('-mx-2 flex flex-col', className)}>
      {sorted.map((pr) => (
        <PullRequestRow key={`${pr.repo}#${pr.number}`} pr={pr} />
      ))}
    </ul>
  )
}

export interface TaskPullRequestChipProps {
  counts: TaskPullRequestCounts | null | undefined
  className?: string
}

/**
 * A task's pull requests at a glance, for a row or a card: the open ones'
 * count while any is open, else the merged ones', else the closed ones'.
 * Nothing when no pull request mentions the task.
 */
export function TaskPullRequestChip({ counts, className }: TaskPullRequestChipProps) {
  if (!counts) {
    return null
  }
  const state: TaskPullRequestState | null = counts.open > 0 ? 'open' : counts.merged > 0 ? 'merged' : counts.closed > 0 ? 'closed' : null
  if (!state) {
    return null
  }
  const count = counts[state]
  const { icon: Icon, soft, label } = STATE[state]
  const all = [counts.open && `${counts.open} open`, counts.merged && `${counts.merged} merged`, counts.closed && `${counts.closed} closed`].filter(Boolean).join(', ')
  return (
    <span
      data-slot='task-pull-request-chip'
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums', soft, className)}
      title={`Pull requests: ${all}`}
    >
      <Icon aria-hidden='true' className='size-3 shrink-0' />
      {count}
      <span className='sr-only'>
        {label.toLowerCase()} pull {count === 1 ? 'request' : 'requests'} ({all})
      </span>
    </span>
  )
}
