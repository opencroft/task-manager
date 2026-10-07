import { ArrowDown, ArrowLeft, ArrowRight, ArrowRightLeft, ArrowUp, Check, CircleAlert, Columns3, GripVertical, Loader2, Plus, Trash2, Undo2 } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import { Button } from '../button'
import { Input } from '../input'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { TaskManagerError } from '../states/task-manager-error'
import { type DragSession, useTimelineDrag } from '@/components/ui/timeline/use-timeline-drag'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'

/** One of the project's statuses. */
export interface BoardSetupStatus {
  id: number
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface BoardSetupColumn {
  /** Stays the same while the setup is edited; the host gives each loaded column one. */
  key: string
  /** Its own name; null to be named after its first status. */
  name: string | null
  /** Its statuses, top to bottom. */
  statusIds: number[]
}

/** How the board serves one workflow. */
export interface BoardSetupWorkflowFit {
  workflowId: string
  workflow: string
  /** The statuses its steps start on or finish into that no column holds; empty when the board serves it. */
  missing: number[]
}

/** Where a status goes: a column (by key) at an index among its other statuses, or off the board (`column` null). */
export interface BoardSetupPlace {
  column: string | null
  index: number
}

export interface BoardSetupEditorProps {
  /** A board being created rather than changed. */
  isNew?: boolean
  name: string
  onNameChange: (name: string) => void
  /** Every status of the project, in the project's order. */
  statuses: BoardSetupStatus[]
  /** Left to right. */
  columns: BoardSetupColumn[]
  onColumnsChange: (columns: BoardSetupColumn[]) => void
  /** The preset filter's controls, e.g. the filter bar. */
  filter?: ReactNode
  /** One per workflow of the project, for the columns as they are now. */
  workflowFit: BoardSetupWorkflowFit[]
  onSave: () => void
  onCancel: () => void
  /** Offers Delete board. Its handler confirms first. */
  onDelete?: () => void
  /** A save is running. */
  saving?: boolean
  /** Why the last save was refused. */
  error?: string | null
  onDismissError?: () => void
  className?: string
}

/** The columns with one status moved to `place`: out of the column it was in, into another or back into its own, or off the board. */
export function moveBoardStatus(columns: BoardSetupColumn[], statusId: number, place: BoardSetupPlace): BoardSetupColumn[] {
  const without = columns.map((column) =>
    column.statusIds.includes(statusId) ? { ...column, statusIds: column.statusIds.filter((id) => id !== statusId) } : column,
  )
  if (place.column === null) {
    return without
  }
  return without.map((column) =>
    column.key === place.column
      ? { ...column, statusIds: [...column.statusIds.slice(0, place.index), statusId, ...column.statusIds.slice(place.index)] }
      : column,
  )
}

let minted = 0

/** A key for a column added in the editor. */
function newColumnKey(): string {
  minted += 1
  return `new-${Date.now().toString(36)}-${minted}`
}

/** The drop place under the pointer: a column's list, where among its statuses, or the off-board tray. */
function placeAt(pointer: { x: number; y: number }, draggedId: number): BoardSetupPlace | null {
  const zone = document
    .elementsFromPoint(pointer.x, pointer.y)
    .find((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.setupDrop !== undefined)
  if (!zone) {
    return null
  }
  if (zone.dataset.setupDrop === 'off') {
    return { column: null, index: 0 }
  }
  const chips = [...zone.querySelectorAll<HTMLElement>('[data-setup-status]')].filter((chip) => Number(chip.dataset.setupStatus) !== draggedId)
  const index = chips.findIndex((chip) => {
    const box = chip.getBoundingClientRect()
    return pointer.y < box.top + box.height / 2
  })
  return { column: zone.dataset.setupColumn ?? null, index: index < 0 ? chips.length : index }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className='flex min-w-0 flex-col gap-2'>
      <div className='flex flex-col gap-0.5'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        {hint ? <p className='text-sm text-muted-foreground'>{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function DropLine() {
  return <li aria-hidden='true' className='h-0.5 shrink-0 rounded-full bg-primary' />
}

interface StatusChipProps {
  status: BoardSetupStatus
  menu: ItemMenuEntries
  dragged: boolean
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void
}

/** One status: dragged by its body with a mouse or pen; its menu moves it anywhere, on any device. */
function StatusChip({ status, menu, dragged, onDragStart }: StatusChipProps) {
  return (
    <li data-setup-status={status.id} className={cn('shrink-0 transition-opacity', dragged && 'opacity-40')}>
      <ItemContextMenu
        entries={menu}
        className='flex h-9 items-center gap-1 rounded-lg bg-background pr-0.5 pl-1 shadow-xs ring-1 ring-border'
      >
        <div onPointerDown={onDragStart} className='flex min-w-0 flex-1 cursor-grab items-center gap-1 self-stretch active:cursor-grabbing'>
          <GripVertical aria-hidden='true' className='size-4 shrink-0 text-muted-foreground/70' />
          <TaskStatusBadge name={status.name} category={status.category} color={status.color} size='sm' className='min-w-0 shrink' />
        </div>
        <ItemActionsMenu entries={menu} label={`Move ${status.name}`} size='icon-xs' />
      </ItemContextMenu>
    </li>
  )
}

/**
 * A board's setup. Left to right are its columns; top to bottom inside one,
 * the statuses that become its sections. A status is in one column or off
 * the board, and any status can be left off. The host owns every value and
 * saves; the editor holds only the drag in progress.
 */
export function BoardSetupEditor({
  isNew = false,
  name,
  onNameChange,
  statuses,
  columns,
  onColumnsChange,
  filter,
  workflowFit,
  onSave,
  onCancel,
  onDelete,
  saving = false,
  error,
  onDismissError,
  className,
}: BoardSetupEditorProps) {
  const statusOf = (id: number | undefined) => statuses.find((status) => status.id === id)
  const placed = new Set(columns.flatMap((column) => column.statusIds))
  const offBoard = statuses.filter((status) => !placed.has(status.id))
  const titleOf = (column: BoardSetupColumn, index: number) =>
    column.name ?? statusOf(column.statusIds[0])?.name ?? `Column ${index + 1}`

  const move = (statusId: number, place: BoardSetupPlace) => onColumnsChange(moveBoardStatus(columns, statusId, place))
  const toNewColumn = (statusId: number) => {
    const key = newColumnKey()
    onColumnsChange(moveBoardStatus([...columns, { key, name: null, statusIds: [] }], statusId, { column: key, index: 0 }))
  }
  const updateColumn = (key: string, change: Partial<BoardSetupColumn>) =>
    onColumnsChange(columns.map((column) => (column.key === key ? { ...column, ...change } : column)))
  const moveColumn = (from: number, to: number) => {
    const next = [...columns]
    const [column] = next.splice(from, 1)
    next.splice(to, 0, column)
    onColumnsChange(next)
  }

  const drop = (session: DragSession<'status'>) => placeAt(session.pointer, Number(session.key))
  const drag = useTimelineDrag<'status'>({
    onDrop: (session) => {
      const place = drop(session)
      if (place) {
        move(Number(session.key), place)
      }
    },
  })
  const draggedId = drag.session ? Number(drag.session.key) : null
  const target = drag.session ? drop(drag.session) : null
  const dragged = draggedId === null ? undefined : statusOf(draggedId)

  /** Move to ▸ a column or a new one; the column the status is in is left out. */
  const destinations = (statusId: number, from: string | null) => [
    ...columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => column.key !== from)
      .map(({ column, index }) => ({
        id: column.key,
        label: titleOf(column, index),
        onSelect: () => move(statusId, { column: column.key, index: column.statusIds.length }),
      })),
    { id: 'new-column', label: 'New column', icon: Plus, onSelect: () => toNewColumn(statusId) },
  ]

  const placedMenu = (statusId: number, column: BoardSetupColumn, index: number): ItemMenuEntries => [
    { id: 'up', label: 'Move up', icon: ArrowUp, disabled: index === 0, onSelect: () => move(statusId, { column: column.key, index: index - 1 }) },
    {
      id: 'down',
      label: 'Move down',
      icon: ArrowDown,
      disabled: index === column.statusIds.length - 1,
      onSelect: () => move(statusId, { column: column.key, index: index + 1 }),
    },
    { id: 'to', label: 'Move to', icon: ArrowRightLeft, group: 'change', entries: destinations(statusId, column.key) },
    { id: 'off', label: 'Take off the board', icon: Undo2, onSelect: () => move(statusId, { column: null, index: 0 }) },
  ]

  const offMenu = (statusId: number): ItemMenuEntries => [
    { id: 'to', label: 'Add to', icon: Plus, group: 'change', entries: destinations(statusId, null) },
  ]

  const columnMenu = (column: BoardSetupColumn, index: number): ItemMenuEntries => [
    { id: 'left', label: 'Move left', icon: ArrowLeft, disabled: index === 0, onSelect: () => moveColumn(index, index - 1) },
    { id: 'right', label: 'Move right', icon: ArrowRight, disabled: index === columns.length - 1, onSelect: () => moveColumn(index, index + 1) },
    {
      id: 'remove',
      label: 'Remove column',
      icon: Trash2,
      onSelect: () => onColumnsChange(columns.filter((other) => other.key !== column.key)),
    },
  ]

  const chips = (ids: number[], menuOf: (id: number, index: number) => ItemMenuEntries, zone: string | null) => {
    const items: ReactNode[] = []
    const shown = target && zone !== null && target.column === zone
    const others = ids.filter((id) => id !== draggedId)
    ids.forEach((id, index) => {
      const status = statusOf(id)
      if (!status) {
        return
      }
      if (shown && others[target.index] === id) {
        items.push(<DropLine key='drop' />)
      }
      items.push(
        <StatusChip
          key={id}
          status={status}
          menu={menuOf(id, index)}
          dragged={id === draggedId}
          onDragStart={(event) => drag.start(String(id), 'status', event)}
        />,
      )
    })
    if (shown && target.index >= others.length) {
      items.push(<DropLine key='drop' />)
    }
    return items
  }

  return (
    <div data-slot='board-setup-editor' className={cn('flex min-w-0 flex-col gap-6', className)}>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='mr-auto text-lg font-semibold'>{isNew ? 'New board' : 'Board setup'}</h2>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={saving || !name.trim()}>
          {saving ? <Loader2 className='animate-spin' /> : null}
          {isNew ? 'Create board' : 'Save'}
        </Button>
      </div>

      {error ? <TaskManagerError variant='inline' title='The board was not saved' message={error} onDismiss={onDismissError} /> : null}

      <label className='flex max-w-sm flex-col gap-1.5'>
        <span className='text-sm font-semibold'>Name</span>
        <Input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder='e.g. Delivery' maxLength={80} />
      </label>

      <Section
        title='Columns'
        hint='Left to right, the board’s columns; top to bottom, the sections of a column. Drag a status, or use its menu. A column left with no statuses is not saved.'
      >
        <ScrollArea scrollbars='horizontal' className='-mx-1' innerClassName='flex-row items-start gap-3 px-1 pb-3'>
          {columns.map((column, index) => {
            const over = target?.column === column.key
            return (
              <div
                key={column.key}
                data-setup-drop='column'
                data-setup-column={column.key}
                className={cn(
                  'flex w-60 max-w-[calc(100vw-3rem)] shrink-0 flex-col gap-2 rounded-xl bg-muted/60 p-2 transition-colors',
                  over && 'bg-primary/5 ring-2 ring-primary/30',
                )}
              >
                <div className='flex items-center gap-1'>
                  <Input
                    aria-label={`Name of column ${index + 1}`}
                    value={column.name ?? ''}
                    placeholder={titleOf({ ...column, name: null }, index)}
                    maxLength={80}
                    onChange={(event) => updateColumn(column.key, { name: event.target.value.trim() ? event.target.value : null })}
                    className='h-8'
                  />
                  <ItemActionsMenu entries={columnMenu(column, index)} label={`${titleOf(column, index)} column actions`} size='icon-xs' />
                </div>
                <ul className='flex min-h-16 flex-col gap-1.5'>
                  {column.statusIds.length === 0 && !over ? (
                    <li className='flex min-h-16 items-center justify-center rounded-lg border-2 border-dashed border-border px-3 text-center text-sm text-muted-foreground'>
                      Drop statuses here. Left empty, it is not saved.
                    </li>
                  ) : (
                    chips(column.statusIds, (id, at) => placedMenu(id, column, at), column.key)
                  )}
                </ul>
              </div>
            )
          })}
          <Button
            variant='outline'
            className='h-auto min-h-24 w-40 shrink-0 flex-col gap-1 border-dashed text-muted-foreground'
            onClick={() => onColumnsChange([...columns, { key: newColumnKey(), name: null, statusIds: [] }])}
          >
            <Columns3 />
            Add column
          </Button>
        </ScrollArea>

        <div
          data-setup-drop='off'
          className={cn(
            'flex flex-col gap-2 rounded-xl border border-dashed p-3 transition-colors',
            target?.column === null && 'border-primary/40 bg-primary/5',
          )}
        >
          <p className='text-sm font-medium'>Not on the board</p>
          {offBoard.length > 0 ? (
            <ul className='flex flex-wrap gap-1.5'>{chips(offBoard.map((status) => status.id), (id) => offMenu(id), null)}</ul>
          ) : (
            <p className='text-sm text-muted-foreground'>Every status is on the board. Drop one here to leave it off.</p>
          )}
        </div>
      </Section>

      {filter ? (
        <Section title='Preset filter' hint='The board shows only the tasks that match.'>
          {filter}
        </Section>
      ) : null}

      <Section title='Workflows' hint='A workflow is served when every status its steps start on or finish into is on the board.'>
        {workflowFit.length > 0 ? (
          <ul className='flex flex-col divide-y rounded-lg border'>
            {workflowFit.map((fit) => (
              <li key={fit.workflowId} className='flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm'>
                {fit.missing.length > 0 ? (
                  <CircleAlert aria-hidden='true' className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />
                ) : (
                  <Check aria-hidden='true' className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
                )}
                <span className='font-medium'>{fit.workflow}</span>
                {fit.missing.length > 0 ? (
                  <>
                    <span className='text-muted-foreground'>is missing</span>
                    {fit.missing.map((id) => {
                      const status = statusOf(id)
                      return status ? (
                        <TaskStatusBadge key={id} name={status.name} category={status.category} color={status.color} size='sm' />
                      ) : null
                    })}
                  </>
                ) : (
                  <span className='text-muted-foreground'>has every status it needs</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-sm text-muted-foreground'>This project has no workflows.</p>
        )}
      </Section>

      {onDelete ? (
        <div className='border-t pt-4'>
          <Button variant='ghost' className='text-destructive hover:text-destructive' onClick={onDelete} disabled={saving}>
            <Trash2 />
            Delete board…
          </Button>
        </div>
      ) : null}

      {drag.session && dragged ? (
        <div className='pointer-events-none fixed z-50' style={{ left: drag.session.pointer.x + 8, top: drag.session.pointer.y + 8 }}>
          <TaskStatusBadge name={dragged.name} category={dragged.category} color={dragged.color} className='shadow-md ring-1 ring-border' />
        </div>
      ) : null}
    </div>
  )
}
