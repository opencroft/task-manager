// The Tasks page: every task of the project in a table, with search, filters,
// sorting and the table's columns kept in the URL (so a filtered view is a
// link), live refresh, and inline create at the end of the list.

import { AppToolbar } from '@opencroft/client/app'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, EyeOff, Rows3 } from 'lucide-react'
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TaskManagerToolbar } from '@/components/ui/navigation/task-manager-toolbar'
import { TaskManagerEmpty } from '@/components/ui/states/task-manager-empty'
import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskBulkBar } from '@/components/ui/tasks/task-bulk-bar'
import { TaskColumnPicker } from '@/components/ui/tasks/task-column-picker'
import { TaskElsewhereList } from '@/components/ui/tasks/task-elsewhere-list'
import { TaskFilterBar } from '@/components/ui/tasks/task-filter-bar'
import { TaskInlineCreate } from '@/components/ui/tasks/task-inline-create'
import { taskFieldEntries } from '@/components/ui/tasks/task-menu'
import { TASK_PRIORITIES, TaskPriorityIcon } from '@/components/ui/tasks/task-priority-icon'
import { TaskSavedViews } from '@/components/ui/tasks/task-saved-views'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import {
  TASK_TABLE_HEADS,
  TaskTable,
  type TaskTableColumn,
  type TaskTableRow,
  type TaskTableSort,
} from '@/components/ui/tasks/task-table'
import { TASK_TYPES, TaskTypeIcon } from '@/components/ui/tasks/task-type-icon'
import type { TaskListInput, TaskParent, TaskSummary } from '../../shared/types'
import { DEFAULT_TASK_COLUMNS, REQUIRED_TASK_COLUMNS, type TaskColumn } from '../../shared/views'
import { PageScrollerContext } from '../app/page-scroll'
import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { openTask, openTaskIn, taskHref, taskHrefIn } from '../app/task-opener'
import { errorMessage } from '../lib/api'
import { useElsewhereSearch } from '../lib/elsewhere'
import { clearedParams, selectionOf, selectionParams, textParam } from '../lib/filter-params'
import { useTasksLive } from '../lib/live'
import { hrefFor, navigate, useTasksLocation } from '../lib/router'
import { taskFilterDefs } from '../lib/task-filters'
import { keepUnchanged, listAllTasks } from '../lib/task-list'
import { columnsParam } from './task-columns'
import { useBulkActions } from './use-bulk-actions'
import { useSavedViews } from './use-saved-views'
import { sortParam } from './view-state'

const FILTER_IDS = ['status', 'assignee', 'type', 'priority', 'label', 'version', 'parent'] as const
type FilterId = (typeof FILTER_IDS)[number]

// Module-level, so the table's memoised rows see the same values on every render.
const NO_TASKS: TaskSummary[] = []

const GROUPS = ['status', 'assignee', 'priority', 'type'] as const
type GroupBy = (typeof GROUPS)[number]
const GROUP_LABELS: Record<GroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  type: 'Type',
}

/**
 * The current URL's view state: what the page shows, read against the shown
 * saved view (`base`), and `write`, which patches the URL. A null value
 * removes a parameter; an empty one stays, as "nothing" where the view has
 * something. Everything read keeps its identity until the URL or the view
 * changes: the list's fetch is keyed on it, so a new object on every render
 * would fetch again after every answer.
 */
function useViewState() {
  const location = useTasksLocation()
  const savedViews = useSavedViews('tasks', location)
  const { current, base } = savedViews
  const query = current.filter.query ?? ''
  const values = useMemo(
    () =>
      Object.fromEntries(FILTER_IDS.map((id) => [id, selectionOf(current.filter[id])])) as Record<
        FilterId,
        ReturnType<typeof selectionOf>
      >,
    [current.filter],
  )
  const groupParam = location.query.get('group')
  const group: GroupBy | null = GROUPS.includes(groupParam as GroupBy) ? (groupParam as GroupBy) : null
  const viewSort = current.filter.sort
  const sort = useMemo<TaskTableSort | null>(
    () => (viewSort ? { field: viewSort.field as TaskTableSort['field'], dir: viewSort.dir } : null),
    [viewSort],
  )

  const write = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(location.query)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
      }
      navigate(hrefFor(['tasks'], next), { replace: true })
    },
    [location.query],
  )
  return { current, base, savedViews, query, values, sort, group, write }
}

