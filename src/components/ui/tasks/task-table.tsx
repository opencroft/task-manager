import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Checkbox } from '../checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskAssignee, type TaskAssigneeValue } from './task-assignee'
import { TaskLabelChip } from './task-label-chip'
import { type TaskMenuProps, TaskActionsMenu, TaskContextMenu } from './task-menu'
import { type TaskPriority, TaskPriorityIcon } from './task-priority-icon'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskType, TaskTypeIcon } from './task-type-icon'
import { TaskPullRequestChip, type TaskPullRequestCounts } from './task-pull-requests'
import { TaskVersionChip, type TaskVersionState } from './task-version-chip'
import { useWindowedRows } from './use-windowed-rows'

export interface TaskTableRow {
  key: string
  summary: string
  type: TaskType
  priority: TaskPriority
  status: { id: number; name: string; category: TaskStatusCategory; color?: string | null }
  assignee: TaskAssigneeValue | null
  /** Who created the task, for the Reporter column. */
  reporter?: TaskAssigneeValue | null
  parentKey?: string | null
  childCount?: number
  labels?: string[]
  /** The version the task is planned into, for the Version column. */
  version?: { name: string; state: TaskVersionState } | null
  /** The pull requests mentioning the task, by state: a chip after the summary. */
  prs?: TaskPullRequestCounts | null
  startDate?: string | null
  endDate?: string | null
  createdAt?: string
  updatedAt?: string
}

/** Every column the table can show, in the order a picker offers them. */
export const TASK_TABLE_COLUMNS = [
  'type',
  'key',
  'summary',
  'priority',
  'status',
  'assignee',
  'reporter',
  'parent',
  'labels',
  'version',
  'dates',
  'created',
  'updated',
] as const
export type TaskTableColumn = (typeof TASK_TABLE_COLUMNS)[number]

export type TaskTableSortField = 'key' | 'summary' | 'status' | 'type' | 'priority' | 'assignee' | 'reporter' | 'startDate' | 'createdAt' | 'updatedAt'

export interface TaskTableSort {
  field: TaskTableSortField
  dir: 'asc' | 'desc'
}

export interface TaskTableProps {
  rows: TaskTableRow[]
  columns?: TaskTableColumn[]
  /** The active sort; null means the list's own order. */
  sort?: TaskTableSort | null
  /** Header press: sorts by that column, flipping direction on a second press, clearing on a third. */
  onSortChange?: (sort: TaskTableSort | null) => void
  /** Row press. */
  onOpen?: (key: string) => void
  /** The link a key points at, so it can be opened in a new tab. */
  hrefFor?: (key: string) => string
  /** The menu each row carries on right-click and behind its "…" button. */
  menuFor?: (row: TaskTableRow) => TaskMenuProps
  /** A column head's menu on right-click or long press, e.g. sort, hide the column, group by. */
  headerMenu?: (column: TaskTableColumn) => ItemMenuEntries
  /**
   * A cell's own menu, e.g. the status cell's statuses to change it in place.
   * Only that menu opens, not the row's. Give one function for the table's life.
   */
  cellMenu?: (row: TaskTableRow, column: TaskTableColumn) => ItemMenuEntries
  /**
   * Groups the rows under a heading each. The rows come already in group
   * order; a heading is drawn wherever the group changes, at the rows' height.
   */
  groupOf?: (row: TaskTableRow) => { id: string; label: ReactNode }
  /** Drawn under the rows, e.g. an inline create. It stays in view while the rows scroll. */
  footer?: ReactNode
  /** Drawn instead of rows when there are none. */
  empty?: ReactNode
  /** Key of the row to mark as selected. */
  selectedKey?: string | null
  /** Keys picked for a bulk action. Separate from `selectedKey`, the task that is open. */
  selection?: string[]
  /**
   * Turns on the checkbox column. Shift-click on a checkbox or a row takes the
   * range from the last one clicked; Ctrl/Cmd-click on a row toggles it
   * instead of opening it.
   */
  onSelectionChange?: (keys: string[]) => void
  /** The element the rows scroll in, for a host that keeps or restores its scroll position. */
  scrollRef?: Ref<HTMLDivElement>
  className?: string
}

const DEFAULT_COLUMNS: TaskTableColumn[] = ['type', 'key', 'summary', 'priority', 'status', 'assignee', 'reporter', 'created', 'updated']

