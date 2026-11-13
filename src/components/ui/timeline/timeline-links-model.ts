import { type CalendarDate, fromDay, toDay } from './timeline-scale'

// Dependencies between tasks ("blocks"), as pure rules shared by the timeline's
// link layer, a task's menu ("Move after blocker") and the board's blocked chip.
// No React, no DOM. Lookups are plain records rather than Map: the design
// kit's preview runtime has an icon named `Map` in its shared scope.

/** `from` blocks `to`: `to` should not start until `from` is done. */
export interface TimelineLink {
  from: string
  to: string
}

/** The fields the rules read; any task shape with these passes as it is. */
export interface LinkedTask {
  key: string
  startDate: CalendarDate | null
  endDate: CalendarDate | null
  status?: { category: 'todo' | 'in_progress' | 'done' }
}

/** A stable id for a link, for React keys and sets. */
export function linkId(link: TimelineLink): string {
  return `${link.from}>${link.to}`
}

/**
 * The blocked task is scheduled to start on or before its blocker's last day.
 * Dates are whole days and the end day is included, so starting the day after
 * the blocker ends is fine. Unscheduled on either side is never a conflict.
 */
export function linkConflict(
  blocker: Pick<LinkedTask, 'startDate' | 'endDate'>,
  blocked: Pick<LinkedTask, 'startDate' | 'endDate'>,
): boolean {
  if (blocker.endDate === null || blocked.startDate === null) {
    return false
  }
  return toDay(blocked.startDate) <= toDay(blocker.endDate)
}

function byKey<T extends { key: string }>(tasks: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const task of tasks) {
    out[task.key] = task
  }
  return out
}

/** The ids (`linkId`) of every link in conflict. A link to a task not in `tasks` is skipped. */
export function linkConflicts(tasks: LinkedTask[], links: TimelineLink[]): Set<string> {
  const index = byKey(tasks)
  const out = new Set<string>()
  for (const link of links) {
    const blocker = index[link.from]
    const blocked = index[link.to]
    if (blocker && blocked && linkConflict(blocker, blocked)) {
      out.add(linkId(link))
    }
  }
  return out
}

/** The keys of `key`'s blockers that are not done yet, in link order. A blocker not in `tasks` counts as open. */
export function openBlockers(key: string, tasks: LinkedTask[], links: TimelineLink[]): string[] {
  const index = byKey(tasks)
  return links.filter((link) => link.to === key && index[link.from]?.status?.category !== 'done').map((link) => link.from)
}

/**
 * For each task with a scheduled blocker, the day number its last scheduled
 * blocker ends on. One pass over the tasks and links, so a surface builds it
 * once per change of either and asks `moveAfterBlockers` for any task.
 */
export function latestBlockerEnds(tasks: LinkedTask[], links: TimelineLink[]): Record<string, number> {
  const index = byKey(tasks)
  const out: Record<string, number> = {}
  for (const link of links) {
    const end = Object.hasOwn(index, link.from) ? index[link.from].endDate : null
    if (end) {
      out[link.to] = Object.hasOwn(out, link.to) ? Math.max(out[link.to], toDay(end)) : toDay(end)
    }
  }
  return out
}

/**
 * The dates that move `task` to start the day after its last scheduled blocker
 * ends, keeping its length, from `latestBlockerEnds` over the same tasks and
 * links. Null when it has no dates, no scheduled blocker, or already starts
 * after them all.
 */
export function moveAfterBlockers(
  task: LinkedTask,
  blockerEnds: Record<string, number>,
): { start: CalendarDate; end: CalendarDate } | null {
  if (task.startDate === null || task.endDate === null || !Object.hasOwn(blockerEnds, task.key)) {
    return null
  }
  const latest = blockerEnds[task.key]
  const start = toDay(task.startDate)
  if (start > latest) {
    return null
  }
  const length = toDay(task.endDate) - start
  return { start: fromDay(latest + 1), end: fromDay(latest + 1 + length) }
}
