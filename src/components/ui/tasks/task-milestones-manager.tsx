import { Archive, ArchiveRestore, ChevronDown, CircleAlert, Flag, Loader2, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { Input } from '../input'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { milestoneSpanText, TaskMilestoneChip, type TaskMilestone } from './task-milestone-chip'

/** What the create and edit dialog hands back. */
export interface TaskMilestoneInput {
  name: string
  /** `YYYY-MM-DD`, or null for none. */
  startDate: string | null
  /** `YYYY-MM-DD`, or null for none; not before `startDate`. */
  targetDate: string | null
  description: string | null
}

export interface TaskMilestonesManagerProps {
  /** In the order to list them; open ones are listed before archived ones whatever the order. */
  milestones: readonly TaskMilestone[]
  loading?: boolean
  /** Why the milestones could not load; shown with Retry. */
  error?: string | null
  onRetry?: () => void
  /** Each change below shows in place while it runs and a rejection's message stays; without one, that action is not offered. */
  onCreate?: (input: TaskMilestoneInput) => Promise<unknown> | void
  onUpdate?: (id: string, input: TaskMilestoneInput) => Promise<unknown> | void
  onArchive?: (id: string) => Promise<unknown> | void
  onRestore?: (id: string) => Promise<unknown> | void
  /** Deletes the milestone after a confirmation that says how many tasks it holds; its tasks leave it and keep their dates. */
  onDelete?: (id: string) => Promise<unknown> | void
  className?: string
}

type Pending = 'archive' | 'restore' | 'delete'

const PENDING_TEXT: Record<Pending, string> = {
  archive: 'Archiving…',
  restore: 'Restoring…',
  delete: 'Deleting…',
}

/** The longest name a milestone takes. */
export const MILESTONE_NAME_MAX = 80

function messageOf(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Why `name` cannot be used for the milestone `id` (null when creating), or null when it can. Names compare ignoring case. */
export function milestoneNameProblem(name: string, milestones: readonly TaskMilestone[], id: string | null = null): string | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) {
    return 'A milestone needs a name, e.g. Beta.'
  }
  if (clean.length > MILESTONE_NAME_MAX) {
    return `A name is at most ${MILESTONE_NAME_MAX} characters.`
  }
  if (clean.toLowerCase() === 'none') {
    return '"None" means no milestone; pick another name.'
  }
  const taken = milestones.find((milestone) => milestone.id !== id && milestone.name.toLowerCase() === clean.toLowerCase())
  return taken ? `${taken.name} already exists.` : null
}

function Problem({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role='alert' className='flex min-w-0 items-start gap-1.5 text-xs text-destructive'>
      <CircleAlert aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
      <p className='min-w-0 flex-1 break-words'>{children}</p>
      {onDismiss ? (
        <Button variant='ghost' size='icon-xs' className='-my-0.5 size-5' aria-label='Dismiss' onClick={onDismiss}>
          <X aria-hidden='true' />
        </Button>
      ) : null}
    </div>
  )
}

function Progress({ open, done }: { open: number; done: number }) {
  const total = open + done
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <span className='flex shrink-0 flex-col items-end gap-1'>
      <span className='text-xs whitespace-nowrap text-muted-foreground tabular-nums'>
        {open} open · {done} done
      </span>
      <span aria-hidden='true' className='h-1 w-20 overflow-hidden rounded-full bg-muted'>
        <span className='block h-full rounded-full bg-emerald-500' style={{ width: `${percent}%` }} />
      </span>
    </span>
  )
}

export interface TaskMilestoneEditorProps {
  /** The milestone to edit; null to create one. */
  milestone: TaskMilestone | null
  /** Every milestone of the project, for checking the name is free. */
  milestones: readonly TaskMilestone[]
  /** Saves; a rejection keeps the form open with its reason. */
  onSubmit: (input: TaskMilestoneInput) => Promise<unknown> | void
  /** Called once saved, and the dialog's Cancel closes through the surrounding Dialog. */
  onClose: () => void
}