/** Each column's head: its name, and the field it sorts by, if any. */
export const TASK_TABLE_HEADS: Record<TaskTableColumn, { label: string; sort?: TaskTableSortField }> = {
  type: { label: 'Type', sort: 'type' },
  key: { label: 'Key', sort: 'key' },
  summary: { label: 'Summary', sort: 'summary' },
  priority: { label: 'Priority', sort: 'priority' },
  status: { label: 'Status', sort: 'status' },
  assignee: { label: 'Assignee', sort: 'assignee' },
  reporter: { label: 'Reporter', sort: 'reporter' },
  parent: { label: 'Parent' },
  labels: { label: 'Labels' },
  version: { label: 'Version' },
  dates: { label: 'Dates', sort: 'startDate' },
  created: { label: 'Created', sort: 'createdAt' },
  updated: { label: 'Updated', sort: 'updatedAt' },
}

/**
 * Column widths. Summary takes the width left over, never less than about 40
 * characters (the sizer row's w-80, 20rem); every other column is as wide as
 * its widest value or head (w-px on a no-wrap cell). Too narrow for all of
 * that, the table scrolls sideways rather than cutting a value short.
 */
function widthClass(column: TaskTableColumn): string {
  return column === 'summary' ? 'w-full max-w-0' : 'w-px'
}

function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function relative(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) {
    return 'just now'
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.round(hours / 24)
  if (days < 30) {
    return `${days}d ago`
  }
  return new Date(iso).toLocaleDateString()
}

function SortGlyph({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) {
    return <ArrowUpDown className="size-3.5 opacity-0 transition-opacity group-hover/head:opacity-60" />
  }
  return dir === 'asc' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />
}

function Cell({ column, row, hrefFor }: { column: TaskTableColumn; row: TaskTableRow; hrefFor?: (key: string) => string }) {
  switch (column) {
    case 'type':
      return <TaskTypeIcon type={row.type} />
    case 'key':
      return hrefFor ? (
        <a
          href={hrefFor(row.key)}
          onClick={(event) => event.stopPropagation()}
          className="rounded-sm font-mono text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {row.key}
        </a>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
      )
    case 'summary':
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{row.summary}</span>
          {row.childCount ? (
            <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums" title={`${row.childCount} subtasks`}>
              {row.childCount}
            </span>
          ) : null}
          <TaskPullRequestChip counts={row.prs} />
        </span>
      )
    case 'status':
      return <TaskStatusBadge name={row.status.name} category={row.status.category} color={row.status.color} size="sm" />
    case 'priority':
      return <TaskPriorityIcon priority={row.priority} withLabel className="text-muted-foreground" />
    case 'assignee':
      return <TaskAssignee assignee={row.assignee} withName size="sm" />
    case 'reporter':
      return row.reporter ? <TaskAssignee assignee={row.reporter} withName size="sm" /> : null
    case 'parent':
      return row.parentKey ? <span className="font-mono text-xs text-muted-foreground">{row.parentKey}</span> : null
    case 'labels':
      return (
        <span className="flex gap-1">
          {/* Each label's colour comes from the TaskLabelColorsProvider above the table, if any. */}
          {(row.labels ?? []).map((label) => (
            <TaskLabelChip key={label} name={label} variant="outline" className="shrink-0" />
          ))}
        </span>
      )
    case 'version':
      return row.version ? <TaskVersionChip name={row.version.name} state={row.version.state} variant="outline" /> : null
    case 'dates':
      return row.startDate && row.endDate ? (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatDay(row.startDate)} – {formatDay(row.endDate)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/60">—</span>
      )
    case 'created':
    case 'updated': {
      const at = column === 'created' ? row.createdAt : row.updatedAt
      return at ? <span className="text-xs whitespace-nowrap text-muted-foreground">{relative(at)}</span> : null
    }
  }
}

/**
 * What decides a cell's width: two cells with the same answer are as wide as
 * each other. Keys are monospaced, so their length is enough. Summary has none,
 * since it takes the width left over.
 */
function widthOf(column: TaskTableColumn, row: TaskTableRow): string | null {
  switch (column) {
    case 'summary':
      return null
    case 'type':
      return row.type
    case 'key':
      return String(row.key.length)
    case 'status':
      return row.status.name
    case 'priority':
      return row.priority
    case 'assignee':
      return row.assignee ? `${row.assignee.kind}:${row.assignee.name}` : ''
    case 'reporter':
      return row.reporter ? `${row.reporter.kind}:${row.reporter.name}` : ''
    case 'parent':
      return String(row.parentKey?.length ?? 0)
    case 'labels':
      return (row.labels ?? []).join('\u001f')
    case 'version':
      return row.version?.name ?? ''
    case 'dates':
      return row.startDate && row.endDate ? `${formatDay(row.startDate)}–${formatDay(row.endDate)}` : ''
    case 'created':
      return row.createdAt ? relative(row.createdAt) : ''
    case 'updated':
      return row.updatedAt ? relative(row.updatedAt) : ''
  }
}

