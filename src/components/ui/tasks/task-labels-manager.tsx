import { Check, CircleAlert, GitMerge, Loader2, MoreHorizontal, Palette, Pencil, Search, Tag, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react'

import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu'
import { Input } from '../input'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries, MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'
import { TASK_LABEL_COLOR_NAMES, TASK_LABEL_COLORS, TaskLabelChip, type TaskLabelColor, TaskLabelDot } from './task-label-chip'

/** One label of the project. Labels are plain strings on tasks, so the name is the identity. */
export interface TaskLabel {
  name: string
  /** Null: no colour chosen, a plain chip. */
  color: TaskLabelColor | null
  /** Tasks carrying it. */
  count: number
}

/** The longest label name the server takes. */
export const TASK_LABEL_MAX_LENGTH = 50

/** A name as the server stores it: runs of whitespace as one space, trimmed. */
export function cleanLabelName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Why `next` cannot be `name`'s new name, or null when it can: empty, too long,
 * or another label's name in any case (merge into that one instead). A change
 * of case alone is a rename.
 */
export function labelRenameProblem(name: string, next: string, labels: readonly TaskLabel[]): { message: string; existing?: string } | null {
  const clean = cleanLabelName(next)
  if (!clean) {
    return { message: 'A label needs a name.' }
  }
  if (clean.length > TASK_LABEL_MAX_LENGTH) {
    return { message: `At most ${TASK_LABEL_MAX_LENGTH} characters; this is ${clean.length}.` }
  }
  const taken = labels.find((label) => label.name !== name && label.name.toLowerCase() === clean.toLowerCase())
  return taken ? { message: `“${taken.name}” already exists; merge instead.`, existing: taken.name } : null
}

export interface TaskLabelsManagerProps {
  /** The project's labels, in the order to list them. */
  labels: readonly TaskLabel[]
  loading?: boolean
  /** Why the labels could not load; shown with Retry. */
  error?: string | null
  onRetry?: () => void
  /** Each change below shows in its row while it runs, and a rejection's message in place. Without one, that action is not offered. */
  onRename?: (name: string, next: string) => Promise<unknown> | void
  onColorChange?: (name: string, color: TaskLabelColor | null) => Promise<unknown> | void
  onMerge?: (from: string, into: string) => Promise<unknown> | void
  onDelete?: (name: string) => Promise<unknown> | void
  className?: string
}

type Pending = { kind: 'rename'; to: string } | { kind: 'color' } | { kind: 'merge'; into: string } | { kind: 'delete' }

/** From this many labels on, a filter field leads the list. */
const FILTER_FROM = 12

function tasks(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}`
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function pendingText(pending: Pending): string {
  switch (pending.kind) {
    case 'rename':
      return `Renaming to “${pending.to}”…`
    case 'color':
      return 'Saving the colour…'
    case 'merge':
      return `Merging into “${pending.into}”…`
    case 'delete':
      return 'Deleting…'
  }
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase())
}

/** No colour, drawn as an empty ring beside the palette's dots. */
function NoColorDot({ className }: { className?: string }) {
  return <span aria-hidden='true' className={cn('size-2 shrink-0 rounded-full border border-dashed border-muted-foreground', className)} />
}

const COLOR_ICONS = Object.fromEntries(
  TASK_LABEL_COLORS.map((color) => [color, ({ className }: { className?: string }) => <TaskLabelDot color={color} className={cn('size-2.5', className)} />]),
) as Record<TaskLabelColor, (props: { className?: string }) => ReactNode>

const NoColorIcon = ({ className }: { className?: string }) => <NoColorDot className={cn('size-2.5', className)} />

function Problem({ children, action, onDismiss }: { children: ReactNode; action?: ReactNode; onDismiss?: () => void }) {
  return (
    <div role='alert' className='flex min-w-0 items-start gap-1.5 text-xs text-destructive'>
      <CircleAlert aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
      <p className='min-w-0 flex-1 break-words'>{children}</p>
      {action}
      {onDismiss ? (
        <Button variant='ghost' size='icon-xs' className='-my-0.5 size-5' aria-label='Dismiss' onClick={onDismiss}>
          <X aria-hidden='true' />
        </Button>
      ) : null}
    </div>
  )
}

interface RenameFieldProps {
  label: TaskLabel
  labels: readonly TaskLabel[]
  busy: boolean
  onCommit: (next: string) => void
  onCancel: () => void
  onMergeInstead?: (into: string) => void
}

/**
 * The name in an input: Enter or leaving saves, Esc puts it back. A name that
 * cannot be used is refused in place, and the field stays open to fix it; for
 * another label's name it offers the merge instead.
 */
function RenameField({ label, labels, busy, onCommit, onCancel, onMergeInstead }: RenameFieldProps) {
  const [value, setValue] = useState(label.name)
  const [tried, setTried] = useState(false)
  const problem = labelRenameProblem(label.name, value, labels)
  const finish = (commit: boolean) => {
    if (busy) {
      return
    }
    const next = cleanLabelName(value)
    if (!commit || next === label.name) {
      onCancel()
      return
    }
    if (problem) {
      setTried(true)
      return
    }
    onCommit(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }
  // Taken names show at once; an empty or too-long one once Enter was pressed, so typing a new name is not scolded.
  const shown = problem && (tried || problem.existing) ? problem : null
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <Input
        // biome-ignore lint/a11y/noAutofocus: the field appears because Rename was just chosen.
        autoFocus
        value={value}
        disabled={busy}
        aria-label={`New name for ${label.name}`}
        aria-invalid={shown ? true : undefined}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          // Pressing “Merge into” below must not count as leaving the field.
          if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.renameMerge !== undefined) {
            return
          }
          finish(true)
        }}
        onFocus={(event) => event.currentTarget.select()}
        className='h-7 min-w-0 px-2 text-sm'
      />
      {shown ? (
        <Problem
          action={
            shown.existing && onMergeInstead ? (
              <Button
                variant='ghost'
                size='xs'
                data-rename-merge=''
                className='-my-0.5 h-5 px-1.5'
                onClick={() => onMergeInstead(shown.existing as string)}
              >
                <GitMerge aria-hidden='true' />
                Merge into it
              </Button>
            ) : null
          }
        >
          {shown.message}
        </Problem>
      ) : null}
    </div>
  )
}

interface ColorButtonProps {
  label: TaskLabel
  disabled: boolean
  onPick: (color: TaskLabelColor | null) => void
}

/** The label's colour as a button that opens the palette. Always visible, so it works without a hover. */
function ColorButton({ label, disabled, onPick }: ColorButtonProps) {
  const name = label.color ? TASK_LABEL_COLOR_NAMES[label.color] : 'No colour'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant='ghost' size='icon-sm' aria-label={`Colour of ${label.name}: ${name}`} title={`Colour: ${name}`} className='shrink-0' />}
      >
        {label.color ? <TaskLabelDot color={label.color} className='size-3' /> : <NoColorDot className='size-3' />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className={cn('max-h-80 w-auto min-w-40', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          {[null, ...TASK_LABEL_COLORS].map((color) => {
            const Icon = color ? COLOR_ICONS[color] : NoColorIcon
            return (
              <DropdownMenuItem key={color ?? 'none'} onClick={() => onPick(color)}>
                <Icon />
                {color ? TASK_LABEL_COLOR_NAMES[color] : 'No colour'}
                <Check aria-hidden='true' className={cn('ml-auto size-4', label.color === color ? 'opacity-100' : 'opacity-0')} />
              </DropdownMenuItem>
            )
          })}
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The project's labels as a managed list: each label's chip, its colour and
 * how many tasks carry it, with rename in place, a colour, merge into another
 * label and delete after a confirm. A change shows in its row while it runs;
 * a rejection's message stays there until dismissed. Nothing is created
 * here: a label exists while a task carries it.
 */
export function TaskLabelsManager({
  labels,
  loading = false,
  error = null,
  onRetry,
  onRename,
  onColorChange,
  onMerge,
  onDelete,
  className,
}: TaskLabelsManagerProps) {
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [merging, setMerging] = useState<{ from: string; into: string | null } | null>(null)
  const [mergeFilter, setMergeFilter] = useState('')
  const [deleting, setDeleting] = useState<TaskLabel | null>(null)
  const renameBusy = useRef(false)

  const setFor = <T,>(set: (update: (current: Record<string, T>) => Record<string, T>) => void, name: string, value: T | null) =>
    set((current) => {
      const next = { ...current }
      if (value === null) {
        delete next[name]
      } else {
        next[name] = value
      }
      return next
    })

  /** Runs one change with its row marked pending; a rejection's message lands in the row. */
  const run = async (name: string, state: Pending, action: () => Promise<unknown> | void, fallback: string): Promise<boolean> => {
    setFor(setPending, name, state)
    setFor(setFailures, name, null)
    try {
      await action()
      return true
    } catch (caught) {
      setFor(setFailures, name, messageOf(caught, fallback))
      return false
    } finally {
      setFor(setPending, name, null)
    }
  }

  const rename = async (name: string, next: string) => {
    if (!onRename || renameBusy.current) {
      return
    }
    renameBusy.current = true
    const done = await run(name, { kind: 'rename', to: next }, () => onRename(name, next), 'Could not rename the label')
    renameBusy.current = false
    // A refused rename keeps the field open with what was typed; its reason shows under it.
    if (done) {
      setRenaming(null)
    }
  }

  const openMerge = (from: string, into: string | null = null) => {
    setRenaming(null)
    setMergeFilter('')
    setMerging({ from, into })
  }

  const shown = useMemo(() => (filter.trim() ? labels.filter((label) => matches(label.name, filter)) : labels), [labels, filter])

  if (loading) {
    return (
      <div role='status' aria-label='Loading the labels' className={cn('flex flex-col gap-2', className)}>
        <Skeleton className='h-11 w-full' />
        <Skeleton className='h-11 w-full' />
        <Skeleton className='h-11 w-4/5' />
      </div>
    )
  }
  if (error) {
    return <TaskManagerError variant='inline' title='The labels could not load' message={error} onRetry={onRetry} className={className} />
  }
  if (labels.length === 0) {
    return (
      <div data-slot='task-labels-manager' className={cn('flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center', className)}>
        <Tag aria-hidden='true' className='size-5 text-muted-foreground' />
        <p className='text-sm font-medium'>No labels yet</p>
        <p className='max-w-sm text-sm text-pretty text-muted-foreground'>A label appears here once a task carries one. Add labels from a task’s Labels field.</p>
      </div>
    )
  }

  const mergeFrom = merging ? labels.find((label) => label.name === merging.from) : undefined
  const mergeTargets = merging ? labels.filter((label) => label.name !== merging.from && matches(label.name, mergeFilter)) : []

  return (
    <div data-slot='task-labels-manager' className={cn('flex min-w-0 flex-col gap-3', className)}>
      {labels.length >= FILTER_FROM ? (
        <div className='relative'>
          <Search aria-hidden='true' className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground' />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Filter ${labels.length} labels`} aria-label='Filter labels' className='pl-8' />
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
          No label matches “<span className='break-all'>{filter.trim()}</span>”.
        </p>
      ) : (
        <ul aria-label='Labels' className='flex flex-col divide-y rounded-lg border'>
          {shown.map((label) => {
            const state = pending[label.name]
            const busy = Boolean(state)
            const editing = renaming === label.name
            const others = labels.length > 1
            const entries: ItemMenuEntries =
              busy || editing
                ? []
                : [
                    onRename && { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setRenaming(label.name) },
                    onColorChange && {
                      id: 'color',
                      label: 'Colour',
                      icon: Palette,
                      group: 'change',
                      entries: [null, ...TASK_LABEL_COLORS].map((color) => ({
                        id: color ?? 'none',
                        label: color ? TASK_LABEL_COLOR_NAMES[color] : 'No colour',
                        icon: color ? COLOR_ICONS[color] : NoColorIcon,
                        checked: label.color === color,
                        onSelect: () => void run(label.name, { kind: 'color' }, () => onColorChange(label.name, color), 'Could not change the colour'),
                      })),
                    },
                    onMerge && others && { id: 'merge', label: 'Merge into…', icon: GitMerge, onSelect: () => openMerge(label.name) },
                    onDelete && { id: 'delete', label: 'Delete…', icon: Trash2, destructive: true, onSelect: () => setDeleting(label) },
                  ]
            return (
              <ItemContextMenu key={label.name} entries={entries} render={<li />} className={cn('flex min-w-0 flex-col gap-1 px-2 py-1.5 sm:px-3', state?.kind === 'delete' && 'opacity-60')}>
                <div className='flex min-h-8 min-w-0 items-center gap-2'>
                  {onColorChange ? (
                    <ColorButton
                      label={label}
                      disabled={busy || editing}
                      onPick={(color) => void run(label.name, { kind: 'color' }, () => onColorChange(label.name, color), 'Could not change the colour')}
                    />
                  ) : null}
                  <div className='min-w-0 flex-1'>
                    {editing ? (
                      <RenameField
                        label={label}
                        labels={labels}
                        busy={state?.kind === 'rename'}
                        onCommit={(next) => void rename(label.name, next)}
                        onCancel={() => setRenaming(null)}
                        onMergeInstead={onMerge ? (into) => openMerge(label.name, into) : undefined}
                      />
                    ) : (
                      <TaskLabelChip name={label.name} color={label.color} className='h-6 max-w-full text-xs' />
                    )}
                  </div>
                  <span className='shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums'>{tasks(label.count)}</span>
                  {busy || editing ? (
                    <Button variant='ghost' size='icon-sm' aria-label={`Actions for ${label.name}`} disabled>
                      <MoreHorizontal aria-hidden='true' />
                    </Button>
                  ) : (
                    <ItemActionsMenu entries={entries} label={`Actions for ${label.name}`} />
                  )}
                </div>
                {state ? (
                  <p role='status' className='flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
                    <Loader2 aria-hidden='true' className='size-3.5 shrink-0 animate-spin' />
                    <span className='min-w-0 truncate'>{pendingText(state)}</span>
                  </p>
                ) : null}
                {failures[label.name] ? <Problem onDismiss={() => setFor(setFailures, label.name, null)}>{failures[label.name]}</Problem> : null}
              </ItemContextMenu>
            )
          })}
        </ul>
      )}

      <Dialog
        open={merging !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMerging(null)
          }
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle className='break-words'>Merge “{merging?.from}” into another label</DialogTitle>
            <DialogDescription>
              Its {tasks(mergeFrom?.count ?? 0)} get the label you pick instead, and “{merging?.from}” is gone. Saved views that filter by it follow.
            </DialogDescription>
          </DialogHeader>
          {labels.length > 8 ? <Input value={mergeFilter} onChange={(event) => setMergeFilter(event.target.value)} placeholder='Find a label' aria-label='Find a label to merge into' /> : null}
          <ScrollArea className='max-h-64 rounded-md border' innerClassName='p-1'>
            {mergeTargets.length === 0 ? (
              <p className='px-2 py-4 text-center text-sm text-muted-foreground'>No other label matches.</p>
            ) : (
              mergeTargets.map((target) => {
                const picked = merging?.into === target.name
                return (
                  <button
                    key={target.name}
                    type='button'
                    aria-pressed={picked}
                    onClick={() => setMerging((current) => (current ? { ...current, into: target.name } : current))}
                    className={cn(
                      'flex h-9 w-full min-w-0 shrink-0 items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
                      picked && 'bg-accent',
                    )}
                  >
                    <span className='min-w-0 flex-1'>
                      <TaskLabelChip name={target.name} color={target.color} className='h-6 max-w-full text-xs' />
                    </span>
                    <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{tasks(target.count)}</span>
                    <Check aria-hidden='true' className={cn('size-4 shrink-0', picked ? 'opacity-100' : 'opacity-0')} />
                  </button>
                )
              })
            )}
          </ScrollArea>
          <DialogFooter>
            <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
            <Button
              disabled={!merging?.into}
              className='min-w-0'
              onClick={() => {
                if (!merging?.into || !onMerge) {
                  return
                }
                const { from, into } = merging
                setMerging(null)
                void run(from, { kind: 'merge', into }, () => onMerge(from, into), 'Could not merge the labels')
              }}
            >
              <GitMerge aria-hidden='true' />
              <span className='truncate'>{merging?.into ? `Merge into “${merging.into}”` : 'Pick a label'}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null)
          }
        }}
      >
        <DialogContent role='alertdialog' showCloseButton={false} className='sm:max-w-sm'>
          <DialogHeader>
            <DialogTitle className='break-words'>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              It comes off the {tasks(deleting?.count ?? 0)} that carry it, and out of any saved view that filters by it. The tasks stay. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
            <Button
              variant='destructive'
              onClick={() => {
                if (!deleting || !onDelete) {
                  return
                }
                const { name } = deleting
                setDeleting(null)
                void run(name, { kind: 'delete' }, () => onDelete(name), 'Could not delete the label')
              }}
            >
              Delete label
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