export function TasksPage() {
  const { api, instanceId, statuses, assignees, labels, versions, fail, menuFor } = useProject()
  const { current, base, savedViews, query, values, sort, group, write } = useViewState()
  const columns = current.columns ?? [...DEFAULT_TASK_COLUMNS]
  const writeSort = (next: string) => write({ sort: textParam(next, sortParam(base.filter.sort)) })
  // The table's scroller is the page's: Back and Forward return the list to where it was.
  const pageScroller = useContext(PageScrollerContext)
  const rowMenu = useCallback((row: TaskTableRow) => menuFor(row as TaskSummary), [menuFor])
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const bulk = useBulkActions(tasks ?? NO_TASKS, selection, setSelection)
  const [parents, setParents] = useState<TaskParent[]>([])

  // A picked task the list no longer shows (filtered out, deleted elsewhere) is dropped from the pick.
  useEffect(() => {
    if (!tasks) {
      return
    }
    const shown = new Set(tasks.map((task) => task.key))
    setSelection((current) =>
      current.every((key) => shown.has(key)) ? current : current.filter((key) => shown.has(key)),
    )
  }, [tasks])
  const [loadError, setLoadError] = useState<string | null>(null)
  // Whether anything has loaded yet: a failing first load shows the page's error state, a later one a toast.
  const loaded = useRef(false)
  const [searchDraft, setSearchDraft] = useState(query)
  const requestId = useRef(0)

  // The search box writes the URL after a short pause, not on every key.
  useEffect(() => setSearchDraft(query), [query])
  useEffect(() => {
    if (searchDraft === query) {
      return
    }
    const timer = setTimeout(() => write({ q: textParam(searchDraft.trim(), base.filter.query ?? '') }), 200)
    return () => clearTimeout(timer)
  }, [searchDraft, query, write, base])

  // A view's filter is what task_list takes.
  const input: TaskListInput = current.filter
  const filtered = query !== '' || FILTER_IDS.some((id) => current.filter[id] !== undefined)
  // The same search in the other projects, while there is one.
  const elsewhere = useElsewhereSearch(query, query !== '')

  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const result = await listAllTasks(api, input)
      if (id !== requestId.current) {
        return
      }
      setTasks((previous) => keepUnchanged(previous, result))
      setLoadError(null)
      loaded.current = true
    } catch (error) {
      if (id === requestId.current) {
        // A first load that fails gets the page's error state; a later one keeps the list and says why.
        if (loaded.current) {
          fail(error)
        } else {
          setLoadError(errorMessage(error))
        }
      }
    }
  }, [api, input, fail])

  // The Parent filter offers every task that has subtasks, whatever the list shows. They are
  // asked for on their own, so a filter change fetches the filtered list and nothing else.
  const loadParents = useCallback(async () => {
    try {
      setParents(await api.task_parents({}))
    } catch {
      // The filter keeps the parents it had; the list's own load reports a failure.
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadParents()
  }, [loadParents])
  useTasksLive(instanceId, () => {
    void load()
    void loadParents()
  })

  const filters = useMemo(
    () => taskFilterDefs(FILTER_IDS, { statuses, assignees, labels, versions, parents }),
    [statuses, assignees, labels, versions, parents],
  )

  // The columns live in the URL, so a link keeps them and a saved view stores them. The grouping lives there too, for links only.
  const setColumns = (next: TaskColumn[]) => write({ cols: columnsParam(next, base.columns ?? DEFAULT_TASK_COLUMNS) })
  const moveColumn = (column: TaskColumn, by: -1 | 1) => {
    const next = [...columns]
    const at = next.indexOf(column)
    next.splice(at, 1)
    next.splice(at + by, 0, column)
    setColumns(next)
  }

  const headerMenu = (column: TaskTableColumn): ItemMenuEntries => {
    const field = TASK_TABLE_HEADS[column].sort
    const at = columns.indexOf(column)
    const active = field && sort?.field === field ? sort.dir : null
    const sortTo = (dir: 'asc' | 'desc' | null) => writeSort(dir && field ? `${field}.${dir}` : '')
    return [
      field && {
        id: 'sort',
        label: 'Sort',
        icon: ArrowUp,
        group: 'change',
        entries: [
          { id: 'asc', label: 'Ascending', icon: ArrowUp, checked: active === 'asc', onSelect: () => sortTo('asc') },
          {
            id: 'desc',
            label: 'Descending',
            icon: ArrowDown,
            checked: active === 'desc',
            onSelect: () => sortTo('desc'),
          },
          { id: 'none', label: 'List order', checked: active === null, onSelect: () => sortTo(null) },
        ],
      },
      {
        id: 'group',
        label: 'Group by',
        icon: Rows3,
        group: 'change',
        entries: [
          { id: 'none', label: 'No grouping', checked: group === null, onSelect: () => write({ group: null }) },
          ...GROUPS.map((by) => ({
            id: by,
            label: GROUP_LABELS[by],
            checked: group === by,
            onSelect: () => write({ group: by }),
          })),
        ],
      },
      at > 0 && {
        id: 'left',
        label: 'Move left',
        icon: ArrowLeft,
        group: 'act',
        onSelect: () => moveColumn(column, -1),
      },
      at < columns.length - 1 && {
        id: 'right',
        label: 'Move right',
        icon: ArrowRight,
        group: 'act',
        onSelect: () => moveColumn(column, 1),
      },
      !REQUIRED_TASK_COLUMNS.includes(column) && {
        id: 'hide',
        label: `Hide ${TASK_TABLE_HEADS[column].label}`,
        icon: EyeOff,
        group: 'act',
        onSelect: () => setColumns(columns.filter((shown) => shown !== column)),
      },
    ]
  }

  // Status, assignee and priority cells change in place; one function for the table's life.
  const cellMenu = useCallback(
    (row: TaskTableRow, column: TaskTableColumn): ItemMenuEntries =>
      column === 'status' || column === 'assignee' || column === 'priority'
        ? taskFieldEntries(menuFor(row as TaskSummary), column)
        : [],
    [menuFor],
  )

  // Grouped, the rows keep the list's order inside each group.
  const groupOf = useMemo(() => {
    // Statuses give the status groups their order; until they load the list shows ungrouped.
    if (!group || (group === 'status' && statuses.length === 0)) {
      return undefined
    }
    const statusIndex = new Map(statuses.map((status, index) => [status.id, index]))
    const of = (row: TaskTableRow): { id: string; label: ReactNode; rank: number | string } => {
      switch (group) {
        case 'status':
          return {
            id: String(row.status.id),
            label: (
              <TaskStatusBadge
                name={row.status.name}
                category={row.status.category}
                color={row.status.color}
                size='sm'
              />
            ),
            rank: statusIndex.get(row.status.id) ?? 0,
          }
        case 'assignee':
          return {
            id: row.assignee ? `${row.assignee.kind}:${row.assignee.name}` : 'none',
            label: <TaskAssignee assignee={row.assignee} withName size='sm' />,
            rank: row.assignee ? row.assignee.name.toLowerCase() : '\uffff',
          }
        case 'priority':
          return {
            id: row.priority,
            label: <TaskPriorityIcon priority={row.priority} withLabel />,
            rank: TASK_PRIORITIES.indexOf(row.priority),
          }
        case 'type':
          return { id: row.type, label: <TaskTypeIcon type={row.type} withLabel />, rank: TASK_TYPES.indexOf(row.type) }
      }
    }
    return of
  }, [group, statuses])
  const rows = useMemo(() => {
    if (!tasks || !groupOf) {
      return tasks ?? NO_TASKS
    }
    return [...tasks].sort((a, b) => {
      const x = groupOf(a).rank
      const y = groupOf(b).rank
      return x < y ? -1 : x > y ? 1 : 0
    })
  }, [tasks, groupOf])

  const clearFilters = () => {
    setSearchDraft('')
    write({ q: textParam('', base.filter.query ?? ''), ...clearedParams(FILTER_IDS, base.filter) })
  }

  // A task created here lands under the parent the list is filtered to, when it is filtered to just one.
  const onlyParent = values.parent.include.length === 1 ? values.parent.include[0] : undefined
  const parentFilter = onlyParent && onlyParent !== 'none' ? onlyParent : undefined
  const searchRef = useRef<HTMLInputElement>(null)
  const { selectedKey } = usePageShortcuts({
    onSearch: () => searchRef.current?.focus(),
    createTask: async (summary) => (await api.task_create({ summary, parent: parentFilter })).result.key,
  })

  // A refusal shows in the create row itself.
  const create = async (summary: string) => {
    const { result } = await api.task_create({ summary, parent: parentFilter })
    if (filtered && !tasks?.some((task) => task.key === result.key)) {
      toast.success(`Created ${result.key}`, {
        description: 'It is hidden by the current filters.',
        action: { label: 'Open', onClick: () => openTask(result.key) },
      })
    }
  }

  if (tasks === null) {
    return loadError ? (
      <TaskManagerError
        title="Couldn't load tasks"
        message={loadError}
        onRetry={() => {
          setLoadError(null)
          void load()
        }}
      />
    ) : (
      <TaskManagerSkeleton page='tasks' />
    )
  }

  // A project with no tasks at all: the first screen, with the create field open.
  if (tasks.length === 0 && !filtered) {
    return <TaskManagerEmpty kind='no-tasks' onCreateTask={create} />
  }

  return (
    // Fills the pane: the table takes the height left and scrolls its rows inside it, heads and create row staying put.
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4'>
      {/* The filter panel sits in the host's toolbar. */}
      <AppToolbar>
        <TaskManagerToolbar
          label='Tasks controls'
          end={
            <span className='text-xs text-muted-foreground tabular-nums'>
              {`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
            </span>
          }
        >
          <TaskFilterBar
            layout='row'
            query={searchDraft}
            onQueryChange={setSearchDraft}
            searchRef={searchRef}
            filters={filters}
            values={values}
            onValuesChange={(id, next) => write(selectionParams(id, next, base.filter[id as FilterId]))}
            onClear={clearFilters}
          >
            <TaskSavedViews {...savedViews.picker} />
          </TaskFilterBar>
          <TaskColumnPicker
            columns={columns}
            onColumnsChange={setColumns}
            required={REQUIRED_TASK_COLUMNS}
            defaultColumns={DEFAULT_TASK_COLUMNS}
          />
        </TaskManagerToolbar>
      </AppToolbar>
      {query ? (
        <TaskElsewhereList
          tasks={elsewhere.tasks}
          searching={elsewhere.searching}
          hrefFor={(task) => taskHrefIn(task.key, task.project)}
          onOpen={(task, event) => {
            event.preventDefault()
            openTaskIn(task.key, task.project)
          }}
        />
      ) : null}
      <div className='flex min-h-0 flex-col overflow-hidden rounded-lg border'>
        <TaskTable
          scrollRef={pageScroller}
          rows={rows}
          columns={columns}
          sort={sort}
          selectedKey={selectedKey}
          selection={selection}
          onSelectionChange={setSelection}
          onSortChange={(next) => writeSort(next ? `${next.field}.${next.dir}` : '')}
          onOpen={openTask}
          hrefFor={taskHref}
          menuFor={rowMenu}
          headerMenu={headerMenu}
          cellMenu={cellMenu}
          groupOf={groupOf}
          empty={<TaskManagerEmpty kind='no-results' size='compact' onClearFilters={clearFilters} />}
          footer={<TaskInlineCreate onCreate={create} />}
        />
      </div>
      <TaskBulkBar {...bulk} className='sticky bottom-3' />
    </div>
  )
}