/**
 * The milestone create and edit form, for the inside of a `DialogContent`: the
 * name checked as it is typed, an optional start and target, and one line. A
 * refusal keeps the dialog open with its reason. Settings opens it from this
 * list; a surface that creates a milestone elsewhere (the timeline's New
 * milestone…) opens the same form.
 */
export function TaskMilestoneEditor({ milestone, milestones, onSubmit, onClose }: TaskMilestoneEditorProps) {
  const [name, setName] = useState(milestone?.name ?? '')
  const [startDate, setStartDate] = useState(milestone?.startDate ?? '')
  const [targetDate, setTargetDate] = useState(milestone?.targetDate ?? '')
  const [description, setDescription] = useState(milestone?.description ?? '')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const problem = milestoneNameProblem(name, milestones, milestone?.id ?? null)
  // A taken name shows at once; an empty one once Save was pressed, so an empty field is not scolded on opening.
  const shown = problem && (tried || problem.endsWith('already exists.')) ? problem : null
  const datesProblem = startDate && targetDate && targetDate < startDate ? 'The target is before the start.' : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (problem || datesProblem || busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit({
        name: name.replace(/\s+/g, ' ').trim(),
        startDate: startDate || null,
        targetDate: targetDate || null,
        description: description.trim() || null,
      })
      onClose()
    } catch (caught) {
      setFailure(messageOf(caught, milestone ? 'Could not save the milestone' : 'Could not create the milestone'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='flex flex-col gap-4'>
      <DialogHeader>
        <DialogTitle className='break-words'>{milestone ? `Edit ${milestone.name}` : 'New milestone'}</DialogTitle>
        <DialogDescription>A stage or goal the project's tasks are planned into. Changing its dates moves no task.</DialogDescription>
      </DialogHeader>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>Name</span>
        <Input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type the name.
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder='Beta'
          maxLength={MILESTONE_NAME_MAX}
          aria-invalid={shown ? true : undefined}
        />
        {shown ? <Problem>{shown}</Problem> : null}
      </label>
      <div className='flex flex-wrap gap-3'>
        <label className='flex flex-col gap-1.5 text-sm'>
          <span className='font-medium'>
            Start <span className='font-normal text-muted-foreground'>(optional)</span>
          </span>
          <Input type='date' value={startDate} onChange={(event) => setStartDate(event.target.value)} className='w-44' />
        </label>
        <label className='flex flex-col gap-1.5 text-sm'>
          <span className='font-medium'>
            Target <span className='font-normal text-muted-foreground'>(optional)</span>
          </span>
          <Input type='date' value={targetDate} onChange={(event) => setTargetDate(event.target.value)} aria-invalid={datesProblem ? true : undefined} className='w-44' />
        </label>
      </div>
      {datesProblem ? <Problem>{datesProblem}</Problem> : null}
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>
          Description <span className='font-normal text-muted-foreground'>(optional)</span>
        </span>
        <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} placeholder='What this stage is for, in a line' />
      </label>
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
      <DialogFooter>
        <DialogClose render={<Button type='button' variant='outline' />}>Cancel</DialogClose>
        <Button type='submit' disabled={busy}>
          {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
          {milestone ? 'Save' : 'Create milestone'}
        </Button>
      </DialogFooter>
    </form>
  )
}

type Dialogs =
  | { kind: 'create' }
  | { kind: 'edit'; milestone: TaskMilestone }
  | { kind: 'archive'; milestone: TaskMilestone }
  | { kind: 'delete'; milestone: TaskMilestone }
  | null

function taskCount(milestone: TaskMilestone): number {
  return (milestone.openCount ?? 0) + (milestone.doneCount ?? 0)
}

/**
 * The project's milestones for the settings page, open ones first. Each row
 * has the milestone's chip, its span and description, and its open and done
 * counts; its menu edits, archives, restores or deletes it.
 */
export function TaskMilestonesManager({
  milestones,
  loading = false,
  error = null,
  onRetry,
  onCreate,
  onUpdate,
  onArchive,
  onRestore,
  onDelete,
  className,
}: TaskMilestonesManagerProps) {
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [showArchived, setShowArchived] = useState(false)

  const setFor = <T,>(set: (update: (current: Record<string, T>) => Record<string, T>) => void, id: string, value: T | null) =>
    set((current) => {
      const next = { ...current }
      if (value === null) {
        delete next[id]
      } else {
        next[id] = value
      }
      return next
    })

  const run = async (id: string, state: Pending, action: () => Promise<unknown> | void, fallback: string) => {
    setFor(setPending, id, state)
    setFor(setFailures, id, null)
    try {
      await action()
    } catch (caught) {
      setFor(setFailures, id, messageOf(caught, fallback))
    } finally {
      setFor(setPending, id, null)
    }
  }

  if (loading) {
    return (
      <div role='status' aria-label='Loading the milestones' className={cn('flex flex-col gap-2', className)}>
        <Skeleton className='h-14 w-full' />
        <Skeleton className='h-14 w-full' />
        <Skeleton className='h-14 w-4/5' />
      </div>
    )
  }
  if (error) {
    return <TaskManagerError variant='inline' title='The milestones could not load' message={error} onRetry={onRetry} className={className} />
  }

  const open = milestones.filter((milestone) => milestone.state !== 'archived')
  const archived = milestones.filter((milestone) => milestone.state === 'archived')
  const shown = showArchived ? [...open, ...archived] : open

  const entriesFor = (milestone: TaskMilestone): ItemMenuEntries =>
    pending[milestone.id]
      ? []
      : [
          onUpdate && { id: 'edit', label: 'Edit…', icon: Pencil, onSelect: () => setDialog({ kind: 'edit', milestone }) },
          onArchive && milestone.state !== 'archived' && { id: 'archive', label: 'Archive…', icon: Archive, onSelect: () => setDialog({ kind: 'archive', milestone }) },
          onRestore &&
            milestone.state === 'archived' && {
              id: 'restore',
              label: 'Restore',
              icon: ArchiveRestore,
              onSelect: () => void run(milestone.id, 'restore', () => onRestore(milestone.id), 'Could not restore the milestone'),
            },
          onDelete && { id: 'delete', label: 'Delete…', icon: Trash2, destructive: true, onSelect: () => setDialog({ kind: 'delete', milestone }) },
        ]

  return (
    <div data-slot='task-milestones-manager' className={cn('flex min-w-0 flex-col gap-3', className)}>
      {onCreate ? (
        <div className='flex justify-end'>
          <Button variant='outline' size='sm' onClick={() => setDialog({ kind: 'create' })}>
            <Plus aria-hidden='true' />
            New milestone
          </Button>
        </div>
      ) : null}

      {open.length === 0 && archived.length === 0 ? (
        <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center'>
          <Flag aria-hidden='true' className='size-5 text-muted-foreground' />
          <p className='text-sm font-medium'>No milestones yet</p>
          <p className='max-w-sm text-sm text-pretty text-muted-foreground'>A milestone (Beta, a long-running goal) collects the tasks planned for a stage of work. A task put in one gets dates inside it.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>Every milestone is archived.</p>
      ) : (
        <ul aria-label='Milestones' className='flex flex-col divide-y rounded-lg border'>
          {shown.map((milestone) => {
            const state = pending[milestone.id]
            const entries = entriesFor(milestone)
            const span = milestoneSpanText(milestone) ?? 'No dates'
            return (
              <ItemContextMenu key={milestone.id} entries={entries} render={<li />} className={cn('flex min-w-0 flex-col gap-1 px-3 py-2', state === 'delete' && 'opacity-60')}>
                <div className='flex min-w-0 items-center gap-3'>
                  <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                    <span className='flex min-w-0 items-center gap-2'>
                      <TaskMilestoneChip name={milestone.name} state={milestone.state} className='h-6 max-w-full text-xs' />
                      <span className='shrink-0 text-xs text-muted-foreground'>{span}</span>
                    </span>
                    {milestone.description ? <span className='truncate text-xs text-muted-foreground'>{milestone.description}</span> : null}
                  </div>
                  <Progress open={milestone.openCount ?? 0} done={milestone.doneCount ?? 0} />
                  {state ? (
                    <Button variant='ghost' size='icon-sm' aria-label={`Actions for ${milestone.name}`} disabled>
                      <MoreHorizontal aria-hidden='true' />
                    </Button>
                  ) : (
                    <ItemActionsMenu entries={entries} label={`Actions for ${milestone.name}`} />
                  )}
                </div>
                {state ? (
                  <p role='status' className='flex items-center gap-1.5 text-xs text-muted-foreground'>
                    <Loader2 aria-hidden='true' className='size-3.5 animate-spin' />
                    {PENDING_TEXT[state]}
                  </p>
                ) : null}
                {failures[milestone.id] ? <Problem onDismiss={() => setFor(setFailures, milestone.id, null)}>{failures[milestone.id]}</Problem> : null}
              </ItemContextMenu>
            )
          })}
        </ul>
      )}

      {archived.length > 0 ? (
        <Button variant='ghost' size='sm' className='self-start text-muted-foreground' aria-expanded={showArchived} onClick={() => setShowArchived((shownNow) => !shownNow)}>
          <ChevronDown aria-hidden='true' className={cn('transition-transform', showArchived && 'rotate-180')} />
          {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
        </Button>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setDialog(null)
          }
        }}
      >
        <DialogContent className='sm:max-w-md'>
          {dialog?.kind === 'create' && onCreate ? <TaskMilestoneEditor milestone={null} milestones={milestones} onSubmit={onCreate} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'edit' && onUpdate ? (
            <TaskMilestoneEditor milestone={dialog.milestone} milestones={milestones} onSubmit={(input) => onUpdate(dialog.milestone.id, input)} onClose={() => setDialog(null)} />
          ) : null}
          {dialog?.kind === 'archive' && onArchive ? (
            <div className='flex flex-col gap-4'>
              <DialogHeader>
                <DialogTitle className='break-words'>Archive {dialog.milestone.name}?</DialogTitle>
                <DialogDescription>
                  It leaves the milestone pickers and takes no new tasks. Its {plural(taskCount(dialog.milestone), 'task')} keep it and their dates, and it can be restored.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
                <Button
                  onClick={() => {
                    const { id } = dialog.milestone
                    setDialog(null)
                    void run(id, 'archive', () => onArchive(id), 'Could not archive the milestone')
                  }}
                >
                  <Archive aria-hidden='true' />
                  Archive
                </Button>
              </DialogFooter>
            </div>
          ) : null}
          {dialog?.kind === 'delete' && onDelete ? (
            <div className='flex flex-col gap-4'>
              <DialogHeader>
                <DialogTitle className='break-words'>Delete {dialog.milestone.name}?</DialogTitle>
                <DialogDescription>
                  {taskCount(dialog.milestone) === 0
                    ? 'It holds no tasks.'
                    : `It holds ${plural(taskCount(dialog.milestone), 'task')}: they leave it and keep their dates.`}{' '}
                  Saved views stop filtering by it. This cannot be undone; to hide it and keep its tasks in it, archive it instead.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
                <Button
                  variant='destructive'
                  onClick={() => {
                    const { id } = dialog.milestone
                    setDialog(null)
                    void run(id, 'delete', () => onDelete(id), 'Could not delete the milestone')
                  }}
                >
                  <Trash2 aria-hidden='true' />
                  Delete milestone
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
