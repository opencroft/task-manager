import { type CalendarDate, fromDay, toDay } from './timeline-scale'

// What the timeline renders, derived from a flat task list: the visible tree
// rows, each parent's span rolled up from its children, the backlog, and where
// a drop on the tree lands. Pure and DOM-free.
//
// Lookups are plain records rather than Map: the design kit's preview runtime
// resolves names in one shared scope where an icon named `Map` shadows the global.

export type StatusCategory = 'todo' | 'in_progress' | 'done'

/** One task as the timeline needs it. Any task list maps onto this shape field by field. */
export interface TimelineTask {
  key: string
  summary: string
  parentKey: string | null
  /** Sibling and backlog order: compared as strings, lowest first. */
  rank: string
  startDate: CalendarDate | null
  endDate: CalendarDate | null
  status: { name: string; category: StatusCategory; color?: string | null }
  assignee: { kind: 'agent' | 'person'; name: string } | null
}

export type TimelineRow =
  | { kind: 'task'; task: TimelineTask; depth: number; hasChildren: boolean; expanded: boolean }
  | { kind: 'create'; parentKey: string | null; depth: number }

/**
 * Where a moved task lands: under which parent (omitted = the one it has), and
 * next to which task in rank order (neither = last).
 */
export interface TaskPlacement {
  parent?: string | null
  before?: string
  after?: string
}

export function isScheduled(task: TimelineTask): task is TimelineTask & { startDate: string; endDate: string } {
  return task.startDate !== null && task.endDate !== null
}

function byRank(a: TimelineTask, b: TimelineTask): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0
}

/** The key `childrenByParent` files top-level tasks under. Task keys are never empty. */
export const ROOT = ''

/**
 * Children by parent key, each list in rank order; top-level tasks under
 * `ROOT`. A parent missing from the list counts as the root.
 */
export function childrenByParent(tasks: TimelineTask[]): Record<string, TimelineTask[]> {
  const keys = new Set(tasks.map((t) => t.key))
  const out: Record<string, TimelineTask[]> = {}
  for (const task of tasks) {
    const parent = task.parentKey !== null && keys.has(task.parentKey) ? task.parentKey : ROOT
    const list = out[parent]
    if (list) {
      list.push(task)
    } else {
      out[parent] = [task]
    }
  }
  for (const list of Object.values(out)) {
    list.sort(byRank)
  }
  return out
}

/**
 * The rows the tree shows, top to bottom: each task, then — when expanded —
 * its children and a create row for a new subtask. `addingUnder` opens a create
 * row under a task that has no children yet. The list ends with a create row
 * for a new top-level task.
 */
/** What a key pressed in the tree does to its rows. */
export type TreeKeyIntent =
  | { kind: 'select'; key: string }
  | { kind: 'toggle'; key: string }
  | { kind: 'open'; key: string }
  | { kind: 'delete'; key: string }

/**
 * The tree's keys: arrows move the selection (up, down, into a folded row, out
 * to the parent), Enter opens the selected task and Delete or Backspace asks
 * to delete it. Null for a key the tree leaves alone.
 */
export function treeKeyIntent(key: string, rows: readonly TimelineRow[], selected: string | null): TreeKeyIntent | null {
  const taskRows = rows.flatMap((row) => (row.kind === 'task' ? [row] : []))
  const index = taskRows.findIndex((row) => row.task.key === selected)
  const current = index >= 0 ? taskRows[index] : null
  switch (key) {
    case 'ArrowDown':
      return taskRows.length > 0 ? { kind: 'select', key: taskRows[Math.min(taskRows.length - 1, index + 1)].task.key } : null
    case 'ArrowUp':
      return taskRows.length > 0 ? { kind: 'select', key: taskRows[Math.max(0, index - 1)].task.key } : null
    case 'ArrowRight':
      return current?.hasChildren && !current.expanded ? { kind: 'toggle', key: current.task.key } : null
    case 'ArrowLeft':
      if (current?.hasChildren && current.expanded) {
        return { kind: 'toggle', key: current.task.key }
      }
      return current?.task.parentKey ? { kind: 'select', key: current.task.parentKey } : null
    case 'Enter':
      return selected ? { kind: 'open', key: selected } : null
    case 'Delete':
    case 'Backspace':
      return selected ? { kind: 'delete', key: selected } : null
  }
  return null
}

