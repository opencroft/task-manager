import { type PointerEvent, useState } from 'react'

import { cn } from '@/lib/utils'

import type { StatusCategory, TimelineTask } from './timeline-model'
import { type CalendarDate, formatRange, fromDay, toDay } from './timeline-scale'

const TONE: Record<StatusCategory, string> = {
  todo: 'border-muted-foreground/30 bg-muted-foreground/15 text-foreground',
  // Dark text on a light tint (light text on a deep one in dark mode), so the label reads at 4.5:1 or better.
  in_progress: 'border-sky-500/50 bg-sky-200 text-sky-950 dark:border-sky-400/40 dark:bg-sky-900 dark:text-sky-50',
  done: 'border-emerald-500/50 bg-emerald-200 text-emerald-950 dark:border-emerald-400/40 dark:bg-emerald-900 dark:text-emerald-50',
}

export interface TimelineBarProps {
  task: TimelineTask & { startDate: CalendarDate; endDate: CalendarDate }
  /** Day number at x = 0 of the scale. */
  origin: number
  pxPerDay: number
  selected?: boolean
  /** While this bar is dragged over the scale: how many whole days it has moved. */
  dragShiftDays?: number
  /** True while this bar is dragged off the scale (over the backlog): it stays put and fades. */
  detached?: boolean
  /** Starts a drag of the bar's body; the surrounding timeline runs it. */
  onDragStart?: (event: PointerEvent<HTMLElement>) => void
  /** A new range from dragging an edge, snapped to whole days, end inclusive. */
  onResize: (start: CalendarDate, end: CalendarDate) => void
  /** Starts drawing a dependency out of the bar's end, from the round handle past it; the timeline runs it. Without it there is no handle. */
  onLinkStart?: (event: PointerEvent<HTMLElement>) => void
  /**
   * The scale is shown without the task tree beside it: the label leads with the task's key, and the bar is a
   * button for assistive tech, named by key, summary and dates. Beside the tree the bar is hidden from assistive
   * tech, since the tree's row already names the task and its dates.
   */
  standalone?: boolean
  onSelect?: () => void
  onOpen?: () => void
}

type Edge = 'start' | 'end'

/**
 * A scheduled task on the scale. Drag the body to move it (the timeline runs
 * the drag, so it can also end on the backlog); drag either edge to change its
 * dates. Every change snaps to whole days, and the new range shows above the
 * bar while it moves.
 */
