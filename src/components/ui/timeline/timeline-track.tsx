import { type PointerEvent, useState } from 'react'

import { TaskContextMenu, type TaskMenuProps } from '@/components/ui/tasks/task-menu'
import { cn } from '@/lib/utils'

import { TimelineBar, TimelineSpan } from './timeline-bar'
import { isScheduled, type TimelineTask } from './timeline-model'
import { type CalendarDate, formatRange, fromDay } from './timeline-scale'

export interface TimelineTrackProps {
  task: TimelineTask
  /** Day number at x = 0 of the scale. */
  origin: number
  pxPerDay: number
  width: number
  selected?: boolean
  /** The rolled-up span of this task's subtasks, when it has scheduled ones. */
  childSpan?: { start: CalendarDate; end: CalendarDate }
  /** While this task's bar is dragged over the scale: how many whole days it has moved. */
  barShiftDays?: number
  /** True while this task's bar is dragged off the scale. */
  barDetached?: boolean
  menu: TaskMenuProps
  /** Starts a drag of the bar; the surrounding timeline runs it. */
  onBarDragStart?: (event: PointerEvent<HTMLElement>) => void
  /** Starts drawing a dependency out of the bar's end; the surrounding timeline runs it. */
  onBarLinkStart?: (event: PointerEvent<HTMLElement>) => void
  /**
   * The scale without the task tree beside it, as on a phone: the bar leads with
   * the task's key and a press on it opens the task, an unscheduled lane names
   * its task, and a press on the lane selects nothing (it is a scroll).
   */
  compact?: boolean
  onSchedule: (start: CalendarDate, end: CalendarDate) => void
  onSelect: () => void
  onOpen: () => void
}

/**
 * One task's lane on the scale: its bar, its subtasks' span, and — while it
 * has no dates — room to draw it: press on the lane and drag across the days
 * it should take.
 */
export function TimelineTrack({
  task,
  origin,
  pxPerDay,
  width,
  selected,
  childSpan,
  barShiftDays,
  barDetached,
  menu,
  onBarDragStart,
  onBarLinkStart,
  compact = false,
  onSchedule,
  onSelect,
  onOpen,
}: TimelineTrackProps) {
  const [draw, setDraw] = useState<{ anchor: number; current: number } | null>(null)
  const scheduled = isScheduled(task)

  const dayAt = (event: PointerEvent<HTMLDivElement>) =>
    origin + Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / pxPerDay)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!compact) {
      onSelect()
    }
    // Drawing is for mouse and pen; on touch a press on the lane scrolls.
    if (scheduled || event.button !== 0 || event.pointerType === 'touch' || event.target !== event.currentTarget) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const day = dayAt(event)
    setDraw({ anchor: day, current: day })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draw) {
      const day = dayAt(event)
      if (day !== draw.current) {
        setDraw({ ...draw, current: day })
      }
    }
  }
  const onPointerUp = () => {
    // A press without a drag only selects; drawing needs at least two days.
    if (draw && draw.current !== draw.anchor) {
      onSchedule(fromDay(Math.min(draw.anchor, draw.current)), fromDay(Math.max(draw.anchor, draw.current)))
    }
    setDraw(null)
  }

  const drawFrom = draw ? Math.min(draw.anchor, draw.current) : 0
  const drawTo = draw ? Math.max(draw.anchor, draw.current) : 0

  return (
    <TaskContextMenu
      {...menu}
      render={
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDraw(null)}
          onDoubleClick={(event) => event.target === event.currentTarget && onOpen()}
          style={{ width }}
        />
      }
      className={cn('relative h-8', !scheduled && 'cursor-crosshair', selected && 'bg-accent/40')}
    >
        {childSpan && <TimelineSpan start={childSpan.start} end={childSpan.end} origin={origin} pxPerDay={pxPerDay} />}
        {compact && !scheduled && (
          <span className='pointer-events-none sticky left-3 inline-flex h-8 max-w-[80vw] items-center gap-1.5 truncate text-xs text-muted-foreground'>
            <span className='font-mono'>{task.key}</span>
            <span className='truncate'>{task.summary}</span>
          </span>
        )}
        {scheduled && (
          <TimelineBar
            task={task}
            origin={origin}
            pxPerDay={pxPerDay}
            selected={selected}
            dragShiftDays={barShiftDays}
            detached={barDetached}
            onDragStart={onBarDragStart}
            onLinkStart={onBarLinkStart}
            standalone={compact}
            onResize={onSchedule}
            onSelect={compact ? onOpen : onSelect}
            onOpen={onOpen}
          />
        )}
        {draw && (
          <div
            className='pointer-events-none absolute top-1 flex h-5 items-center rounded-md border border-dashed border-primary bg-primary/15'
            style={{ left: (drawFrom - origin) * pxPerDay, width: (drawTo - drawFrom + 1) * pxPerDay }}
          >
            <span className='absolute -top-5 left-0 rounded bg-foreground px-1.5 py-0.5 text-[11px] whitespace-nowrap text-background'>
              {formatRange(fromDay(drawFrom), fromDay(drawTo))}
            </span>
          </div>
        )}
    </TaskContextMenu>
  )
}
