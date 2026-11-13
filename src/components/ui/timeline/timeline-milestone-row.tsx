import { Flag } from 'lucide-react'

import { cn } from '@/lib/utils'

import { type CalendarDate, formatRange, toDay } from './timeline-scale'

/** The milestone a timeline shows: its name and its optional span. */
export interface TimelineMilestone {
  name: string
  /** `YYYY-MM-DD`; null when not set. */
  startDate?: CalendarDate | null
  /** `YYYY-MM-DD`; null when not set. */
  targetDate?: CalendarDate | null
}

/** The milestone's dates in words: `Dec 1 – Dec 20`, `from Dec 1`, `until Dec 20`, or `no dates`. */
export function milestoneSpanLabel({ startDate, targetDate }: TimelineMilestone): string {
  if (startDate && targetDate) {
    return formatRange(startDate, targetDate)
  }
  if (startDate) {
    return `from ${formatRange(startDate, startDate)}`
  }
  if (targetDate) {
    return `until ${formatRange(targetDate, targetDate)}`
  }
  return 'no dates'
}

export interface TimelineMilestoneCellProps {
  milestone: TimelineMilestone
  className?: string
}

/** The milestone's cell in the task tree's first row: a flag, its name and its dates. */
export function TimelineMilestoneCell({ milestone, className }: TimelineMilestoneCellProps) {
  return (
    <div data-slot='timeline-milestone-cell' className={cn('flex h-full min-w-0 items-center gap-2 px-3 text-sm', className)}>
      <Flag aria-hidden='true' className='size-4 shrink-0 text-primary' />
      <span className='truncate font-medium'>{milestone.name}</span>
      <span className='ml-auto shrink-0 text-xs text-muted-foreground tabular-nums'>{milestoneSpanLabel(milestone)}</span>
    </div>
  )
}

export interface TimelineMilestoneBarProps {
  milestone: TimelineMilestone
  /** Day number at x = 0 of the scale. */
  origin: number
  pxPerDay: number
  /** The scale's width in px; a span open at one end runs to that edge. */
  width: number
  /**
   * The scale without the task tree beside it, as on a phone: the bar is named
   * for assistive tech, since no tree row names the milestone.
   */
  standalone?: boolean
}

/**
 * The milestone's lane on the scale: a bar from its start to its target, drawn
 * like a task's bar. With one date the span is open on the other side, so the
 * bar runs on to that edge of the scale with no end drawn there; with neither
 * the lane is empty. Display only.
 */
export function TimelineMilestoneBar({ milestone, origin, pxPerDay, width, standalone = false }: TimelineMilestoneBarProps) {
  const start = milestone.startDate ? toDay(milestone.startDate) : null
  const target = milestone.targetDate ? toDay(milestone.targetDate) : null
  const label = `${milestone.name}, ${milestoneSpanLabel(milestone)}`
  const left = start === null ? 0 : (start - origin) * pxPerDay
  const right = target === null ? width : (target - origin + 1) * pxPerDay
  return (
    <div data-slot='timeline-milestone-bar' className='relative h-8' style={{ width }}>
      {start !== null || target !== null ? (
        <div
          {...(standalone ? { role: 'img', 'aria-label': `Milestone ${label}` } : { 'aria-hidden': true })}
          title={`Milestone ${label}`}
          className={cn(
            'absolute top-1 flex h-5 items-center gap-1 overflow-hidden border border-primary/50 bg-primary/15 px-2 text-xs font-medium text-foreground shadow-xs',
            start === null ? 'border-l-0' : 'rounded-l-md',
            target === null ? 'border-r-0' : 'rounded-r-md',
          )}
          style={{ left, width: Math.max(4, right - left) }}
        >
          <Flag aria-hidden='true' className='size-3 shrink-0 text-primary' />
          <span className='truncate'>{milestone.name}</span>
        </div>
      ) : null}
    </div>
  )
}
