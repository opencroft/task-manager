import { Archive, CircleCheck, CircleDashed } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Where a version is in its life: work is planned into it, it has shipped, or it is put away. */
export type TaskVersionState = 'planned' | 'released' | 'archived'

/** One version of the project. The name is semver and unique in the project; the id stays put across a rename. */
export interface TaskVersion {
  id: string
  name: string
  state: TaskVersionState
  /** The day it is planned for, `YYYY-MM-DD`; null when not set. */
  targetDate?: string | null
  /** When it was released, `YYYY-MM-DD` or an ISO time; null until then. */
  releasedAt?: string | null
  /** One line on what it is. */
  description?: string | null
  /** Tasks in it that are not done, and that are. */
  openCount?: number
  doneCount?: number
}

export const TASK_VERSION_STATE_LABELS: Record<TaskVersionState, string> = {
  planned: 'Planned',
  released: 'Released',
  archived: 'Archived',
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** Whether `name` is `MAJOR.MINOR.PATCH` with an optional `-pre` (no build metadata), as a version name must be. */
export function isValidVersionName(name: string): boolean {
  return SEMVER.test(name.trim())
}

/**
 * Semver order: negative when `a` comes before `b`. A pre-release sorts before
 * its release (1.4.0-rc.1 before 1.4.0). A name that is not semver sorts
 * after every one that is, by text.
 */
export function compareVersionNames(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim())
  const pb = SEMVER.exec(b.trim())
  if (!pa || !pb) {
    return pa ? -1 : pb ? 1 : a.localeCompare(b)
  }
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) {
      return d
    }
  }
  const preA = pa[4]
  const preB = pb[4]
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1
  }
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1
    }
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    const d = nx && ny ? Number(x) - Number(y) : nx ? -1 : ny ? 1 : x.localeCompare(y)
    if (d !== 0) {
      return d
    }
  }
  return 0
}

/** The order a list shows them in: planned (oldest first), then released (newest first), then archived (newest first). */
export function sortVersions<T extends Pick<TaskVersion, 'name' | 'state'>>(versions: readonly T[]): T[] {
  const rank: Record<TaskVersionState, number> = { planned: 0, released: 1, archived: 2 }
  return [...versions].sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'planned' ? 1 : -1) * compareVersionNames(a.name, b.name))
}

const MARK: Record<TaskVersionState, { icon: typeof CircleDashed; className: string }> = {
  planned: { icon: CircleDashed, className: 'text-muted-foreground' },
  released: { icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-400' },
  archived: { icon: Archive, className: 'text-muted-foreground' },
}

const VARIANTS = {
  /** On a card: a muted fill. */
  soft: 'bg-muted',
  /** In a table row: a border, no fill. */
  outline: 'border',
} as const

export interface TaskVersionChipProps extends Omit<ComponentProps<'span'>, 'children'> {
  name: string
  state?: TaskVersionState
  variant?: keyof typeof VARIANTS
}

/**
 * A version as a small chip, the same size as a label chip: the state as a
 * quiet mark, then the name (monospace, truncated). Archived dims it. The
 * state is read out after the name.
 */
export function TaskVersionChip({ name, state = 'planned', variant = 'soft', className, ...props }: TaskVersionChipProps) {
  const mark = MARK[state]
  const Icon = mark.icon
  return (
    <span
      data-slot='task-version-chip'
      data-state={state}
      title={`${name} · ${TASK_VERSION_STATE_LABELS[state]}`}
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground',
        VARIANTS[variant],
        state === 'archived' && 'opacity-60',
        className,
      )}
      {...props}
    >
      <Icon aria-hidden='true' className={cn('size-3 shrink-0', mark.className)} />
      <span className='truncate'>{name}</span>
      <span className='sr-only'>, {TASK_VERSION_STATE_LABELS[state].toLowerCase()}</span>
    </span>
  )
}

export interface TaskVersionOption {
  /** The version's id; `''` for "No version". */
  value: string
  display: ReactNode
  text: string
}

/**
 * The choices of a version picker, in the shape `TaskFieldPicker` takes:
 * "No version" (value `''`), then the planned versions oldest first, then the
 * released ones newest first. Archived ones are left out unless `currentId`
 * is one, so a task in an archived version still shows it.
 */
export function taskVersionOptions(versions: readonly TaskVersion[], currentId?: string | null): TaskVersionOption[] {
  const shown = sortVersions(versions.filter((version) => version.state !== 'archived' || version.id === currentId))
  return [
    { value: '', display: <span className='text-muted-foreground'>No version</span>, text: 'No version' },
    ...shown.map((version) => ({
      value: version.id,
      display: <TaskVersionChip name={version.name} state={version.state} className='max-w-full bg-transparent px-0 text-xs' />,
      text: `${version.name}, ${TASK_VERSION_STATE_LABELS[version.state].toLowerCase()}`,
    })),
  ]
}
