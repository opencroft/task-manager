// A board's setup, at /board/new and /board/<id>/setup: its name, its
// columns of statuses, its preset filter, and which workflows it serves.
// Nothing is saved until Save; Cancel goes back to the board.

import { Bookmark } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { type BoardSetupColumn, BoardSetupEditor } from '@/components/ui/tasks/board-setup-editor'
import { TaskFilterBar } from '@/components/ui/tasks/task-filter-bar'
import { BOARD_FILTER_KEYS, type Board, type BoardFilter, workflowFit } from '../../shared/boards'
import { compactFieldFilter, type FieldFilter } from '../../shared/filters'
import type { SavedView } from '../../shared/views'
import type { WorkflowDef } from '../../shared/workflows'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { hrefFor, navigate } from '../lib/router'
import { taskFilterDefs } from '../lib/task-filters'
import { workflowsApi } from '../workflows/api'
import { lastBoard } from './use-boards'

/** The filter menus a preset filter offers; `parent` stays an agent's (board_save). */
const FILTER_IDS = ['assignee', 'type', 'priority', 'label', 'version'] as const
type FilterId = (typeof FILTER_IDS)[number]

/** The columns as the editor holds them, each with a key that stays put while they move. */
function editableColumns(board: Board | null): BoardSetupColumn[] {
  if (!board) {
    return [{ key: 'c0', name: null, statusIds: [] }]
  }
  return board.columns.map((column, index) => ({
    key: `c${index}`,
    name: column.name,
    statusIds: column.statuses.map((status) => status.id),
  }))
}

/** A saved view's filter as a board's: its status and sort have no place on a board. */
function presetOf(view: SavedView): BoardFilter {
  return Object.fromEntries(
    Object.entries(view.filter).filter(([key]) => (BOARD_FILTER_KEYS as readonly string[]).includes(key)),
  ) as BoardFilter
}

export interface BoardSetupPageProps {
  /** The board to change; null for a new one. */
  board: Board | null
  /** After a save: the page opens the board once its list has it. */
  onSaved: (board: Board) => Promise<void>
}

export function BoardSetupPage({ board, onSaved }: BoardSetupPageProps) {
  const { api, instanceId, statuses, assignees, labels, versions, fail, confirm } = useProject()
  const [name, setName] = useState(board?.name ?? '')
  const [columns, setColumns] = useState(() => editableColumns(board))
  const [filter, setFilter] = useState<BoardFilter>(board?.filter ?? {})
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([])
  const [views, setViews] = useState<SavedView[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const back = board ? hrefFor(['board', board.id]) : hrefFor(['board'])

  useEffect(() => {
    workflowsApi(instanceId)
      .workflows_list({})
      .then((answer) => setWorkflows(answer.workflows), fail)
    api.view_list({}).then(setViews, fail)
  }, [api, instanceId, fail])

  const fit = useMemo(
    () =>
      workflowFit(new Set(columns.flatMap((column) => column.statusIds)), workflows, statuses).map((entry) => ({
        workflowId: entry.workflowId,
        workflow: entry.workflow,
        missing: entry.missing.map((status) => status.id),
      })),
    [columns, workflows, statuses],
  )
  const filters = useMemo(
    () => taskFilterDefs(FILTER_IDS, { statuses, assignees, labels, versions }),
    [statuses, assignees, labels, versions],
  )
  const values = Object.fromEntries(
    FILTER_IDS.map((id) => [id, filter[id] as FieldFilter<string> | undefined]),
  ) as Record<FilterId, FieldFilter<string> | undefined>

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await api.board_save({
        ...(board ? { id: board.id } : {}),
        name,
        // A column with no statuses would hold no task; it is left off the saved board.
        columns: columns
          .filter((column) => column.statusIds.length > 0)
          .map((column) => ({ name: column.name, statuses: column.statusIds })),
        filter,
      })
      await onSaved(saved)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const remove = board
    ? () =>
        confirm({
          title: `Delete the board "${board.name}"?`,
          description: 'It goes for everyone in the project. The tasks stay as they are.',
          action: 'Delete board',
          destructive: true,
          onConfirm: async () => {
            try {
              await api.board_delete({ board: board.id })
              lastBoard(instanceId).set(null)
              toast.success(`Deleted ${board.name}`)
              navigate(hrefFor(['board']))
            } catch (failure) {
              fail(failure)
            }
          },
        })
    : undefined

  const fromView =
    views.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant='outline' size='sm' />}>
          <Bookmark />
          From a saved view
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='max-h-72 min-w-48 overflow-y-auto'>
          {views.map((view) => (
            <DropdownMenuItem key={view.id} onClick={() => setFilter(presetOf(view))}>
              {view.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null

  return (
    <ScrollArea className='min-h-0 flex-1' innerClassName='mx-auto w-full max-w-6xl px-3 py-4 sm:px-6'>
      <BoardSetupEditor
        isNew={board === null}
        name={name}
        onNameChange={setName}
        statuses={statuses}
        columns={columns}
        onColumnsChange={setColumns}
        workflowFit={fit}
        filter={
          <TaskFilterBar
            query={filter.query ?? ''}
            onQueryChange={(query) => setFilter((current) => ({ ...current, query: query || undefined }))}
            searchPlaceholder='Text in the summary or description'
            filters={filters}
            values={values}
            onValuesChange={(id, next) => setFilter((current) => ({ ...current, [id]: compactFieldFilter(next) }))}
            // A parent preset (set by an agent) has no menu here, so clearing leaves it.
            onClear={() => setFilter((current) => (current.parent ? { parent: current.parent } : {}))}
          >
            {fromView}
          </TaskFilterBar>
        }
        onSave={() => void save()}
        onCancel={() => navigate(back)}
        onDelete={remove}
        saving={saving}
        error={error}
        onDismissError={() => setError(null)}
      />
    </ScrollArea>
  )
}