export function TimelineBar({
  task,
  origin,
  pxPerDay,
  selected,
  dragShiftDays,
  detached,
  onDragStart,
  onResize,
  onLinkStart,
  standalone = false,
  onSelect,
  onOpen,
}: TimelineBarProps) {
  const [resize, setResize] = useState<{ edge: Edge; startX: number; delta: number } | null>(null)

  const start = toDay(task.startDate)
  const end = toDay(task.endDate)
  const dragging = dragShiftDays !== undefined && !detached
  let from = start + (dragging ? dragShiftDays : 0)
  let to = end + (dragging ? dragShiftDays : 0)
  if (resize) {
    const delta = Math.round(resize.delta / pxPerDay)
    from = resize.edge === 'start' ? Math.min(start + delta, end) : start
    to = resize.edge === 'end' ? Math.max(end + delta, start) : end
  }
  const moving = dragging || resize !== null
  const width = Math.max(4, (to - from + 1) * pxPerDay)
  // Too short to hold its label, the bar shows it beside itself; a label led by the key needs more room.
  const labelBeside = width < (standalone ? 180 : 56)
  const range = formatRange(fromDay(from), fromDay(to))

  const onEdgeDown = (edge: Edge) => (event: PointerEvent<HTMLSpanElement>) => {
    // Resizing is for mouse and pen; on touch the menu's Move carries it.
    if (event.button !== 0 || event.pointerType === 'touch') {
      return
    }
    // The edge is the resize handle; keep the body's drag from starting.
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setResize({ edge, startX: event.clientX, delta: 0 })
  }
  const onEdgeMove = (event: PointerEvent<HTMLSpanElement>) => {
    setResize((r) => (r ? { ...r, delta: event.clientX - r.startX } : r))
  }
  const onEdgeUp = () => {
    if (resize && (from !== start || to !== end)) {
      onResize(fromDay(from), fromDay(to))
    }
    setResize(null)
  }

  return (
    <div
      onPointerDown={onDragStart}
      data-slot='timeline-bar'
      data-key={task.key}
      {...(standalone ? { role: 'button', 'aria-label': `${task.key} ${task.summary}, ${range}` } : { 'aria-hidden': true })}
      title={`${task.summary}\n${range}`}
      onClick={(event) => {
        event.stopPropagation()
        onSelect?.()
      }}
      onDoubleClick={onOpen}
      className={cn(
        'group/bar absolute top-1 flex h-5 cursor-grab items-center rounded-md border text-xs shadow-xs outline-none select-none',
        TONE[task.status.category],
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
        moving && 'z-20 cursor-grabbing shadow-md',
        detached && 'opacity-40',
      )}
      style={{ left: (from - origin) * pxPerDay, width }}
    >
      <span
        className='absolute inset-y-0 -left-1 w-2.5 cursor-ew-resize rounded-l-md group-hover/bar:bg-foreground/10'
        onPointerDown={onEdgeDown('start')}
        onPointerMove={onEdgeMove}
        onPointerUp={onEdgeUp}
        onPointerCancel={() => setResize(null)}
      />
      <span className={cn('truncate px-2', labelBeside && 'sr-only')}>
        {standalone && <span className='mr-1.5 font-mono opacity-70'>{task.key}</span>}
        {task.summary}
      </span>
      <span
        className='absolute inset-y-0 -right-1 w-2.5 cursor-ew-resize rounded-r-md group-hover/bar:bg-foreground/10'
        onPointerDown={onEdgeDown('end')}
        onPointerMove={onEdgeMove}
        onPointerUp={onEdgeUp}
        onPointerCancel={() => setResize(null)}
      />
      {onLinkStart && !moving && (
        <span
          role='presentation'
          title='Drag onto the task this one blocks'
          className={cn(
            'absolute top-1/2 -right-4 size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-primary bg-background opacity-0 transition-opacity group-hover/bar:opacity-100',
            selected && 'opacity-100',
          )}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.pointerType === 'touch') {
              return
            }
            // The handle draws a link; keep the body's drag and the edge's resize from starting.
            event.stopPropagation()
            onLinkStart(event)
          }}
        />
      )}
      {labelBeside && !moving && (
        <span className={cn('pointer-events-none absolute left-full truncate whitespace-nowrap text-foreground', onLinkStart ? 'ml-5' : 'ml-1.5')}>
          {standalone && <span className='mr-1.5 font-mono text-muted-foreground'>{task.key}</span>}
          {task.summary}
        </span>
      )}
      {moving && (
        <span className='pointer-events-none absolute -top-5 left-0 rounded bg-foreground px-1.5 py-0.5 text-[11px] whitespace-nowrap text-background'>
          {range}
        </span>
      )}
    </div>
  )
}

export interface TimelineSpanProps {
  start: CalendarDate
  end: CalendarDate
  origin: number
  pxPerDay: number
}

/** A parent's span, rolled up from its children: a thin bracket under the row. Display only. */
export function TimelineSpan({ start, end, origin, pxPerDay }: TimelineSpanProps) {
  const from = toDay(start)
  const width = Math.max(4, (toDay(end) - from + 1) * pxPerDay)
  return (
    <div
      aria-hidden
      title={`Subtasks: ${formatRange(start, end)}`}
      className='pointer-events-none absolute bottom-0.5 h-1.5 rounded-sm border-x-2 border-foreground/50 bg-foreground/25'
      style={{ left: (from - origin) * pxPerDay, width }}
    />
  )
}