/** One row per distinct width of each column: rendered unseen, they size the columns as if every row were. */
function widthSamples(rows: TaskTableRow[], columns: TaskTableColumn[]): Map<TaskTableColumn, TaskTableRow[]> {
  const samples = new Map<TaskTableColumn, TaskTableRow[]>()
  for (const column of columns) {
    const seen = new Map<string, TaskTableRow>()
    for (const row of rows) {
      const width = widthOf(column, row)
      if (width !== null && !seen.has(width)) {
        seen.set(width, row)
      }
    }
    samples.set(column, [...seen.values()])
  }
  return samples
}

/** A heading, keyed by its first row: a group can come back further down while the host is still sorting. */
type GroupItem = { kind: 'group'; id: string; first: string; label: ReactNode; count: number }
type TableItem = { kind: 'row'; row: TaskTableRow } | GroupItem

interface TaskTableRowViewProps {
  row: TaskTableRow
  columns: TaskTableColumn[]
  selected: boolean
  /** Whether the row is picked; undefined when the table has no checkbox column. */
  picked: boolean | undefined
  hrefFor?: (key: string) => string
  menuFor?: (row: TaskTableRow) => TaskMenuProps
  cellMenu?: (row: TaskTableRow, column: TaskTableColumn) => ItemMenuEntries
  onOpen?: (key: string) => void
  onToggle: (key: string, range: boolean) => void
}

/** One row. Memoised, so a scroll that moves the window mounts the rows coming into view and leaves the rest alone. */
const TaskTableRowView = memo(function TaskTableRowView({
  row,
  columns,
  selected,
  picked,
  hrefFor,
  menuFor,
  cellMenu,
  onOpen,
  onToggle,
}: TaskTableRowViewProps) {
  const selectable = picked !== undefined
  const menu = menuFor?.(row)
  const cells = (
    <>
      {selectable ? (
        <TableCell
          className="pr-0"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            if (event.shiftKey) {
              event.preventDefault()
            }
          }}
        >
          <Checkbox
            checked={picked}
            onCheckedChange={(_checked, details?: { event?: Event }) =>
              onToggle(row.key, Boolean(details?.event && 'shiftKey' in details.event && details.event.shiftKey))
            }
            aria-label={`Select ${row.key}`}
          />
        </TableCell>
      ) : null}
      {columns.map((column) =>
        cellMenu ? (
          <ItemContextMenu key={column} entries={cellMenu(row, column)} render={<TableCell />} className={widthClass(column)}>
            <Cell column={column} row={row} hrefFor={hrefFor} />
          </ItemContextMenu>
        ) : (
          <TableCell key={column} className={widthClass(column)}>
            <Cell column={column} row={row} hrefFor={hrefFor} />
          </TableCell>
        ),
      )}
      <TableCell className="px-1 py-0 text-right" onClick={(event) => event.stopPropagation()}>
        {menu ? <TaskActionsMenu {...menu} label={`Actions for ${row.key}`} /> : null}
      </TableCell>
    </>
  )
  const rowProps = {
    'data-state': selected ? 'selected' : undefined,
    // The app's key handler moves J/K through elements carrying this, in on-screen order.
    'data-task-key': row.key,
    'aria-selected': picked,
    tabIndex: 0,
    className: cn(
      // The scroll margin keeps a row scrolled into view (J/K) clear of the sticky head.
      'h-10 scroll-mt-10 cursor-pointer outline-none focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/50',
      picked && 'bg-primary/5 hover:bg-primary/10 data-[state=selected]:bg-primary/10',
    ),
    onMouseDown: (event: MouseEvent) => {
      // A shift-click picks a range; it should not also select the text between.
      if (selectable && event.shiftKey) {
        event.preventDefault()
      }
    },
    onClick: (event: MouseEvent) => {
      if (selectable && (event.metaKey || event.ctrlKey || event.shiftKey)) {
        onToggle(row.key, event.shiftKey)
        return
      }
      onOpen?.(row.key)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        onOpen?.(row.key)
      }
    },
  }
  return menu ? (
    <TaskContextMenu {...menu} render={<TableRow {...rowProps} />}>
      {cells}
    </TaskContextMenu>
  ) : (
    <TableRow {...rowProps}>{cells}</TableRow>
  )
})

