import { type DropZone, isScheduled, placementFor, type TaskPlacement, type TimelineTask } from './timeline-model'
import { type CalendarDate, DEFAULT_SPAN_DAYS, fromDay, toDay } from './timeline-scale'

// What a finished drag means on the timeline, as a list of changes to make.
// One place decides it for every source (a bar, a tree row, a backlog item)
// and every target (the scale, a row, the tree's empty end, the backlog), so
// the lists cannot disagree about what a drop does. Pure and DOM-free.

export type DragSource = 'bar' | 'row' | 'backlog'

export type DropTarget =
  | { kind: 'scale'; day: number }
  | { kind: 'row'; key: string; zone: DropZone }
  /** The tree column past its last row (its create row, or the space below). */
  | { kind: 'tree-end' }
  | { kind: 'backlog-item'; key: string; zone: 'before' | 'after' }
  | { kind: 'backlog' }

export type TimelineChange =
  | { type: 'schedule'; key: string; start: CalendarDate; end: CalendarDate }
  | { type: 'unschedule'; key: string }
  | { type: 'move'; key: string; placement: TaskPlacement }
  /**
   * A backlog task joins the tree's list: with the dates it was dropped on,
   * or at a place in the tree, or (neither) where the host puts new members.
   */
  | { type: 'join'; key: string; start?: CalendarDate; end?: CalendarDate; placement?: TaskPlacement }
  /** A tree task leaves for the backlog, its dates as they are; next to an item when dropped on one. */
  | { type: 'leave'; key: string; placement?: TaskPlacement }

export interface DropInput {
  /** The tree's tasks. */
  tasks: TimelineTask[]
  /** The backlog's tasks; no task is in both lists. */
  backlog: TimelineTask[]
  key: string
  source: DragSource
  target: DropTarget | null
  /** For a dragged bar: how many whole days it moved. */
  shiftDays?: number
}

/**
 * The changes a drop makes.
 * - Within the tree and the scale: a bar shifts by the days it moved, a row
 *   dropped on the scale is scheduled from that day, a row dropped on a row
 *   reorders or nests (a bar never reorders: it only changes dates).
 * - Backlog to tree or scale: the task joins the tree's list, scheduled from
 *   the drop day (keeping its length, or the default length when undated) or
 *   placed by the row it lands on.
 * - Tree or scale to backlog: the task leaves, its dates untouched, and takes
 *   its place next to the item it lands on.
 * - Within the backlog: reorder.
 */
export function changesForDrop({ tasks, backlog, key, source, target, shiftDays = 0 }: DropInput): TimelineChange[] {
  const fromBacklog = source === 'backlog'
  const task = (fromBacklog ? backlog : tasks).find((t) => t.key === key)
  if (!task || !target) {
    return []
  }
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
      const dates = { start: fromDay(target.day), end: fromDay(target.day + length) }
      if (fromBacklog) {
        return [{ type: 'join', key, ...dates }]
      }
      return isScheduled(task) && toDay(task.startDate) === target.day ? [] : [{ type: 'schedule', key, ...dates }]
    }
    case 'row': {
      if (source === 'bar' || target.key === key) {
        return []
      }
      const targetTask = tasks.find((t) => t.key === target.key)
      const placement = targetTask ? placementFor(tasks, key, targetTask, target.zone) : null
      if (!placement) {
        return []
      }
      return fromBacklog ? [{ type: 'join', key, placement }] : [{ type: 'move', key, placement }]
    }
    case 'tree-end':
      return fromBacklog ? [{ type: 'join', key }] : []
    case 'backlog-item': {
      if (target.key === key) {
        return []
      }
      const placement = { [target.zone]: target.key }
      return fromBacklog ? [{ type: 'move', key, placement }] : [{ type: 'leave', key, placement }]
    }
    case 'backlog':
      return fromBacklog ? [] : [{ type: 'leave', key }]
  }
}
