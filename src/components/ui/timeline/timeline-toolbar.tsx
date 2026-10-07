import { CalendarCheck, CalendarPlus, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../button'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { cn } from '@/lib/utils'

import { dayLabel, periodOf } from './timeline-scale'

export interface ScaleMenuOptions {
  /** The day under the pointer (or today, from the keyboard). */
  day: number
  /** Zoom so the days `from`–`to` (inclusive) fill the scale. */
  onZoomTo: (from: number, to: number) => void
  onFit: () => void
  onToday: () => void
  /** Offers "New task starting …" on that day, on the empty scale. */
  onCreateOn?: (day: number) => void
}

/**
 * The scale's menu, the toolbar's twin for a place on the scale: a new task
 * starting that day, zoom to its week, month or quarter, today, fit.
 */
export function scaleMenuEntries({ day, onZoomTo, onFit, onToday, onCreateOn }: ScaleMenuOptions): ItemMenuEntries {
  const zoom = (unit: 'week' | 'month' | 'quarter') => {
    const period = periodOf(unit, day)
    return { id: `zoom-${unit}`, label: `Zoom to ${period.label}`, icon: ZoomIn, group: 'change' as const, onSelect: () => onZoomTo(period.start, period.end) }
  }
  return [
    onCreateOn && { id: 'create', label: `New task starting ${dayLabel(day)}`, icon: CalendarPlus, group: 'open', onSelect: () => onCreateOn(day) },
    zoom('week'),
    zoom('month'),
    zoom('quarter'),
    { id: 'today', label: 'Go to today', icon: CalendarCheck, onSelect: onToday },
    { id: 'fit', label: 'Fit all scheduled tasks', icon: Maximize2, onSelect: onFit },
  ]
}

export interface TimelineToolbarProps {
  /** The zoom level's name: Days, Weeks, Months or Quarters. */
  zoomLabel: string
  canZoomIn: boolean
  canZoomOut: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onToday: () => void
  /** Extra controls at the start of the bar. */
  children?: ReactNode
  /**
   * `bar` (the default): its own bordered row above the scale.
   * `row`: just the controls, for a TaskManagerToolbar in the App toolbar,
   * which supplies the row, its height and its overflow.
   */
  variant?: 'bar' | 'row'
  className?: string
}

/** Zoom controls for the timeline: out, the current level, in, fit everything scheduled, and jump to today. */
export function TimelineToolbar({
  zoomLabel,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onFit,
  onToday,
  children,
  variant = 'bar',
  className,
}: TimelineToolbarProps) {
  const row = variant === 'row'
  return (
    <div className={cn(row ? 'flex shrink-0 items-center gap-1' : 'flex h-10 shrink-0 items-center gap-1 border-b px-2', className)}>
      {children}
      <div className={cn('flex shrink-0 items-center gap-1', !row && 'ml-auto')}>
        {row ? null : <span className='mr-2 hidden text-xs text-muted-foreground sm:inline'>Ctrl + scroll to zoom</span>}
        <Button variant='ghost' size='icon-sm' aria-label='Zoom out' title='Zoom out' disabled={!canZoomOut} onClick={onZoomOut}>
          <ZoomOut />
        </Button>
        {/* In a row the hint moves to the level's tooltip, so the row stays short. */}
        <span className='w-16 text-center text-xs font-medium tabular-nums' title={row ? 'Ctrl + scroll to zoom' : undefined}>
          {zoomLabel}
        </span>
        <Button variant='ghost' size='icon-sm' aria-label='Zoom in' title='Zoom in' disabled={!canZoomIn} onClick={onZoomIn}>
          <ZoomIn />
        </Button>
        <Button variant='outline' size='sm' onClick={onFit} title='Fit all scheduled tasks'>
          <Maximize2 />
          Fit
        </Button>
        <Button variant='outline' size='sm' onClick={onToday}>
          <CalendarCheck />
          Today
        </Button>
      </div>
    </div>
  )
}
