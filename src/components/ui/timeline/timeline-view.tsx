import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable'
import { ItemContextMenu, type ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { TaskInlineCreate } from '@/components/ui/tasks/task-inline-create'
import type { TaskMenuProps } from '@/components/ui/tasks/task-menu'
import { useWindowedRows } from '@/components/ui/tasks/use-windowed-rows'
import { cn } from '@/lib/utils'

import { type BacklogDropTarget, BacklogList } from './backlog-list'
import { TaskTreeRow } from './task-tree-row'
import { changesForDrop, type DragSource, type DropTarget, type TimelineChange } from './timeline-drop'
import { TimelineGrid } from './timeline-grid'
import { TimelineHeader } from './timeline-header'
import { TimelineLinks } from './timeline-links'
import { moveAfterBlockers, type TimelineLink } from './timeline-links-model'
import {
  backlogTasks,
  CREATE_ROW_HEIGHT,
  childSpans,
  dropZone,
  isScheduled,
  rowHeights,
  rowTops,
  TASK_ROW_HEIGHT,
  type TimelineTask,
  treeKeyIntent,
  visibleRows,
} from './timeline-model'
import { type TimelinePane, TimelinePaneSwitch } from './timeline-pane-switch'
import {
  type CalendarDate,
  DEFAULT_SPAN_DAYS,
  formatRange,
  fromDay,
  MAX_PX_PER_DAY,
  MIN_PX_PER_DAY,
  scaleRange,
  today,
  toDay,
  zoomLabel,
} from './timeline-scale'
import { scaleMenuEntries, TimelineToolbar } from './timeline-toolbar'
import { TimelineTrack } from './timeline-track'
import { type TimelineVersionMarker, TimelineVersionMarkers } from './timeline-version-markers'
import { type DragSession, useTimelineDrag } from './use-timeline-drag'
import { useTimelineLinking } from './use-timeline-linking'
import { useTimelineZoom } from './use-timeline-zoom'

const TREE_WIDTH = 380
const HEADER_HEIGHT = 48
/** Empty scale kept below the last row, so its menu (a task starting that day) is always in reach. */
const EMPTY_SCALE_ROOM = 64
const ZOOM_STEP = 1.5

export interface TimelineViewProps {
  tasks: TimelineTask[]
  /**
   * A task typed into a create row: top-level (`parent: null`) or a subtask.
   * It starts unscheduled. A rejection keeps the typed text.
   */
  onCreate: (input: { summary: string; parent: string | null }) => Promise<unknown> | unknown
  /** A schedule, unschedule or move made by dragging, drawing, resizing or a menu. */
  onChange: (change: TimelineChange) => void
  onOpen: (key: string) => void
  /** Delete was asked for (Delete key or menu); confirming is the caller's. */
  onDelete: (key: string) => void
  /**
   * A task's context menu. The timeline sets Add subtask, Schedule, Move and
   * Unschedule itself, and routes Delete through `onDelete`.
   */
  menuFor: (task: TimelineTask) => TaskMenuProps
  /** Remembers the zoom level in this browser under this key. */
  storageKey?: string
  /** Shown over the scale while no task has dates, e.g. a hint to drag one in. It lets drags and drawing through. */
  emptyScale?: ReactNode
  /** Shown in the backlog while it holds no task. */
  emptyBacklog?: ReactNode
  /** The selected task, for a host that moves the selection itself (e.g. from a shortcut). Leave it out and the view keeps its own. */
  selectedKey?: string | null
  onSelectedKeyChange?: (key: string | null) => void
  /** Dependencies between the tasks (`from` blocks `to`), drawn as arrows between scheduled bars. */
  links?: TimelineLink[]
  /**
   * A dependency drawn from a bar's end handle onto a task, or picked after the
   * menu's "Blocks…". Without it the timeline offers neither.
   */
  onLink?: (link: TimelineLink) => void
  /** An arrow was pressed, e.g. to remove it. */
  onLinkClick?: (link: TimelineLink) => void
  /** An arrow's menu, on right-click or a long press on it. */
  linkMenu?: (link: TimelineLink) => ItemMenuEntries
  /**
   * "New task starting …" in the menu of the empty scale below the rows: a
   * task on those dates. Without it the menu offers only zoom, today and fit.
   */
  onCreateOn?: (start: CalendarDate, end: CalendarDate) => void
  /**
   * For a narrow screen such as a phone: one pane at a time (the scale, the
   * task list or the backlog) under a switch, and a tap opens a task. The
   * scale then carries each task's key and summary itself.
   */
  compact?: boolean
  /**
   * Where the zoom controls go. Given, the view hands them over instead of
   * drawing its own bar: return them wrapped for the App toolbar (e.g.
   * `(tools) => <AppToolbar><TaskManagerToolbar label='Timeline controls'>{tools}</TaskManagerToolbar></AppToolbar>`).
   * They are rendered as `variant='row'` and keep driving this view's zoom.
   */
  renderToolbar?: (toolbar: ReactNode) => ReactNode
  /**
   * Versions to mark on the scale: each planned one at its target date and
   * each released one at its release date, as a line with its name in the
   * header. Leave out archived and undated ones.
   */
  versions?: TimelineVersionMarker[]
  className?: string
}

/** What a drag is over right now, and — for a bar — how far it has moved. */
interface DragView {
  target: DropTarget | null
  shiftDays: number
}

/**
 * The timeline page's whole surface: the task tree on the left, each task's
 * lane on a zoomable time scale on the right with the dependencies between
 * tasks drawn as arrows, and the backlog below, in a resizable split. Data in,
 * changes out — it holds only view state (zoom, scroll, expanded rows,
 * selection, the pane shown, the drag or link in progress).
 */
export function TimelineView({
  tasks,
  onCreate,
  onChange,
  onOpen,
  onDelete,
  menuFor,
  storageKey,
  emptyScale,
  emptyBacklog,
  selectedKey,
  onSelectedKeyChange,
  links = [],
  onLink,
  onLinkClick,
  linkMenu,
  onCreateOn,
  compact = false,
  renderToolbar,
  versions = [],
  className,
}: TimelineViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [addingUnder, setAddingUnder] = useState<string | null>(null)
  const [ownSelected, setOwnSelected] = useState<string | null>(null)
  const selected = selectedKey === undefined ? ownSelected : selectedKey
  const setSelected = (key: string | null) => {
    setOwnSelected(key)
    onSelectedKeyChange?.(key)
  }

  // Wide, the tree and the scale sit side by side over the backlog; compact, one pane shows at a time.
  const [pane, setPane] = useState<TimelinePane>('scale')
  const showTree = !compact || pane === 'list'
  const showScale = !compact || pane === 'scale'
  const treeWidth = showTree && showScale ? TREE_WIDTH : 0

  const now = today()
  const range = useMemo(
    () => scaleRange(tasks.flatMap((t) => (isScheduled(t) ? [t.startDate, t.endDate] : [])), now),
    [tasks, now],
  )
  const zoom = useTimelineZoom({ scrollerRef, gutter: treeWidth, origin: range.from, storageKey: storageKey && `${storageKey}:zoom` })
  const { pxPerDay } = zoom
  const scaleWidth = showScale ? (range.to - range.from) * pxPerDay : 0

  const expanded = useMemo(() => new Set(tasks.map((t) => t.key).filter((k) => !collapsed.has(k))), [tasks, collapsed])
  const rows = useMemo(() => visibleRows(tasks, expanded, addingUnder), [tasks, expanded, addingUnder])
  const spans = useMemo(() => childSpans(tasks), [tasks])
  const backlog = useMemo(() => backlogTasks(tasks), [tasks])

  // Only the rows in view are rendered; spacers of the same height stand in for the rest.
  const heights = useMemo(() => rowHeights(rows), [rows])
  const tops = useMemo(() => rowTops(rows), [rows])
  const rowsHeight = useMemo(() => heights.reduce((sum, height) => sum + height, 0), [heights])
  const topSpacer = useRef<HTMLDivElement | null>(null)
  const windowed = useWindowedRows({ count: rows.length, rowHeight: heights, listRef: topSpacer, scrollerRef, stickyTop: HEADER_HEIGHT })
  const scrollToIndex = useRef(windowed.scrollToIndex)
  scrollToIndex.current = windowed.scrollToIndex
  // The selected row, and a create row just asked for, are scrolled to whether rendered or not.
  const selectedIndex = rows.findIndex((row) => row.kind === 'task' && row.task.key === selected)
  useEffect(() => {
    if (selectedIndex >= 0) {
      scrollToIndex.current(selectedIndex)
    }
  }, [selectedIndex])
  const addingIndex = addingUnder === null ? -1 : rows.findIndex((row) => row.kind === 'create' && row.parentKey === addingUnder)
  useEffect(() => {
    if (addingIndex >= 0) {
      scrollToIndex.current(addingIndex)
    }
  }, [addingIndex])

  const fit = () => {
    const scheduled = tasks.filter(isScheduled)
    if (scheduled.length === 0) {
      zoom.fit(now - 7, now + 21)
      return
    }
    zoom.fit(Math.min(...scheduled.map((t) => toDay(t.startDate))), Math.max(...scheduled.map((t) => toDay(t.endDate))))
  }

  // Place the scale once the scroller has a width: a first open in this browser
  // fits all the scheduled work; after that, the saved zoom opens on today.
  const placed = useRef(false)
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    if (!placed.current && showScale && zoom.viewport.width > 0) {
      placed.current = true
      if (zoom.restored) {
        zoom.scrollToDay(now)
      } else {
        fitRef.current()
      }
    }
  }, [zoom, now, showScale])

  const linkLayerRef = useRef<HTMLDivElement | null>(null)
  const { linking, startDrag: startLink, startPick } = useTimelineLinking({ layerRef: linkLayerRef, onLink })

  const addSubtask = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    setAddingUnder(key)
    if (compact) {
      setPane('list')
    }
  }

  const menuOf = (task: TimelineTask): TaskMenuProps => {
    const after = moveAfterBlockers(task, tasks, links)
    const reschedule = (start: number, end: number) => onChange({ type: 'schedule', key: task.key, start: fromDay(start), end: fromDay(end) })
    return {
      ...menuFor(task),
      onAddSubtask: () => addSubtask(task.key),
      onSchedule: isScheduled(task) ? undefined : () => reschedule(now, now + DEFAULT_SPAN_DAYS - 1),
      onMoveBy: isScheduled(task) ? (days) => reschedule(toDay(task.startDate) + days, toDay(task.endDate) + days) : undefined,
      onUnschedule: isScheduled(task) ? () => onChange({ type: 'unschedule', key: task.key }) : undefined,
      onMoveAfterBlockers: after ? () => onChange({ type: 'schedule', key: task.key, start: after.start, end: after.end }) : undefined,
      onBlocks: onLink ? () => startPick(task.key) : undefined,
      onDelete: () => onDelete(task.key),
    }
  }

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        if (addingUnder === key) {
          setAddingUnder(null)
        }
      }
      return next
    })

  const select = (key: string) => setSelected(key)

  // The day a menu on the scale opened on: the one under the pointer, or today from the keyboard.
  const [menuDay, setMenuDay] = useState(now)
  const fromKeyboard = useRef(false)
  const onContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    if (fromKeyboard.current) {
      // The event this handler dispatched for the keyboard below: it stands for today, wherever it lands.
      fromKeyboard.current = false
      return
    }
    if (event.target !== scroller) {
      const box = scroller.getBoundingClientRect()
      setMenuDay(range.from + Math.floor((event.clientX - box.left - treeWidth + scroller.scrollLeft) / pxPerDay))
      return
    }
    // The Menu key or Shift+F10 on the tree itself opens the selected task's menu, or else the scale's.
    const row = selected ? scroller.querySelector<HTMLElement>(`[data-task-key="${selected}"] [data-slot="context-menu-trigger"]`) : null
    const target = row ?? scroller.querySelector<HTMLElement>('[data-scale-menu]')
    if (!target) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setMenuDay(now)
    fromKeyboard.current = true
    const box = target.getBoundingClientRect()
    target.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + Math.min(box.width / 2, 160), clientY: box.top + box.height / 2 }),
    )
  }
  const scaleMenu = (withCreate: boolean): ItemMenuEntries =>
    scaleMenuEntries({
      day: menuDay,
      onZoomTo: (from, to) => zoom.fit(from, to),
      onFit: fit,
      onToday: () => zoom.scrollToDay(now),
      onCreateOn: withCreate && onCreateOn ? (day) => onCreateOn(fromDay(day), fromDay(day + DEFAULT_SPAN_DAYS - 1)) : undefined,
    })
  // Compact is for touch: a tap opens the task rather than selecting it.
  const press = (key: string) => (compact ? onOpen(key) : setSelected(key))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return
    }
    const intent = treeKeyIntent(event.key, rows, selected)
    if (!intent) {
      return
    }
    event.preventDefault()
    const act = { select, toggle, open: onOpen, delete: onDelete }[intent.kind]
    act(intent.key)
  }

  // ─── Drag and drop ──────────────────────────────────────────────────────
  // Every list marks its drop targets with `data-drop`; the nearest marked
  // element under the pointer is the target, so a row wins over the scale it
  // sits in and an item over the backlog around it. Drags are mouse and pen only.
  const targetAt = (pointer: { x: number; y: number }): DropTarget | null => {
    const element = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('[data-drop]')
    if (!element) {
      return null
    }
    const box = element.getBoundingClientRect()
    const key = element.dataset.key ?? ''
    switch (element.dataset.drop) {
      case 'row':
        return { kind: 'row', key, zone: dropZone(pointer.y - box.top, box.height) }
      case 'backlog-item':
        return { kind: 'backlog-item', key, zone: pointer.y - box.top < box.height / 2 ? 'before' : 'after' }
      case 'backlog':
        return { kind: 'backlog' }
      case 'scale': {
        const x = pointer.x - box.left - treeWidth
        if (!showScale || x < 0 || pointer.y < box.top + HEADER_HEIGHT) {
          return null
        }
        return { kind: 'scale', day: range.from + Math.floor((element.scrollLeft + x) / pxPerDay) }
      }
    }
    return null
  }
  const viewOf = (session: DragSession<DragSource>): DragView => ({
    target: targetAt(session.pointer),
    shiftDays: Math.round((session.pointer.x - session.start.x) / pxPerDay),
  })

  const [dragView, setDragView] = useState<DragView>({ target: null, shiftDays: 0 })
  const { session, start: startDrag } = useTimelineDrag<DragSource>({
    onMove: (moving) => {
      const next = viewOf(moving)
      setDragView((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    },
    onDrop: (dropped) => {
      const { target, shiftDays } = viewOf(dropped)
      setDragView({ target: null, shiftDays: 0 })
      for (const change of changesForDrop({ tasks, key: dropped.key, source: dropped.source, target, shiftDays })) {
        onChange(change)
      }
    },
  })
  const dragStarter = (key: string, source: DragSource) => (event: PointerEvent<HTMLElement>) => {
    setSelected(key)
    startDrag(key, source, event)
  }
  const drag = session ? { key: session.key, source: session.source, ...dragView } : null

  // The draft runs to the task under the pointer when that task has a bar in view, else to the pointer.
  const draftTarget =
    linking && linking.over && linking.over !== linking.from && tops[linking.over] !== undefined && tasks.some((t) => t.key === linking.over && isScheduled(t))
      ? linking.over
      : (linking?.point ?? null)
  const draft = linking && draftTarget ? { from: linking.from, to: draftTarget } : null

  const dragged = drag ? tasks.find((t) => t.key === drag.key) : undefined
  const barOffScale = drag?.source === 'bar' && drag.target !== null && drag.target.kind !== 'scale'
  const backlogTarget: BacklogDropTarget | null =
    drag?.target?.kind === 'backlog-item' ? { key: drag.target.key, zone: drag.target.zone } : null
  const scaleMarker =
    drag && dragged && drag.source !== 'bar' && drag.target?.kind === 'scale'
      ? changesForDrop({ tasks, key: drag.key, source: drag.source, target: drag.target }).find((c) => c.type === 'schedule')
      : undefined

  // The header and grid draw only the visible days, plus a margin for smooth scrolling.
  const firstDay = range.from + Math.floor(zoom.viewport.left / pxPerDay) - 14
  const lastDay = range.from + Math.ceil((zoom.viewport.left + zoom.viewport.width) / pxPerDay) + 14

  // The tree column: pinned beside the scale when both show, the full width when it shows alone.
  const treeCell = cn('shrink-0 bg-background', showScale && 'sticky left-0 z-10 border-r')
  const treeStyle = { width: showScale ? TREE_WIDTH : '100%' }

  // The scroller itself is the tree: it takes the focus, the arrow keys and the Menu key.
  const scrollerProps = {
    'data-drop': 'scale',
    role: 'tree',
    'aria-label': 'Tasks on the timeline',
    tabIndex: 0,
    onKeyDown,
    onContextMenuCapture,
  }

  const scaleArea = (
    <>
      {showScale && emptyScale && !tasks.some(isScheduled) ? (
        // Over the scale, not in it: it stays put while the scale scrolls, and lets pointers through.
        <div className='pointer-events-none absolute inset-y-0 right-0 z-40 flex items-center justify-center' style={{ left: treeWidth, top: HEADER_HEIGHT }}>
          {emptyScale}
        </div>
      ) : null}
      <ScrollArea
        ref={scrollerRef}
        scrollbars='both'
        className='h-full'
        innerClassName='min-h-full'
        viewportProps={scrollerProps}
        viewportClassName={cn(
          'relative focus-visible:ring-2 focus-visible:ring-inset',
          // One finger scrolls; two pinch the zoom, not the page. A pan that
          // runs past an edge stays here too, rather than becoming the page's
          // pull-to-refresh or the browser's swipe back.
          showScale && 'touch-pan-x touch-pan-y overscroll-contain',
          linking && 'cursor-crosshair',
        )}
      >
        <div className='relative flex flex-1 flex-col' style={{ width: showScale ? treeWidth + scaleWidth : '100%' }}>
          <div className='sticky top-0 z-30 flex border-b bg-background' style={{ height: HEADER_HEIGHT }}>
            {showTree ? (
              <div className={cn(treeCell, 'flex items-end px-3 pb-1.5 text-xs font-medium text-muted-foreground')} style={treeStyle}>
                Task
              </div>
            ) : null}
            {showScale ? (
              <ItemContextMenu entries={scaleMenu(false)} render={<div data-scale-menu='' />} className='shrink-0'>
                <TimelineHeader origin={range.from} pxPerDay={pxPerDay} from={firstDay} to={lastDay} today={now} scrollLeft={zoom.viewport.left} style={{ width: scaleWidth }} />
              </ItemContextMenu>
            ) : null}
            {showScale && versions.length > 0 ? (
              // Under the pinned tree column (z-10), over the header's ticks.
              <TimelineVersionMarkers
                part='flags'
                markers={versions}
                origin={range.from}
                pxPerDay={pxPerDay}
                from={firstDay}
                to={lastDay}
                className='absolute inset-y-0 z-[5]'
                style={{ left: treeWidth, width: scaleWidth }}
              />
            ) : null}
          </div>
          {showScale ? (
            <>
              <TimelineGrid
                origin={range.from}
                pxPerDay={pxPerDay}
                from={firstDay}
                to={lastDay}
                today={now}
                marker={scaleMarker && { day: toDay(scaleMarker.start), label: formatRange(scaleMarker.start, scaleMarker.end) }}
                className='absolute bottom-0'
                style={{ top: HEADER_HEIGHT, left: treeWidth, width: scaleWidth }}
              />
              {/* The empty scale below the rows: its menu creates a task starting on the day pressed. */}
              <ItemContextMenu
                entries={scaleMenu(true)}
                render={<div data-empty-scale='' style={{ top: HEADER_HEIGHT + rowsHeight, left: treeWidth, width: scaleWidth }} />}
                className='absolute bottom-0'
              >
                {null}
              </ItemContextMenu>
              {versions.length > 0 ? (
                <TimelineVersionMarkers
                  part='lines'
                  markers={versions}
                  origin={range.from}
                  pxPerDay={pxPerDay}
                  from={firstDay}
                  to={lastDay}
                  className='absolute bottom-0 z-[4]'
                  style={{ top: HEADER_HEIGHT, left: treeWidth, width: scaleWidth }}
                />
              ) : null}
              {/* The arrows sit over the bars and under the sticky tree column; only their strokes take the pointer. */}
              <div
                ref={linkLayerRef}
                className='pointer-events-none absolute z-[5]'
                style={{ top: HEADER_HEIGHT, left: treeWidth, width: scaleWidth, height: rowsHeight }}
              >
                <TimelineLinks
                  links={links}
                  tasks={tasks}
                  rowTops={tops}
                  origin={range.from}
                  pxPerDay={pxPerDay}
                  width={scaleWidth}
                  height={rowsHeight}
                  emphasisKey={linking?.from ?? selected}
                  onLinkClick={linking ? undefined : onLinkClick}
                  linkMenu={linking ? undefined : linkMenu}
                  draft={draft}
                />
              </div>
            </>
          ) : null}
          <div ref={topSpacer} aria-hidden className='flex shrink-0' style={{ height: windowed.padTop }}>
            {treeWidth ? <div className={treeCell} style={treeStyle} /> : null}
          </div>
          {rows.slice(windowed.start, windowed.end).map((row) =>
            row.kind === 'task' ? (
              <div key={row.task.key} data-task-key={row.task.key} className='relative flex border-b border-border/50' style={{ height: TASK_ROW_HEIGHT }}>
                {showTree ? (
                  <div className={treeCell} style={treeStyle}>
                    <TaskTreeRow
                      task={row.task}
                      depth={row.depth}
                      hasChildren={row.hasChildren}
                      expanded={row.expanded}
                      selected={row.task.key === selected}
                      dropZone={drag?.target?.kind === 'row' && drag.target.key === row.task.key ? drag.target.zone : null}
                      dragging={drag?.source === 'row' && drag.key === row.task.key}
                      menu={menuOf(row.task)}
                      onDragStart={dragStarter(row.task.key, 'row')}
                      onToggle={() => toggle(row.task.key)}
                      onSelect={() => press(row.task.key)}
                      onOpen={() => onOpen(row.task.key)}
                    />
                  </div>
                ) : null}
                {showScale ? (
                  <TimelineTrack
                    task={row.task}
                    origin={range.from}
                    pxPerDay={pxPerDay}
                    width={scaleWidth}
                    selected={row.task.key === selected}
                    childSpan={spans[row.task.key]}
                    barShiftDays={drag?.source === 'bar' && drag.key === row.task.key ? drag.shiftDays : undefined}
                    barDetached={barOffScale && drag?.key === row.task.key}
                    menu={menuOf(row.task)}
                    onBarDragStart={dragStarter(row.task.key, 'bar')}
                    onBarLinkStart={onLink ? (event) => startLink(row.task.key, event) : undefined}
                    compact={compact}
                    onSchedule={(start: CalendarDate, end: CalendarDate) => onChange({ type: 'schedule', key: row.task.key, start, end })}
                    onSelect={() => setSelected(row.task.key)}
                    onOpen={() => onOpen(row.task.key)}
                  />
                ) : null}
              </div>
            ) : showTree ? (
              // Keyed on whether it was asked for, so "Add subtask" remounts the row already there open.
              <div
                key={`create:${row.parentKey ?? 'root'}:${row.parentKey !== null && row.parentKey === addingUnder}`}
                className='relative flex border-b border-border/50'
                style={{ height: CREATE_ROW_HEIGHT }}
              >
                <div className={cn(treeCell, 'py-0.5 pr-2')} style={{ ...treeStyle, paddingLeft: 4 + row.depth * 16 }}>
                  <TaskInlineCreate
                    label={row.parentKey ? 'Add subtask' : 'Create task'}
                    defaultOpen={row.parentKey !== null && row.parentKey === addingUnder}
                    onCreate={(summary) => onCreate({ summary, parent: row.parentKey })}
                    onClose={row.parentKey === addingUnder ? () => setAddingUnder(null) : undefined}
                    className={cn('h-8', row.parentKey && 'opacity-70 focus-within:opacity-100 hover:opacity-100')}
                  />
                </div>
              </div>
            ) : (
              // The scale alone keeps a create row's height, so its rows stay where the model puts them.
              <div key={`create:${row.parentKey ?? 'root'}`} aria-hidden className='border-b border-border/50' style={{ height: CREATE_ROW_HEIGHT }} />
            ),
          )}
          <div aria-hidden className='flex shrink-0' style={{ height: windowed.padBottom + (showScale ? EMPTY_SCALE_ROOM : 0) }}>
            {treeWidth ? <div className={treeCell} style={treeStyle} /> : null}
          </div>
          {/* The tree column continues below the last row, so the scale never shows through it. */}
          {treeWidth ? <div aria-hidden className={cn(treeCell, 'flex-1')} style={treeStyle} /> : null}
        </div>
      </ScrollArea>
    </>
  )

  const backlogArea = (
    <BacklogList
      tasks={backlog}
      selectedKey={selected}
      draggingKey={drag?.source === 'backlog' ? drag.key : null}
      receiving={drag !== null && drag.source !== 'backlog' && drag.target?.kind === 'backlog'}
      dropTarget={backlogTarget}
      menuFor={menuOf}
      onDragStart={(key, event) => dragStarter(key, 'backlog')(event)}
      onSelect={press}
      onOpen={onOpen}
      onCreate={(summary) => onCreate({ summary, parent: null })}
      empty={emptyBacklog}
    />
  )

  const tools = (
    <TimelineToolbar
      variant={renderToolbar ? 'row' : 'bar'}
      zoomLabel={zoomLabel(pxPerDay)}
      canZoomIn={pxPerDay < MAX_PX_PER_DAY}
      canZoomOut={pxPerDay > MIN_PX_PER_DAY}
      onZoomIn={() => zoom.zoomBy(ZOOM_STEP)}
      onZoomOut={() => zoom.zoomBy(1 / ZOOM_STEP)}
      onFit={fit}
      onToday={() => zoom.scrollToDay(now)}
    />
  )
  // Handed to the host, it leaves this layout (the App toolbar renders it); drawn here, it is the bar above the scale.
  const toolbar = renderToolbar ? renderToolbar(tools) : tools

  return (
    <>
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        {compact ? (
          <>
            <TimelinePaneSwitch value={pane} onValueChange={setPane} backlogCount={backlog.length} className='m-2 mb-1' />
            {showScale ? toolbar : null}
            <div className='relative min-h-0 flex-1'>{pane === 'backlog' ? backlogArea : scaleArea}</div>
          </>
        ) : (
          <>
            {toolbar}
            <ResizablePanelGroup orientation='vertical' className='min-h-0 flex-1'>
              <ResizablePanel defaultSize='68%' minSize='20%' className='relative'>
                {scaleArea}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize='32%' minSize='12%'>
                {backlogArea}
              </ResizablePanel>
            </ResizablePanelGroup>
          </>
        )}
      </div>
      {session && dragged && (drag?.source !== 'bar' || barOffScale) ? (
        // Follows the pointer; transparent to it, so the target underneath is still found.
        <div
          className='pointer-events-none fixed z-50 flex h-8 max-w-80 items-center gap-2 rounded-md border bg-popover px-3 text-sm shadow-lg'
          style={{ left: session.pointer.x + 12, top: session.pointer.y - 16 }}
        >
          <span className='font-mono text-xs text-muted-foreground'>{dragged.key}</span>
          <span className='truncate'>{dragged.summary}</span>
        </div>
      ) : null}
    </>
  )
}
