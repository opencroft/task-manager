import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { ticks, tiersFor } from './timeline-scale'

/** Room kept for an upper-row label when it slides along with the scroll. */
const LABEL_ROOM_PX = 140

export interface TimelineHeaderProps {
  /** First day of the scale (day number); x = 0 sits here. */
  origin: number
  pxPerDay: number
  /** The day range to draw, usually the visible window plus a margin. `to` is exclusive. */
  from: number
  to: number
  /** Today's day number, highlighted when the lower row shows days. */
  today?: number
  /**
   * How far the scale is scrolled, in px. An upper-row label whose span starts
   * before the visible edge slides to stay in view, so the month or year being
   * looked at is always named.
   */
  scrollLeft?: number
  className?: string
  style?: CSSProperties
}

/**
 * The scale's two header rows, which adapt to the zoom: month over days, month
 * over weeks, year over months, year over quarters. Only the ticks inside
 * `from`–`to` are drawn, so a scale years wide stays cheap.
 */
export function TimelineHeader({ origin, pxPerDay, from, to, today, scrollLeft = 0, className, style }: TimelineHeaderProps) {
  const tiers = tiersFor(pxPerDay)
  const rows = [
    { key: 'top', items: ticks(tiers.top, from, to, pxPerDay, 'top') },
    { key: 'bottom', items: ticks(tiers.bottom, from, to, pxPerDay, 'bottom') },
  ]
  return (
    <div className={cn('relative h-12 shrink-0 overflow-hidden text-xs select-none', className)} style={style}>
      {rows.map((row, index) => (
        <div key={row.key} className={cn('absolute inset-x-0 h-6', index === 0 ? 'top-0' : 'top-6 border-t')}>
          {row.items.map((tick) => {
            const left = (tick.start - origin) * pxPerDay
            const width = (tick.end - tick.start) * pxPerDay
            const isToday = tiers.bottom === 'day' && index === 1 && tick.start === today
            const slide = index === 0 ? Math.max(0, Math.min(scrollLeft - left, width - LABEL_ROOM_PX)) : 0
            return (
              <div
                key={tick.start}
                className={cn(
                  'absolute inset-y-0 flex items-center overflow-hidden border-l px-1.5 whitespace-nowrap',
                  index === 0 ? 'font-medium text-foreground' : 'text-muted-foreground',
                  tiers.bottom === 'day' && index === 1 && 'justify-center px-0',
                  isToday && 'font-semibold text-primary',
                )}
                style={{ left, width }}
              >
                <span style={slide > 0 ? { transform: `translateX(${slide}px)` } : undefined}>{tick.label}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
