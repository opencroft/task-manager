import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { type CalendarDate, dayLabel, toDay } from './timeline-scale'

/** A version at a date: a planned one at its target date, a released one at its release date. */
export interface TimelineVersionMarker {
  id: string
  name: string
  /** `YYYY-MM-DD`. */
  date: CalendarDate
  state: 'planned' | 'released'
}

export interface TimelineVersionMarkersProps {
  markers: readonly TimelineVersionMarker[]
  /** The scale's first day and its width per day, as the grid takes them. */
  origin: number
  pxPerDay: number
  /** The days in view (with a margin); markers outside are not drawn. */
  from: number
  to: number
  /** `lines` down the lanes, or the name `flags` for the header. */
  part: 'lines' | 'flags'
  className?: string
  style?: CSSProperties
}

/**
 * Versions on the scale, as two layers of one component: `lines` (placed
 * over the lanes, like the links layer) and `flags` (placed in the sticky
 * header, under the tree column). A marker sits in the middle of its day.
 * Planned is dashed in the primary colour, released solid green. Neither
 * layer takes the pointer.
 */
export function TimelineVersionMarkers({ markers, origin, pxPerDay, from, to, part, className, style }: TimelineVersionMarkersProps) {
  const shown = markers
    .map((marker) => ({ marker, day: toDay(marker.date) }))
    .filter(({ day }) => day >= from && day <= to)
  return (
    <div data-slot={`timeline-version-${part}`} aria-hidden={part === 'lines' ? true : undefined} className={cn('pointer-events-none', className)} style={style}>
      {shown.map(({ marker, day }) => {
        const left = (day - origin + 0.5) * pxPerDay
        const released = marker.state === 'released'
        const when = `${released ? 'Released' : 'Planned for'} ${dayLabel(day)}`
        return part === 'lines' ? (
          <div
            key={marker.id}
            data-state={marker.state}
            className={cn('absolute inset-y-0 w-0 border-l', released ? 'border-emerald-500/70' : 'border-dashed border-primary/60')}
            style={{ left }}
          />
        ) : (
          <span
            key={marker.id}
            data-state={marker.state}
            role='img'
            aria-label={`Version ${marker.name}, ${when.toLowerCase()}`}
            title={`${marker.name} · ${when}`}
            className={cn(
              'absolute bottom-0.5 flex h-4 max-w-40 items-center rounded-sm px-1 font-mono text-[10px] leading-none whitespace-nowrap shadow-xs',
              released ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-500/40 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-background text-primary ring-1 ring-primary/40',
            )}
            // The flag starts at the line, so it reads as the line's label.
            style={{ left: left - 1 }}
          >
            <span className='truncate'>{marker.name}</span>
          </span>
        )
      })}
    </div>
  )
}
