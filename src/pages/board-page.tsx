// The Board page. A project has the boards someone set up, and none by
// itself: /board/<id> shows one, /board/<id>/setup and /board/new set one up,
// and the bare /board shows the board this browser last showed (else the
// first), or the way to set one up. A board's columns hold its statuses, one
// section per status, in the setup's order, and it shows only the tasks in
// those statuses that match its preset filter; the page's own filters narrow
// it further, and can split it into swimlanes by assignee. Dragging a card
// into a section changes its status through the single status path (so
// workflows react as to any status change), dragging within a section
// reorders it, and dropping into another lane reassigns it. Filters and the
// grouping live in the URL, so a board view is a link.

import { AppToolbar, legacy } from '@opencroft/client'
import { cn } from 'cn'
import { ArrowRightLeft, ArrowUpDown, FoldVertical, ListChecks, UnfoldVertical } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { TaskManagerToolbar } from '@/components/ui/navigation/task-manager-toolbar'
import { TaskManagerEmpty } from '@/components/ui/states/task-manager-empty'
import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'
import { BoardCard } from '@/components/ui/tasks/board-card'
import { BoardColumn, BoardColumnSection } from '@/components/ui/tasks/board-column'
import { BoardColumnPager } from '@/components/ui/tasks/board-column-pager'
import { BOARD_SWIMLANE_OPTIONS, BoardDisplayMenu } from '@/components/ui/tasks/board-display-menu'
import { BoardPicker } from '@/components/ui/tasks/board-picker'
import { ItemContextMenu, type ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskBulkBar } from '@/components/ui/tasks/task-bulk-bar'
import { TaskFilterBar } from '@/components/ui/tasks/task-filter-bar'
import { TASK_PRIORITIES } from '@/components/ui/tasks/task-priority-icon'
import { TaskSavedViews } from '@/components/ui/tasks/task-saved-views'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { useBoardTouchReorder } from '@/components/ui/tasks/use-board-touch-reorder'
import { type DragSession, useTimelineDrag } from '@/components/ui/timeline/use-timeline-drag'