/**
 * The plain table of tasks: sortable column heads, one row per task opening on
 * press, and each row's task menu on right-click and behind a "…" button. The
 * host owns the rows and the sort (it usually sorts on the server); the table
 * only reports what was pressed. Summary takes the width the other columns
 * leave; too narrow for them all, the table scrolls sideways. Given a bounded
 * height, the rows scroll inside it between the column heads and the footer,
 * which stay put; otherwise it is as tall as its rows.
 */
export function TaskTable({
  rows,
  columns = DEFAULT_COLUMNS,
  sort = null,
  onSortChange,
  onOpen,
  hrefFor,
  menuFor,
  headerMenu,
  cellMenu,
  groupOf,
  footer,
  empty,
  selectedKey,
  selection = [],
  onSelectionChange,
  scrollRef,
  className,
}: TaskTableProps) {
  const selectable = Boolean(onSelectionChange)
  const picked = new Set(selection)

  // The rows with a heading wherever the group changes; windowed as one list.
  const items: TableItem[] = []
  let heading = null as GroupItem | null
  for (const row of rows) {
    const group = groupOf?.(row)
    if (group && group.id !== heading?.id) {
      heading = { kind: 'group', id: group.id, first: row.key, label: group.label, count: 0 }
      items.push(heading)
    }
    if (group && heading) {
      heading.count++
    }
    items.push({ kind: 'row', row })
  }
  // The row a shift-click measures its range from.
  const anchor = useRef<string | null>(null)

  // Only the rows in view are rendered. Every row has one fixed height (h-10,
  // with no cell taller), read once off the first rendered rows, since the
  // table's collapsed borders make the pitch inexact to state up front.
  // Measured once, not per render: the window moving must not change it.
  const topSpacer = useRef<HTMLTableRowElement>(null)
  const [rowHeight, setRowHeight] = useState(41)
  const measured = useRef(false)
  // The sticky head covers the top of the scroller, so a row scrolled to lands below it.
  const head = useRef<HTMLTableSectionElement>(null)
  const [headHeight, setHeadHeight] = useState(0)
  const windowed = useWindowedRows({ count: items.length, rowHeight, listRef: topSpacer, stickyTop: headHeight })
  useLayoutEffect(() => {
    const height = head.current?.offsetHeight ?? 0
    if (height !== headHeight) {
      setHeadHeight(height)
    }
  })
  useLayoutEffect(() => {
    const rendered = topSpacer.current?.parentElement?.querySelectorAll<HTMLElement>(':scope > tr[data-task-key], :scope > tr[data-group-row]')
    if (measured.current || !rendered || rendered.length < 2) {
      return
    }
    measured.current = true
    const first = rendered[0].getBoundingClientRect().top
    const last = rendered[rendered.length - 1].getBoundingClientRect().top
    const pitch = (last - first) / (rendered.length - 1)
    if (Math.abs(pitch - rowHeight) > 0.1) {
      setRowHeight(pitch)
    }
  })
  // A row selected from elsewhere (a shortcut, the palette) is scrolled to, rendered or not.
  const selectedIndex = selectedKey ? items.findIndex((item) => item.kind === 'row' && item.row.key === selectedKey) : -1
  const scrollToIndex = useRef(windowed.scrollToIndex)
  scrollToIndex.current = windowed.scrollToIndex
  useEffect(() => {
    if (selectedIndex >= 0) {
      scrollToIndex.current(selectedIndex)
    }
  }, [selectedIndex])
  const span = columns.length + (selectable ? 2 : 1)
  // Only the rows in view are rendered, so the columns are sized by these instead.
  const samples = useMemo(() => widthSamples(rows, columns), [rows, columns])

  const toggle = (key: string, range: boolean) => {
    if (!onSelectionChange) {
      return
    }
    const from = range && anchor.current ? rows.findIndex((row) => row.key === anchor.current) : -1
    const to = rows.findIndex((row) => row.key === key)
    if (from >= 0 && to >= 0) {
      const next = new Set(selection)
      for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        next.add(row.key)
      }
      onSelectionChange([...next])
    } else {
      onSelectionChange(picked.has(key) ? selection.filter((k) => k !== key) : [...selection, key])
    }
    anchor.current = key
  }
  // One function for the table's life, so the memoised rows are not re-rendered for a new one.
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const onToggle = useCallback((key: string, range: boolean) => toggleRef.current(key, range), [])

  const allPicked = rows.length > 0 && rows.every((row) => picked.has(row.key))
  const somePicked = !allPicked && rows.some((row) => picked.has(row.key))
  const pickAll = () => {
    if (!onSelectionChange) {
      return
    }
    const shown = new Set(rows.map((row) => row.key))
    onSelectionChange(allPicked ? selection.filter((key) => !shown.has(key)) : [...new Set([...selection, ...shown])])
  }

  const pressHead = (field: TaskTableSortField) => {
    if (!onSortChange) {
      return
    }
    if (!sort || sort.field !== field) {
      onSortChange({ field, dir: 'asc' })
    } else if (sort.dir === 'asc') {
      onSortChange({ field, dir: 'desc' })
    } else {
      onSortChange(null)
    }
  }
  return (
    <div data-slot="task-table" className={cn('flex min-h-0 w-full flex-col', className)}>
      {/*
        The rows scroll here, both ways, once the table's height is bounded; the windowing follows this scroller.
        The table's own wrapper must not scroll, or the head would stick to it rather than to this.
      */}
      <ScrollArea ref={scrollRef} scrollbars="both" className="[&_[data-slot=table-container]]:overflow-visible">
        <Table>
          <TableHeader ref={head} className="sticky top-0 z-10 bg-background [&_th]:shadow-[inset_0_-1px_0_var(--color-border)] [&_tr]:border-b-0">
            <TableRow className="hover:bg-transparent">
              {selectable ? (
                <TableHead className="w-9 pr-0">
                  <Checkbox
                    checked={allPicked}
                    indeterminate={somePicked}
                    onCheckedChange={pickAll}
                    aria-label={allPicked ? 'Clear the selection' : 'Select all rows shown'}
                  />
                </TableHead>
              ) : null}
              {columns.map((column) => {
                const head = TASK_TABLE_HEADS[column]
                const sortable = Boolean(head.sort && onSortChange)
                const active = Boolean(head.sort && sort?.field === head.sort)
                return (
                  <ItemContextMenu
                    key={column}
                    entries={headerMenu?.(column) ?? []}
                    render={<TableHead aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined} />}
                    className={widthClass(column)}
                  >
                    {sortable && head.sort ? (
                      <button
                        type="button"
                        onClick={() => pressHead(head.sort as TaskTableSortField)}
                        className={cn(
                          'group/head -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
                          active && 'text-foreground',
                        )}
                      >
                        {column === 'type' ? <span className="sr-only">{head.label}</span> : head.label}
                        <SortGlyph active={active} dir={sort?.dir ?? 'asc'} />
                      </button>
                    ) : (
                      head.label
                    )}
                  </ItemContextMenu>
                )
              })}
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
            {/* Zero-high and inert (out of the focus order and the accessibility tree): a value of each width per column, plus Summary's minimum. */}
            <tr inert>
              {selectable ? <td className="p-0" /> : null}
              {columns.map((column) => (
                <TableCell key={column} className="py-0">
                  {column === 'summary' ? (
                    <div className="h-0 w-80" />
                  ) : (
                    samples.get(column)?.map((row) => (
                      <div key={row.key} className="h-0 overflow-hidden">
                        <Cell column={column} row={row} />
                      </div>
                    ))
                  )}
                </TableCell>
              ))}
              <td className="p-0" />
            </tr>
          </TableHeader>
          <TableBody>
            <tr ref={topSpacer} aria-hidden='true'>
              <td colSpan={span} className='p-0' style={{ height: windowed.padTop }} />
            </tr>
            {items.slice(windowed.start, windowed.end).map((item) =>
              item.kind === 'group' ? (
                // Exactly the rows' measured pitch, so the window's arithmetic holds across headings.
                <TableRow key={`group:${item.first}`} data-group-row={item.id} className='bg-muted/40 hover:bg-muted/40' style={{ height: rowHeight }}>
                  <TableCell colSpan={span} className='py-0 text-xs font-medium'>
                    <span className='flex items-center gap-2'>
                      {item.label}
                      <span className='text-muted-foreground tabular-nums'>{item.count}</span>
                    </span>
                  </TableCell>
                </TableRow>
              ) : (
                <TaskTableRowView
                  key={item.row.key}
                  row={item.row}
                  columns={columns}
                  selected={item.row.key === selectedKey}
                  picked={selectable ? picked.has(item.row.key) : undefined}
                  hrefFor={hrefFor}
                  menuFor={menuFor}
                  cellMenu={cellMenu}
                  onOpen={onOpen}
                  onToggle={onToggle}
                />
              ),
            )}
            {windowed.padBottom > 0 ? (
              <tr aria-hidden='true'>
                <td colSpan={span} className='p-0' style={{ height: windowed.padBottom }} />
              </tr>
            ) : null}
            {rows.length === 0 && empty ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={span} className="h-24 text-center text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </ScrollArea>
      {footer ? <div className="shrink-0 border-t px-1 py-1">{footer}</div> : null}
    </div>
  )
}
