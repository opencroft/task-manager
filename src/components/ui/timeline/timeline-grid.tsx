import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { isWeekend, showsWeekends, ticks, tiersFor } from './timeline-scale'

export interface TimelineGridProps {
  /** Day number at x = 0 of the scale. */
  origin: number
  pxPerDay: number
  /** The day range to draw, usually the visible window plus a margin. `to` is exclusive. */
  from: number
  to: number
  today: number
  /** A drop position to show while something is dragged over the scale. */
  marker?: { day: number; label: string }
  className?: string
  style?: CSSProperties
}

/**
 * The scale's background behind the task lanes: a line at each header
 * division, weekends shaded once days are wide enough to see, today's column
 * and line, and the drop marker during a drag.
 */
export function TimelineGrid({ origin, pxPerDay, from, to, today, marker, className, style }: TimelineGridProps) {
  const x = (day: number) => (day - origin) * pxPerDay
  const divisions = ticks(tiersFor(pxPerDay).bottom, from, to, pxPerDay, 'bottom')
  const weekends = showsWeekends(pxPerDay)
    ? Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i).filter(isWeekend)
    : []
  return (
    <div aria-hidden className={cn('pointer-events-none overflow-hidden', className)} style={style}>
      {weekends.map((day) => (
        <div key={`we-${day}`} className='absolute inset-y-0 bg-muted/60' style={{ left: x(day), width: pxPerDay }} />
      ))}
      {divisions.map((tick) => (
        <div key={`div-${tick.start}`} className='absolute inset-y-0 border-l border-border/60' style={{ left: x(tick.start) }} />
      ))}
      <div className='absolute inset-y-0 bg-primary/5' style={{ left: x(today), width: pxPerDay }} />
      <div className='absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary/70' style={{ left: x(today) + pxPerDay / 2 }} />
      {marker && (
        <div className='absolute inset-y-0 border-l-2 border-dashed border-primary' style={{ left: x(marker.day) }}>
          <span className='mt-1 ml-1 inline-block rounded bg-primary px-1.5 py-0.5 text-[11px] whitespace-nowrap text-primary-foreground'>
            {marker.label}
          </span>
        </div>
      )}
    </div>
  )
}
