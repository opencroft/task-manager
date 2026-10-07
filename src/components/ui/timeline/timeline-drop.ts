import { type DropZone, isScheduled, placementFor, type TaskPlacement, type TimelineTask } from './timeline-model'
import { type CalendarDate, DEFAULT_SPAN_DAYS, fromDay, toDay } from './timeline-scale'

// What a finished drag means on the timeline, as a list of changes to make.
// One place decides it for every source (a bar, a tree row, a backlog item)
// and every target (the scale, a row, the backlog), so the three lists cannot
// disagree about what a drop does. Pure and DOM-free.

export type DragSource = 'bar' | 'row' | 'backlog'

export type DropTarget =
  | { kind: 'scale'; day: number }
  | { kind: 'row'; key: string; zone: DropZone }
  | { kind: 'backlog-item'; key: string; zone: 'before' | 'after' }
  | { kind: 'backlog' }

export type TimelineChange =
  | { type: 'schedule'; key: string; start: CalendarDate; end: CalendarDate }
  | { type: 'unschedule'; key: string }
  | { type: 'move'; key: string; placement: TaskPlacement }

export interface DropInput {
  tasks: TimelineTask[]
  key: string
  source: DragSource
  target: DropTarget | null
  /** For a dragged bar: how many whole days it moved. */
  shiftDays?: number
}

/**
 * The changes a drop makes.
 * - On the scale: a bar shifts by the days it moved; anything else is scheduled
 *   from the drop day, keeping its length if it had dates, else for the default length.
 * - On a tree row: reorder or nest (a bar never reorders — it only changes dates).
 * - On the backlog: unschedule, and on an item also take its place in the order.
 */
export function changesForDrop({ tasks, key, source, target, shiftDays = 0 }: DropInput): TimelineChange[] {
  const task = tasks.find((t) => t.key === key)
  if (!task || !target) {
    return []
  }
  const unschedule: TimelineChange[] = isScheduled(task) ? [{ type: 'unschedule', key }] : []
  switch (target.kind) {
    case 'scale': {
      if (source === 'bar') {
        if (!isScheduled(task) || shiftDays === 0) {
          return []
        }
        const start = toDay(task.startDate) + shiftDays
        const end = toDay(task.endDate) + shiftDays
        return [{ type: 'schedule', key, start: fromDay(start), end: fromDay(end) }]
      }
      const length = isScheduled(task) ? toDay(task.endDate) - toDay(task.startDate) : DEFAULT_SPAN_DAYS - 1
      if (isScheduled(task) && toDay(task.startDate) === target.day) {
        return []
      }
      return [{ type: 'schedule', key, start: fromDay(target.day), end: fromDay(target.day + length) }]
    }
    case 'row': {
      if (source === 'bar' || target.key === key) {
        return []
      }
      const targetTask = tasks.find((t) => t.key === target.key)
      const placement = targetTask ? placementFor(tasks, key, targetTask, target.zone) : null
      return placement ? [{ type: 'move', key, placement }] : []
    }
    case 'backlog-item': {
      if (target.key === key) {
        return unschedule
      }
      return [...unschedule, { type: 'move', key, placement: { [target.zone]: target.key } }]
    }
    case 'backlog':
      return unschedule
  }
}