export function visibleRows(tasks: TimelineTask[], expanded: ReadonlySet<string>, addingUnder: string | null): TimelineRow[] {
  const children = childrenByParent(tasks)
  const rows: TimelineRow[] = []
  const walk = (parent: string, depth: number) => {
    for (const task of children[parent] ?? []) {
      const hasChildren = task.key in children
      const isOpen = (hasChildren && expanded.has(task.key)) || addingUnder === task.key
      rows.push({ kind: 'task', task, depth, hasChildren, expanded: isOpen })
      if (isOpen) {
        walk(task.key, depth + 1)
        rows.push({ kind: 'create', parentKey: task.key, depth: depth + 1 })
      }
    }
  }
  walk(ROOT, 0)
  rows.push({ kind: 'create', parentKey: null, depth: 0 })
  return rows
}

/** A task row's height in the tree and on the scale, in pixels, its bottom border included. */
export const TASK_ROW_HEIGHT = 33
/** A create row's height, its bottom border included. */
export const CREATE_ROW_HEIGHT = 37

/** Each row's height, in the order `visibleRows` gives them. */
export function rowHeights(rows: readonly TimelineRow[]): number[] {
  return rows.map((row) => (row.kind === 'task' ? TASK_ROW_HEIGHT : CREATE_ROW_HEIGHT))
}

/**
 * The top of every task row, measured from the first row's top, by task key.
 * Arithmetic from the row heights, so it covers rows that are not rendered.
 */
export function rowTops(rows: readonly TimelineRow[]): Record<string, number> {
  const tops: Record<string, number> = {}
  let y = 0
  for (const row of rows) {
    if (row.kind === 'task') {
      tops[row.task.key] = y
    }
    y += row.kind === 'task' ? TASK_ROW_HEIGHT : CREATE_ROW_HEIGHT
  }
  return tops
}

/** For every task with scheduled descendants: the span from the earliest start to the latest end below it. */
export function childSpans(tasks: TimelineTask[]): Record<string, { start: CalendarDate; end: CalendarDate }> {
  const children = childrenByParent(tasks)
  const out: Record<string, { start: CalendarDate; end: CalendarDate }> = {}
  const span = (key: string): { start: number; end: number } | null => {
    let acc: { start: number; end: number } | null = null
    for (const child of children[key] ?? []) {
      const own = isScheduled(child) ? { start: toDay(child.startDate), end: toDay(child.endDate) } : null
      for (const part of [own, span(child.key)]) {
        if (part) {
          acc = acc ? { start: Math.min(acc.start, part.start), end: Math.max(acc.end, part.end) } : part
        }
      }
    }
    if (acc) {
      out[key] = { start: fromDay(acc.start), end: fromDay(acc.end) }
    }
    return acc
  }
  for (const root of children[ROOT] ?? []) {
    span(root.key)
  }
  return out
}

/** Unscheduled tasks at every depth, in backlog (rank) order. */
export function backlogTasks(tasks: TimelineTask[]): TimelineTask[] {
  return tasks.filter((t) => !isScheduled(t)).sort(byRank)
}

/** True when `key` is `ancestor` itself or sits anywhere below it. */
export function isWithin(tasks: TimelineTask[], key: string, ancestor: string): boolean {
  const parentOf: Record<string, string | null> = Object.fromEntries(tasks.map((t) => [t.key, t.parentKey]))
  const seen = new Set<string>()
  for (let at: string | null | undefined = key; at != null && !seen.has(at); at = parentOf[at]) {
    if (at === ancestor) {
      return true
    }
    seen.add(at)
  }
  return false
}

export type DropZone = 'before' | 'inside' | 'after'

/** Which part of a tree row the pointer is over: the top and bottom quarters order, the middle nests. */
export function dropZone(offsetY: number, rowHeight: number): DropZone {
  const f = offsetY / rowHeight
  return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside'
}

/** Where dropping `moving` on a zone of `target` puts it, or null when the drop would nest it inside itself. */
export function placementFor(
  tasks: TimelineTask[],
  moving: string,
  target: TimelineTask,
  zone: DropZone,
): TaskPlacement | null {
  if (isWithin(tasks, target.key, moving)) {
    return null
  }
  if (zone === 'inside') {
    return { parent: target.key }
  }
  return zone === 'before' ? { parent: target.parentKey, before: target.key } : { parent: target.parentKey, after: target.key }
}