import type { Board } from '../../shared/boards'
import type { Assignee, Status, TaskListInput, TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { errorMessage } from '../lib/api'
import { assigneeInput, assigneeKey } from '../lib/assignees'
import { clearedParams, selectionOf, selectionParams, textParam } from '../lib/filter-params'
import { useTasksLive } from '../lib/live'
import { usePhoneWidth } from '../lib/phone-width'
import { hrefFor, navigate, useTasksLocation } from '../lib/router'
import { taskFilterDefs } from '../lib/task-filters'
import { keepUnchanged, listAllTasks } from '../lib/task-list'
import { workflowsApi } from '../workflows/api'
import { BoardColumnCards, withOpenBlockers } from './board-column-cards'
import { shownSections } from './board-sections'
import { BoardSetupPage } from './board-setup-page'
import { lastBoard, useBoards } from './use-boards'
import { useBulkActions } from './use-bulk-actions'
import { useSavedViews } from './use-saved-views'

const FILTER_IDS = ['assignee', 'type', 'label', 'version'] as const
type FilterId = (typeof FILTER_IDS)[number]

/** Where a drop lands: a section (its status), a lane, and the card it goes before (null: the end). */
interface DropTarget {
  statusId: number
  lane: string
  beforeKey: string | null
}

/** A column as the page draws it: its setup, and the project's own record of each of its statuses. */
interface ViewColumn {
  index: number
  /** Its own name; with none, a column of one status shows that status's badge, and a longer one its first status's name. */
  title?: string
  statuses: Status[]
}

const NO_LANE = '*'
const UNASSIGNED = 'none'
const NO_CARDS: TaskSummary[] = []

/** On a phone the board shows one column at a time, so it has no swimlanes; the menu says so rather than hiding the choice. */
const PHONE_SWIMLANE_OPTIONS = BOARD_SWIMLANE_OPTIONS.map((option) =>
  option.id === 'assignee' ? { ...option, unavailable: 'Not on a phone' } : option,
)

/** The lane a task belongs to when grouping by assignee. */
function laneOf(task: TaskSummary): string {
  return task.assignee ? assigneeKey(task.assignee) : UNASSIGNED
}

function assigneeForLane(lane: string, tasks: TaskSummary[]): Assignee | null {
  if (lane === UNASSIGNED || lane === NO_LANE) {
    return null
  }
  return tasks.find((task) => laneOf(task) === lane)?.assignee ?? null
}

/** How a column orders its cards: the board's own order (what dragging sets) or by a field. */
type ColumnSort = 'rank' | 'priority' | 'due' | 'updated'
const COLUMN_SORTS: { id: ColumnSort; label: string }[] = [
  { id: 'rank', label: 'Board order' },
  { id: 'priority', label: 'Priority' },
  { id: 'due', label: 'Due date' },
  { id: 'updated', label: 'Recently updated' },
]

function sortCards(cards: TaskSummary[], by: ColumnSort): TaskSummary[] {
  switch (by) {
    case 'rank':
      return cards
    case 'priority':
      return [...cards].sort((a, b) => TASK_PRIORITIES.indexOf(a.priority) - TASK_PRIORITIES.indexOf(b.priority))
    case 'due':
      // Undated cards last.
      return [...cards].sort((a, b) => (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999'))
    case 'updated':
      return [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

/** Each column's sort, per board and column, kept in this browser. */
function useColumnSorts(instanceId: string, boardId: string): [(column: number) => ColumnSort, (column: number, by: ColumnSort) => void] {
  const storageKey = `task-pipelines:${instanceId}:board-sort:${boardId}`
  const [sorts, setSorts] = useState<Record<number, ColumnSort>>({})
  useEffect(() => {
    try {
      setSorts(JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<number, ColumnSort>)
    } catch {
      setSorts({})
    }
  }, [storageKey])
  const set = useCallback(
    (column: number, by: ColumnSort) => {
      setSorts((current) => {
        const next = { ...current, [column]: by }
        localStorage.setItem(storageKey, JSON.stringify(next))
        return next
      })
    },
    [storageKey],
  )
  return [(column) => sorts[column] ?? 'rank', set]
}

/** The drop target under the pointer, read from the sections' and cards' data attributes. */
function targetAt(x: number, y: number, draggedKey: string): DropTarget | null {
  const section = document.elementsFromPoint(x, y).find((el) => el instanceof HTMLElement && el.dataset.boardStatus) as
    | HTMLElement
    | undefined
  if (!section) {
    return null
  }
  const statusId = Number(section.dataset.boardStatus)
  const lane = section.dataset.boardLane ?? NO_LANE
  const cards = [...section.querySelectorAll<HTMLElement>('[data-board-key]')].filter((el) => el.dataset.boardKey !== draggedKey)
  const before = cards.find((card) => {
    const box = card.getBoundingClientRect()
    return y < box.top + box.height / 2
  })
  return { statusId, lane, beforeKey: before?.dataset.boardKey ?? null }
}

/** Scrolls the card list under a dragged card when it nears the list's top or bottom. */
function scrollListNear(pointer: { x: number; y: number }): void {
  const list = document
    .elementsFromPoint(pointer.x, pointer.y)
    .find((el): el is HTMLElement => el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))
  if (!list) {
    return
  }
  const box = list.getBoundingClientRect()
  if (pointer.y > box.bottom - 48) {
    list.scrollBy({ top: 16 })
  } else if (pointer.y < box.top + 48) {
    list.scrollBy({ top: -16 })
  }
}

/** Which page the path names, and which board. */
export function BoardPage() {
  const { instanceId } = useProject()
  const location = useTasksLocation()
  const [, id, part] = location.segments
  const { boards, error, reload } = useBoards()

  if (boards === null) {
    return error ? (
      <TaskManagerError title="Couldn't load the boards" message={error} onRetry={() => void reload()} />
    ) : (
      <TaskManagerSkeleton page="board" />
    )
  }
  // A saved board opens once the list holds it, so a new one is never looked up before it is known.
  const onSaved = async (saved: Board) => {
    await reload()
    navigate(hrefFor(['board', saved.id]))
  }
  if (id === 'new') {
    return <BoardSetupPage board={null} onSaved={onSaved} />
  }
  const remembered = lastBoard(instanceId).get()
  const board = id ? boards.find((candidate) => candidate.id === id) : (boards.find((candidate) => candidate.id === remembered) ?? boards[0])
  if (!board) {
    // No board to show: the picker still lists the others, and leads to a new one.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AppToolbar>
          <TaskManagerToolbar label="Board controls">
            <BoardPicker
              boards={boards}
              activeId={null}
              onSelect={(other) => navigate(hrefFor(['board', other]))}
              onCreate={() => navigate(hrefFor(['board', 'new']))}
            />
          </TaskManagerToolbar>
        </AppToolbar>
        {id ? (
          <TaskManagerError title="This board is gone" message="It was deleted, or the link is wrong. Pick another board above." />
        ) : (
          <TaskManagerEmpty kind="no-boards" onCreateBoard={() => navigate(hrefFor(['board', 'new']))} />
        )}
      </div>
    )
  }
  if (part === 'setup') {
    return <BoardSetupPage key={board.id} board={board} onSaved={onSaved} />
  }
  return <BoardView key={board.id} board={board} boards={boards} />
}

function BoardView({ board, boards }: { board: Board; boards: Board[] }) {
  const { api, instanceId, statuses, assignees, labels, versions, fail, menuFor, confirm } = useProject()
  const location = useTasksLocation()
  // The URL read against the shown saved view; write against `base`.
  const savedViews = useSavedViews('board', location)
  const { current, base } = savedViews
  const query = current.filter.query ?? ''
  // Keeps its identity until the URL or the view changes: the list's fetch is keyed on it.
  const values = useMemo(
    () => Object.fromEntries(FILTER_IDS.map((id) => [id, selectionOf(current.filter[id])])) as Record<FilterId, ReturnType<typeof selectionOf>>,
    [current.filter],
  )
  const rootRef = useRef<HTMLDivElement>(null)
  // At phone width one column fills the screen, and swimlanes give way to it.
  const phone = usePhoneWidth(rootRef)
  const grouped = location.query.get('group') === 'assignee' && !phone

  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const picked = useMemo(() => new Set(selection), [selection])
  const bulk = useBulkActions(tasks ?? NO_CARDS, selection, setSelection)
  const [steps, setSteps] = useState<Map<string, string>>(new Map())
  const [loadError, setLoadError] = useState<string | null>(null)
  // Whether anything has loaded yet: a failing first load shows the page's error state, a later one a toast.
  const loaded = useRef(false)
  const [moveError, setMoveError] = useState<{ title: string; message: string } | null>(null)
  const [searchDraft, setSearchDraft] = useState(query)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [grab, setGrab] = useState<{ dx: number; dy: number; width: number } | null>(null)
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())
  const [sortOf, setColumnSort] = useColumnSorts(instanceId, board.id)
  const requestId = useRef(0)
  const dragging = useRef(false)
  const pendingReload = useRef(false)
  const boardRef = useRef<HTMLDivElement>(null)
  const workflows = useMemo(() => workflowsApi(instanceId), [instanceId])
  const searchRef = useRef<HTMLInputElement>(null)
  const columnKey = `task-pipelines:${instanceId}:board-column:${board.id}`
  const { selectedKey } = usePageShortcuts({ onSearch: () => searchRef.current?.focus() })

  useEffect(() => lastBoard(instanceId).set(board.id), [instanceId, board.id])

  // The board's columns with the project's record of each status (its category and colour); a status gone since is left out.
  const columns = useMemo<ViewColumn[]>(
    () =>
      board.columns.map((column, index) => ({
        index,
        title: column.name ?? (column.statuses.length === 1 ? undefined : (column.statuses[0]?.name ?? 'Empty column')),
        statuses: column.statuses.map((placed) => statuses.find((status) => status.id === placed.id)).filter((status) => status !== undefined),
      })),
    [board.columns, statuses],
  )

  const write = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(location.query)
      // An empty value stays: it is "nothing" where the shown view has something.
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
      }
      navigate(hrefFor(location.segments, next), { replace: true })
    },
    [location.query, location.segments],
  )

  useEffect(() => setSearchDraft(query), [query])
  useEffect(() => {
    if (searchDraft === query) {
      return
    }
    const timer = setTimeout(() => write({ q: textParam(searchDraft.trim(), base.filter.query ?? '') }), 200)
    return () => clearTimeout(timer)
  }, [searchDraft, query, write, base])

  const input = useMemo<TaskListInput>(
    () => ({
      board: board.id,
      query: query || undefined,
      assignee: current.filter.assignee,
      type: current.filter.type,
      label: current.filter.label,
      version: current.filter.version,
    }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: a changed board setup reloads through updatedAt
    [board.id, board.updatedAt, query, current.filter],
  )

  const load = useCallback(async () => {
    if (dragging.current) {
      pendingReload.current = true
      return
    }
    const id = ++requestId.current
    try {
      const [result, runs] = await Promise.all([
        listAllTasks(api, input),
        workflows.workflow_runs_list({ state: 'active' }).catch(() => ({ runs: [] })),
      ])
      if (id !== requestId.current) {
        return
      }
      setTasks((previous) => keepUnchanged(previous, result))
      setLoadError(null)
      loaded.current = true
      const next = new Map<string, string>()
      for (const run of runs.runs) {
        const open = run.steps.find((step) => step.state === 'active' || step.state === 'waiting')
        if (open) {
          next.set(run.taskKey, open.name)
        }
      }
      setSteps(next)
    } catch (error) {
      if (id === requestId.current) {
        if (loaded.current) {
          fail(error)
        } else {
          setLoadError(errorMessage(error))
        }
      }
    }
  }, [api, workflows, input, fail])

  useEffect(() => {
    void load()
  }, [load])
  useTasksLive(instanceId, () => void load())

  const lanes = useMemo(() => {
    if (!grouped || !tasks) {
      return [{ id: NO_LANE, assignee: null as Assignee | null }]
    }
    const seen = new Map<string, Assignee | null>()
    for (const task of tasks) {
      seen.set(laneOf(task), task.assignee)
    }
    const list = [...seen.entries()]
      .filter(([id]) => id !== UNASSIGNED)
      .sort(([, a], [, b]) => (a?.name ?? '').localeCompare(b?.name ?? ''))
      .map(([id, assignee]) => ({ id, assignee }))
    return [...list, { id: UNASSIGNED, assignee: null }]
  }, [grouped, tasks])

  // ─── Dragging ───────────────────────────────────────────────────────────

  const finishDrop = useCallback(
    async (session: DragSession<'card'>, target: DropTarget) => {
      const all = tasks ?? []
      const task = all.find((candidate) => candidate.key === session.key)
      const status = statuses.find((candidate) => candidate.id === target.statusId)
      if (!task || !status) {
        return
      }
      const laneChanged = grouped && target.lane !== laneOf(task)
      const statusChanged = task.status.id !== status.id
      const inTarget = all.filter(
        (candidate) =>
          candidate.key !== task.key && candidate.status.id === status.id && (!grouped || laneOf(candidate) === target.lane),
      )
      const position = target.beforeKey ? { before: target.beforeKey } : inTarget.length ? { after: inTarget[inTarget.length - 1].key } : {}
      // Dropped where it already was: nothing to do.
      if (!statusChanged && !laneChanged) {
        const section = all.filter((candidate) => candidate.status.id === status.id && (!grouped || laneOf(candidate) === target.lane))
        const next = section[section.findIndex((candidate) => candidate.key === task.key) + 1]?.key ?? null
        if (next === target.beforeKey) {
          return
        }
      }
      const newAssignee = laneChanged ? assigneeForLane(target.lane, all) : task.assignee

      // Show the move at once; the server's answer (or a reload on refusal) settles it.
      setTasks((current) => {
        if (!current) {
          return current
        }
        const moved: TaskSummary = { ...task, status, assignee: newAssignee }
        const rest = current.filter((candidate) => candidate.key !== task.key)
        let index = target.beforeKey ? rest.findIndex((candidate) => candidate.key === target.beforeKey) : -1
        if (index < 0) {
          const lastInTarget = position.after ? rest.findIndex((candidate) => candidate.key === position.after) : -1
          index = lastInTarget >= 0 ? lastInTarget + 1 : rest.length
        }
        return [...rest.slice(0, index), moved, ...rest.slice(index)]
      })

      try {
        if (statusChanged) {
          const { warnings } = await api.task_change_status({ key: task.key, status: status.id })
          for (const warning of warnings ?? []) {
            legacy.toast.warning(warning)
          }
        }
        if (laneChanged) {
          await api.task_update({ key: task.key, assignee: assigneeInput(newAssignee) })
        }
        if (position.before || position.after) {
          await api.task_move({ key: task.key, ...position })
        }
      } catch (error) {
        // Shown above the board until dismissed, since a refusal (a workflow's rule) is worth reading.
        setMoveError({ title: `${task.key} was not moved`, message: errorMessage(error) })
        void load()
      }
    },
    [api, grouped, load, statuses, tasks],
  )

  // A mouse drag and a touch long-press report the same session, so one pair of handlers serves both.
  const followDrag = (current: DragSession<'card'>) => {
    dragging.current = true
    setDrop(targetAt(current.pointer.x, current.pointer.y, current.key))
    scrollListNear(current.pointer)
    // Scroll the board sideways when the pointer nears its edge.
    const scroller = boardRef.current
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      if (current.pointer.x > box.right - 48) {
        scroller.scrollBy({ left: 24 })
      } else if (current.pointer.x < box.left + 48) {
        scroller.scrollBy({ left: -24 })
      }
    }
  }
  const endDrag = (ended: DragSession<'card'>) => {
    const target = targetAt(ended.pointer.x, ended.pointer.y, ended.key)
    setDrop(null)
    setGrab(null)
    dragging.current = false
    if (target) {
      void finishDrop(ended, target)
    }
    if (pendingReload.current) {
      pendingReload.current = false
      void load()
    }
  }
  const mouse = useTimelineDrag<'card'>({ onMove: followDrag, onDrop: endDrag })
  const touch = useBoardTouchReorder<'card'>({ onLift: followDrag, onMove: followDrag, onDrop: endDrag })
  const session = mouse.session ?? touch.session

  // A cancelled drag (Escape, or a touch the browser took over) ends without a drop; clear what it showed.
  useEffect(() => {
    if (!session && dragging.current) {
      dragging.current = false
      setDrop(null)
      setGrab(null)
      if (pendingReload.current) {
        pendingReload.current = false
        void load()
      }
    }
  }, [session, load])

  const beginDrag = (task: TaskSummary, event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setGrab({ dx: event.clientX - box.left, dy: event.clientY - box.top, width: box.width })
    // Each hook takes only its own pointers: the mouse drag mouse and pen, the long press touch.
    mouse.start(task.key, 'card', event)
    touch.start(task.key, 'card', event)
  }
  // One function for the whole life of the page, so a section's memoised cards are not re-rendered for a new one.
  const beginDragRef = useRef(beginDrag)
  beginDragRef.current = beginDrag
  const onCardDragStart = useCallback(
    (task: TaskSummary, event: ReactPointerEvent<HTMLElement>) => beginDragRef.current(task, event),
    [],
  )

  // ─── Rendering ──────────────────────────────────────────────────────────

  const filters = useMemo(() => taskFilterDefs(FILTER_IDS, { statuses, assignees, labels, versions }), [statuses, assignees, labels, versions])

  const draggedTask = session ? tasks?.find((task) => task.key === session.key) : undefined

  // Each section's cards, built once per load so they keep their identity through a drag. A
  // section whose cards are the same objects in the same order keeps its previous array, so a
  // move re-renders only the sections it left and entered.
  const previousSections = useRef(new Map<string, TaskSummary[]>())
  const cardsBySection = useMemo(() => {
    const bySection = new Map<string, TaskSummary[]>()
    for (const task of tasks ?? []) {
      const section = `${grouped ? laneOf(task) : NO_LANE}:${task.status.id}`
      const list = bySection.get(section)
      if (list) {
        list.push(task)
      } else {
        bySection.set(section, [task])
      }
    }
    for (const [section, list] of bySection) {
      const previous = previousSections.current.get(section)
      if (previous && previous.length === list.length && previous.every((task, index) => task === list[index])) {
        bySection.set(section, previous)
      }
    }
    previousSections.current = bySection
    return bySection
  }, [tasks, grouped])

  // Sorted columns show their cards by that field; dragging still sets the board order underneath.
  const cardsOf = (lane: string, column: ViewColumn, status: Status): TaskSummary[] =>
    sortCards(cardsBySection.get(`${lane}:${status.id}`) ?? NO_CARDS, sortOf(column.index))
  const columnCards = (lane: string, column: ViewColumn) => column.statuses.flatMap((status) => cardsBySection.get(`${lane}:${status.id}`) ?? NO_CARDS)

  // Picking cards for bulk actions: Ctrl/Cmd-click toggles one, Shift-click takes the cards
  // between the last one picked and this one, when both are in the same section.
  const anchor = useRef<string | null>(null)
  const pickToggle = (task: TaskSummary, range: boolean) => {
    const section = cardsBySection.get(`${grouped ? laneOf(task) : NO_LANE}:${task.status.id}`) ?? NO_CARDS
    const from = range && anchor.current ? section.findIndex((card) => card.key === anchor.current) : -1
    const to = section.findIndex((card) => card.key === task.key)
    if (from >= 0 && to >= 0) {
      const span = section.slice(Math.min(from, to), Math.max(from, to) + 1).map((card) => card.key)
      setSelection((current) => [...new Set([...current, ...span])])
    } else {
      setSelection((current) => (current.includes(task.key) ? current.filter((key) => key !== task.key) : [...current, task.key]))
    }
    anchor.current = task.key
  }
  const pickToggleRef = useRef(pickToggle)
  pickToggleRef.current = pickToggle
  const onPickToggle = useCallback((task: TaskSummary, range: boolean) => pickToggleRef.current(task, range), [])

  // A picked card the board no longer shows (filtered out, deleted elsewhere) is dropped from the pick.
  useEffect(() => {
    if (!tasks) {
      return
    }
    const shown = new Set(tasks.map((task) => task.key))
    setSelection((current) => (current.every((key) => shown.has(key)) ? current : current.filter((key) => shown.has(key))))
  }, [tasks])

  // Every card of a column to another status, after a confirm: one ordinary change per task.
  const moveAll = (cards: TaskSummary[], from: string, to: Status) => {
    const moving = cards.filter((task) => task.status.id !== to.id)
    confirm({
      title: `Move ${moving.length} ${moving.length === 1 ? 'task' : 'tasks'} to ${to.name}?`,
      description: `Every card in ${from}${grouped ? ' in this lane' : ''} moves to ${to.name}. Workflows that start on ${to.name} start for each of them.`,
      action: `Move ${moving.length}`,
      onConfirm: async () => {
        const results = await Promise.allSettled(moving.map((task) => api.task_change_status({ key: task.key, status: to.id })))
        const failed = results.filter((result) => result.status === 'rejected')
        if (failed.length > 0) {
          fail(new Error(`${failed.length} of ${moving.length} could not move: ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`))
        } else {
          legacy.toast.success(`Moved ${moving.length} to ${to.name}`)
        }
      },
    })
  }

  const nameOf = (column: ViewColumn) => column.title ?? column.statuses[0]?.name ?? ''

  const columnMenu = (column: ViewColumn, cards: TaskSummary[]): ItemMenuEntries => {
    const by = sortOf(column.index)
    return [
      cards.length > 0 && {
        id: 'select',
        label: 'Select all in column',
        icon: ListChecks,
        onSelect: () => setSelection((current) => [...new Set([...current, ...cards.map((task) => task.key)])]),
      },
      {
        id: 'sort',
        label: 'Sort',
        icon: ArrowUpDown,
        group: 'change',
        entries: COLUMN_SORTS.map((sort) => ({ id: sort.id, label: sort.label, checked: sort.id === by, onSelect: () => setColumnSort(column.index, sort.id) })),
      },
      cards.length > 0 && {
        id: 'move-all',
        label: 'Move all to',
        icon: ArrowRightLeft,
        group: 'change',
        entries: statuses
          .filter((other) => !(column.statuses.length === 1 && column.statuses[0].id === other.id))
          .map((other) => ({
            id: String(other.id),
            label: <TaskStatusBadge name={other.name} category={other.category} color={other.color} size="sm" />,
            onSelect: () => moveAll(cards, nameOf(column), other),
          })),
      },
    ]
  }

  const renderColumn = (column: ViewColumn, lane: { id: string; assignee: Assignee | null }) => {
    const cards = columnCards(lane.id, column)
    const hasCards = (status: Status) => (cardsBySection.get(`${lane.id}:${status.id}`) ?? NO_CARDS).length > 0
    const sections: ReactNode[] = shownSections(column.statuses, hasCards, session !== null).map(({ status, labelled }) => {
      const sectionCards = cardsOf(lane.id, column, status)
      const isTarget = drop?.statusId === status.id && drop.lane === lane.id
      const has = (key: string | null | undefined) => (key ? sectionCards.some((task) => task.key === key) : false)
      return (
        <BoardColumnSection
          key={status.id}
          data-board-status={status.id}
          data-board-lane={lane.id}
          status={status}
          count={sectionCards.length}
          labelled={labelled}
          dropTarget={isTarget}
        >
          {sectionCards.length > 0 ? (
            <BoardColumnCards
              cards={sectionCards}
              phone={phone}
              selectedKey={has(selectedKey) ? selectedKey : null}
              draggedKey={has(session?.key) ? (session?.key ?? null) : null}
              dropBeforeKey={isTarget ? drop?.beforeKey : undefined}
              steps={steps}
              menuFor={menuFor}
              onDragStart={onCardDragStart}
              picked={picked}
              onPickToggle={onPickToggle}
            />
          ) : null}
        </BoardColumnSection>
      )
    })
    const first = column.statuses[0]
    return (
      <BoardColumn
        key={`${lane.id}:${column.index}`}
        title={column.title}
        status={column.title === undefined ? first : undefined}
        count={cards.length}
        className={grouped ? 'h-auto max-h-none' : undefined}
        scrolls={!grouped}
        emptyLabel={column.statuses.length === 0 ? 'No statuses in this column' : grouped ? 'None' : 'No tasks'}
        headerMenu={columnMenu(column, cards)}
        // A refusal shows in the create row itself.
        onCreate={
          first
            ? (summary) =>
                api.task_create({
                  summary,
                  status: first.id,
                  ...(grouped && lane.id !== UNASSIGNED ? { assignee: assigneeInput(lane.assignee) } : {}),
                })
            : undefined
        }
      >
        {sections}
      </BoardColumn>
    )
  }

  const toggleLane = (id: string) =>
    setCollapsedLanes((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })

  const anyFilter = query !== '' || FILTER_IDS.some((id) => current.filter[id] !== undefined)

  const deleteBoard = () =>
    confirm({
      title: `Delete the board "${board.name}"?`,
      description: 'It goes for everyone in the project. The tasks stay as they are.',
      action: 'Delete board',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.board_delete({ board: board.id })
          lastBoard(instanceId).set(null)
          legacy.toast.success(`Deleted ${board.name}`)
          navigate(hrefFor(['board']))
        } catch (error) {
          fail(error)
        }
      },
    })

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {/* The page's controls sit in the host's toolbar: the board, filters, saved views, and how the board is laid out. */}
      <AppToolbar>
        <TaskManagerToolbar
          label="Board controls"
          end={
            <span className="text-xs text-muted-foreground tabular-nums">
              {tasks === null ? '' : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${anyFilter ? ' shown' : ''}`}
            </span>
          }
        >
          <BoardPicker
            boards={boards}
            activeId={board.id}
            onSelect={(id) => navigate(hrefFor(['board', id]))}
            onCreate={() => navigate(hrefFor(['board', 'new']))}
            onEdit={() => navigate(hrefFor(['board', board.id, 'setup']))}
            onDelete={deleteBoard}
          />
          <TaskFilterBar
            layout="row"
            query={searchDraft}
            onQueryChange={setSearchDraft}
            searchRef={searchRef}
            filters={filters}
            values={values}
            onValuesChange={(id, next) => write(selectionParams(id, next, base.filter[id as FilterId]))}
            onClear={() => {
              setSearchDraft('')
              write({ q: textParam('', base.filter.query ?? ''), ...clearedParams(FILTER_IDS, base.filter) })
            }}
          >
            <TaskSavedViews {...savedViews.picker} />
          </TaskFilterBar>
          <BoardDisplayMenu
            swimlanes={grouped ? 'assignee' : 'none'}
            onSwimlanesChange={(id) => write({ group: id === 'assignee' ? 'assignee' : null })}
            // One column at a time on a phone: swimlanes are named there, not hidden.
            options={phone ? PHONE_SWIMLANE_OPTIONS : undefined}
          />
        </TaskManagerToolbar>
      </AppToolbar>

      {moveError ? (
        <div className="shrink-0 px-3 pb-2 sm:px-4">
          <TaskManagerError variant="inline" title={moveError.title} message={moveError.message} onDismiss={() => setMoveError(null)} />
        </div>
      ) : null}

      {tasks === null ? (
        loadError ? (
          <TaskManagerError
            title="Couldn't load the board"
            message={loadError}
            onRetry={() => {
              setLoadError(null)
              void load()
            }}
          />
        ) : (
          <TaskManagerSkeleton page="board" />
        )
      ) : phone ? (
        <BoardColumnPager
          className="min-h-0 flex-1 pt-2"
          columns={columns.map((column) => ({
            id: column.index,
            title: column.title,
            status: column.title === undefined ? column.statuses[0] : undefined,
            count: columnCards(NO_LANE, column).length,
          }))}
          // Remembered for this tab so coming back from a task returns to the same column. Not
          // kept in the URL: every navigation has the host restore each scrolled element's
          // position, which would pull the track back to the column a slide is leaving.
          defaultActiveIndex={Math.max(0, Number(sessionStorage.getItem(columnKey) ?? 0))}
          onActiveIndexChange={(index) => sessionStorage.setItem(columnKey, String(index))}
        >
          {columns.map((column) => renderColumn(column, lanes[0]))}
        </BoardColumnPager>
      ) : (
        <ScrollArea
          ref={boardRef}
          data-slot="board"
          scrollbars="both"
          className="flex-1"
          // As wide as its widest row, so the end padding scrolls into view; one row of columns fills the height and each column scrolls itself.
          innerClassName={cn('w-max px-3 py-3 sm:px-4', grouped ? 'gap-4' : 'h-full flex-row gap-3')}
        >
          {grouped
            ? lanes.map((lane) => {
                const count = tasks.filter((task) => laneOf(task) === lane.id).length
                const folded = collapsedLanes.has(lane.id)
                return (
                  <section key={lane.id} aria-label={lane.assignee?.name ?? 'Unassigned'} className="flex shrink-0 flex-col gap-2">
                    <ItemContextMenu
                      entries={[
                        folded
                          ? { id: 'expand', label: 'Expand lane', icon: UnfoldVertical, onSelect: () => toggleLane(lane.id) }
                          : { id: 'collapse', label: 'Collapse lane', icon: FoldVertical, onSelect: () => toggleLane(lane.id) },
                        { id: 'collapse-all', label: 'Collapse all lanes', icon: FoldVertical, onSelect: () => setCollapsedLanes(new Set(lanes.map((other) => other.id))) },
                        { id: 'expand-all', label: 'Expand all lanes', icon: UnfoldVertical, onSelect: () => setCollapsedLanes(new Set()) },
                      ]}
                      render={<button type="button" aria-expanded={!folded} onClick={() => toggleLane(lane.id)} />}
                      className="sticky left-0 flex w-fit items-center gap-2 rounded-md px-1 py-0.5 text-sm font-medium hover:bg-muted"
                    >
                      <TaskAssignee assignee={lane.assignee} withName size="sm" />
                      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                    </ItemContextMenu>
                    {folded ? null : <div className="flex items-start gap-3">{columns.map((column) => renderColumn(column, lane))}</div>}
                  </section>
                )
              })
            : columns.map((column) => renderColumn(column, lanes[0]))}
        </ScrollArea>
      )}

      {bulk.selected.length > 0 || bulk.result ? (
        <div className="shrink-0 px-3 pb-3 sm:px-4">
          <TaskBulkBar {...bulk} />
        </div>
      ) : null}

      {session && draggedTask && grab ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{ left: session.pointer.x - grab.dx, top: session.pointer.y - grab.dy, width: grab.width }}
        >
          <BoardCard task={withOpenBlockers(draggedTask)} workflowStep={steps.get(draggedTask.key) ?? null} dragState="overlay" />
        </div>
      ) : null}
    </div>
  )
}
