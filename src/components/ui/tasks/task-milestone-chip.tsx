import { Archive, Flag } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** A milestone is open while work is planned into it, and archived once it is put away. */
export type TaskMilestoneState = 'open' | 'archived'

/** One milestone of the project: a planning unit with a free name, unique in the project. The id stays put across a rename. */
export interface TaskMilestone {
  id: string
  name: string
  state: TaskMilestoneState
  /** When work in it starts, `YYYY-MM-DD`; null when not set. */
  startDate?: string | null
  /** When it is meant to be done, `YYYY-MM-DD`; null when not set. */
  targetDate?: string | null
  /** One line on what it is. */
  description?: string | null
  /** Tasks in it that are not done, and that are. */
  openCount?: number
  doneCount?: number
}

export const TASK_MILESTONE_STATE_LABELS: Record<TaskMilestoneState, string> = {
  open: 'Open',
  archived: 'Archived',
}

function day(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A milestone's span as text: "Dec 1 – Dec 20", "From Dec 1", "Due Dec 20", or null with neither date. */
export function milestoneSpanText(milestone: Pick<TaskMilestone, 'startDate' | 'targetDate'>): string | null {
  const { startDate, targetDate } = milestone
  if (startDate && targetDate) {
    return `${day(startDate)} – ${day(targetDate)}`
  }
  if (startDate) {
    return `From ${day(startDate)}`
  }
  return targetDate ? `Due ${day(targetDate)}` : null
}

const VARIANTS = {
  /** On a card: a muted fill. */
  soft: 'bg-muted',
  /** In a table row: a border, no fill. */
  outline: 'border',
} as const

export interface TaskMilestoneChipProps extends Omit<ComponentProps<'span'>, 'children'> {
  name: string
  state?: TaskMilestoneState
  variant?: keyof typeof VARIANTS
}

/**
 * A milestone as a small chip, the same size as a version or label chip: a
 * flag, then the name (truncated). Archived swaps the flag for an archive
 * mark and dims the chip. The state is read out after the name.
 */
export function TaskMilestoneChip({ name, state = 'open', variant = 'soft', className, ...props }: TaskMilestoneChipProps) {
  const Icon = state === 'archived' ? Archive : Flag
  return (
    <span
      data-slot='task-milestone-chip'
      data-state={state}
      title={`${name} · ${TASK_MILESTONE_STATE_LABELS[state]}`}
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground',
        VARIANTS[variant],
        state === 'archived' && 'opacity-60',
        className,
      )}
      {...props}
    >
      <Icon aria-hidden='true' className='size-3 shrink-0' />
      <span className='truncate'>{name}</span>
      {state === 'archived' ? <span className='sr-only'>, archived</span> : null}
    </span>
  )
}

export interface TaskMilestoneOption {
  /** The milestone's id; `''` for "No milestone". */
  value: string
  display: ReactNode
  text: string
}

/**
 * The choices of a milestone picker, in the shape `TaskFieldPicker` takes:
 * "No milestone" (value `''`), then the open milestones in the order given
 * (the host's listing order), each with its span. Archived ones are left out
 * unless `currentId` is one, so a task in an archived milestone still shows it.
 */
export function taskMilestoneOptions(milestones: readonly TaskMilestone[], currentId?: string | null): TaskMilestoneOption[] {
  const shown = milestones.filter((milestone) => milestone.state !== 'archived' || milestone.id === currentId)
  return [
    { value: '', display: <span className='text-muted-foreground'>No milestone</span>, text: 'No milestone' },
    ...shown.map((milestone) => {
      const span = milestoneSpanText(milestone)
      return {
        value: milestone.id,
        display: (
          <span className='flex min-w-0 items-center gap-2'>
            <TaskMilestoneChip name={milestone.name} state={milestone.state} className='max-w-full bg-transparent px-0 text-xs' />
            {span ? <span className='shrink-0 text-xs text-muted-foreground'>{span}</span> : null}
          </span>
        ),
        text: [milestone.name, span, milestone.state === 'archived' ? 'archived' : null].filter(Boolean).join(', '),
      }
    }),
  ]
}
