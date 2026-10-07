import { Archive, ArchiveRestore, ChevronDown, CircleAlert, Loader2, MoreHorizontal, Pencil, Plus, Rocket, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'

import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { Input } from '../input'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { compareVersionNames, isValidVersionName, sortVersions, TaskVersionChip, type TaskVersion } from './task-version-chip'

/** What the create and edit dialog hands back. */
export interface TaskVersionInput {
  name: string
  /** `YYYY-MM-DD`, or null for none. */
  targetDate: string | null
  description: string | null
}

/** An open task of a version, as the release confirm lists it. */
export interface TaskVersionOpenTask {
  key: string
  summary: string
}

export interface TaskVersionsManagerProps {
  versions: readonly TaskVersion[]
  loading?: boolean
  /** Why the versions could not load; shown with Retry. */
  error?: string | null
  onRetry?: () => void
  /** Each change below shows in place while it runs and a rejection's message stays; without one, that action is not offered. */
  onCreate?: (input: TaskVersionInput) => Promise<unknown> | void
  onUpdate?: (id: string, input: TaskVersionInput) => Promise<unknown> | void
  /** `moveOpenTo`: the planned version its open tasks move to, or null to leave them in the released one. */
  onRelease?: (id: string, options: { moveOpenTo: string | null }) => Promise<unknown> | void
  onArchive?: (id: string) => Promise<unknown> | void
  onRestore?: (id: string) => Promise<unknown> | void
  /** The open tasks the release confirm names; without it, the confirm gives the count. */
  loadOpenTasks?: (id: string) => Promise<TaskVersionOpenTask[]> | TaskVersionOpenTask[]
  className?: string
}

type Pending = 'save' | 'release' | 'archive' | 'restore'

const PENDING_TEXT: Record<Pending, string> = {
  save: 'Saving…',
  release: 'Releasing…',
  archive: 'Archiving…',
  restore: 'Restoring…',
}

/** How many open tasks the release confirm lists before "and N more". */
const OPEN_LIST = 8

function messageOf(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function day(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Why `name` cannot be used for the version `id` (null when creating), or null when it can. */
export function versionNameProblem(name: string, versions: readonly TaskVersion[], id: string | null = null): string | null {
  const clean = name.trim()
  if (!clean) {
    return 'A version needs a name, e.g. 1.5.0.'
  }
  if (!isValidVersionName(clean)) {
    return 'Use MAJOR.MINOR.PATCH, with an optional -pre (1.5.0, 2.0.0-rc.1).'
  }
  const taken = versions.find((version) => version.id !== id && version.name === clean)
  return taken ? `${clean} already exists.` : null
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

interface EditorProps {
  version: TaskVersion | null
  versions: readonly TaskVersion[]
  onSubmit: (input: TaskVersionInput) => Promise<unknown> | void
  onClose: () => void
}

/** Create or edit: the name checked as it is typed, a target date and one line. A refusal keeps the dialog open with its reason. */
function VersionEditor({ version, versions, onSubmit, onClose }: EditorProps) {
  const [name, setName] = useState(version?.name ?? '')
  const [targetDate, setTargetDate] = useState(version?.targetDate ?? '')
  const [description, setDescription] = useState(version?.description ?? '')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const problem = versionNameProblem(name, versions, version?.id ?? null)
  // A taken name shows at once; a malformed one once Save was pressed, so typing "1." is not scolded.
  const shown = problem && (tried || problem.endsWith('already exists.')) ? problem : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (problem || busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit({ name: name.trim(), targetDate: targetDate || null, description: description.trim() || null })
      onClose()
    } catch (caught) {
      setFailure(messageOf(caught, version ? 'Could not save the version' : 'Could not create the version'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='flex flex-col gap-4'>
      <DialogHeader>
        <DialogTitle>{version ? `Edit ${version.name}` : 'New version'}</DialogTitle>
        <DialogDescription>A semantic version the project's tasks can be planned into.</DialogDescription>
      </DialogHeader>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>Name</span>
        <Input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type the name.
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder='1.5.0'
          aria-invalid={shown ? true : undefined}
          className='font-mono'
        />
        {shown ? <Problem>{shown}</Problem> : null}
      </label>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>
          Target date <span className='font-normal text-muted-foreground'>(optional)</span>
        </span>
        <Input type='date' value={targetDate} onChange={(event) => setTargetDate(event.target.value)} className='w-44' />
      </label>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>
          Description <span className='font-normal text-muted-foreground'>(optional)</span>
        </span>
        <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={120} placeholder='What this release is for, in a line' />
      </label>
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
      <DialogFooter>
        <DialogClose render={<Button type='button' variant='outline' />}>Cancel</DialogClose>
        <Button type='submit' disabled={busy}>
          {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
          {version ? 'Save' : 'Create version'}
        </Button>
      </DialogFooter>
    </form>
  )
}

interface ReleaseProps {
  version: TaskVersion
  versions: readonly TaskVersion[]
  loadOpenTasks?: TaskVersionsManagerProps['loadOpenTasks']
  onConfirm: (moveOpenTo: string | null) => void
}

/** The release confirm: the open tasks by key and summary, and where they go. */
function ReleaseConfirm({ version, versions, loadOpenTasks, onConfirm }: ReleaseProps) {
  const open = version.openCount ?? 0
  const targets = sortVersions(versions.filter((other) => other.id !== version.id && other.state === 'planned'))
  // The next planned version after this one is the natural home for what did not make it.
  const next = targets.find((other) => compareVersionNames(other.name, version.name) > 0) ?? targets[0] ?? null
  const [moveTo, setMoveTo] = useState<string | null>(open > 0 ? (next?.id ?? null) : null)
  const [tasks, setTasks] = useState<TaskVersionOpenTask[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!loadOpenTasks || open === 0) {
      return
    }
    let live = true
    Promise.resolve(loadOpenTasks(version.id)).then(
      (found) => live && setTasks(found),
      () => live && setLoadFailed(true),
    )
    return () => {
      live = false
    }
  }, [loadOpenTasks, open, version.id])

  const target = targets.find((other) => other.id === moveTo)
  return (
    <div className='flex flex-col gap-4'>
      <DialogHeader>
        <DialogTitle className='break-words'>Release {version.name}?</DialogTitle>
        <DialogDescription>
          {open === 0
            ? `All ${plural(version.doneCount ?? 0, 'task')} in it are done. It is marked released today.`
            : `${plural(open, 'task is', 'tasks are')} in it and not done. Say where they go; the version is marked released today.`}
        </DialogDescription>
      </DialogHeader>
      {open > 0 ? (
        <>
          {loadOpenTasks ? (
            <ScrollArea className='max-h-40 rounded-md border' innerClassName='p-2'>
              {tasks === null ? (
                <p className='text-sm text-muted-foreground'>{loadFailed ? `The ${plural(open, 'open task')} could not be listed.` : 'Finding them…'}</p>
              ) : (
                <ul className='flex flex-col gap-1 text-sm'>
                  {tasks.slice(0, OPEN_LIST).map((task) => (
                    <li key={task.key} className='flex min-w-0 items-baseline gap-2'>
                      <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
                      <span className='min-w-0 truncate'>{task.summary}</span>
                    </li>
                  ))}
                  {tasks.length > OPEN_LIST ? <li className='text-muted-foreground'>and {plural(tasks.length - OPEN_LIST, 'more task')}</li> : null}
                </ul>
              )}
            </ScrollArea>
          ) : null}
          <fieldset className='flex flex-col gap-1'>
            <legend className='mb-1 text-sm font-medium'>The open tasks</legend>
            {targets.map((other) => (
              <label key={other.id} className='flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary'>
                <input type='radio' name='move-open-to' checked={moveTo === other.id} onChange={() => setMoveTo(other.id)} className='accent-primary' />
                <span className='min-w-0 flex-1 truncate'>
                  Move them to <span className='font-mono'>{other.name}</span>
                </span>
                {other.targetDate ? <span className='shrink-0 text-xs text-muted-foreground'>{day(other.targetDate)}</span> : null}
              </label>
            ))}
            <label className='flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary'>
              <input type='radio' name='move-open-to' checked={moveTo === null} onChange={() => setMoveTo(null)} className='accent-primary' />
              <span className='min-w-0 flex-1 truncate'>
                Leave them in <span className='font-mono'>{version.name}</span>
              </span>
            </label>
            {targets.length === 0 ? <p className='text-xs text-muted-foreground'>There is no other planned version to move them to; create one first to move them.</p> : null}
          </fieldset>
        </>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
        <Button onClick={() => onConfirm(moveTo)} className='min-w-0'>
          <Rocket aria-hidden='true' />
          <span className='truncate'>{target ? `Release and move ${plural(open, 'task')}` : `Release ${version.name}`}</span>
        </Button>
      </DialogFooter>
    </div>
  )
}

type Dialogs = { kind: 'create' } | { kind: 'edit'; version: TaskVersion } | { kind: 'release'; version: TaskVersion } | { kind: 'archive'; version: TaskVersion } | null

/**
 * The project's versions for the settings page, planned first. Each row has
 * the version's chip, its date and description, and its open and done
 * counts; its menu edits, releases, archives or restores it.
 */
export function TaskVersionsManager({
  versions,
  loading = false,
  error = null,
  onRetry,
  onCreate,
  onUpdate,
  onRelease,
  onArchive,
  onRestore,
  loadOpenTasks,
  className,
}: TaskVersionsManagerProps) {
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
      <div role='status' aria-label='Loading the versions' className={cn('flex flex-col gap-2', className)}>
        <Skeleton className='h-14 w-full' />
        <Skeleton className='h-14 w-full' />
        <Skeleton className='h-14 w-4/5' />
      </div>
    )
  }
  if (error) {
    return <TaskManagerError variant='inline' title='The versions could not load' message={error} onRetry={onRetry} className={className} />
  }

  const sorted = sortVersions(versions)
  const current = sorted.filter((version) => version.state !== 'archived')
  const archived = sorted.filter((version) => version.state === 'archived')
  const shown = showArchived ? sorted : current

  const entriesFor = (version: TaskVersion): ItemMenuEntries =>
    pending[version.id]
      ? []
      : [
          onUpdate && { id: 'edit', label: 'Edit…', icon: Pencil, onSelect: () => setDialog({ kind: 'edit', version }) },
          onRelease && version.state === 'planned' && { id: 'release', label: 'Release…', icon: Rocket, onSelect: () => setDialog({ kind: 'release', version }) },
          onArchive && version.state !== 'archived' && { id: 'archive', label: 'Archive…', icon: Archive, onSelect: () => setDialog({ kind: 'archive', version }) },
          onRestore &&
            version.state === 'archived' && {
              id: 'restore',
              label: 'Restore',
              icon: ArchiveRestore,
              onSelect: () => void run(version.id, 'restore', () => onRestore(version.id), 'Could not restore the version'),
            },
        ]

  return (
    <div data-slot='task-versions-manager' className={cn('flex min-w-0 flex-col gap-3', className)}>
      {onCreate ? (
        <div className='flex justify-end'>
          <Button variant='outline' size='sm' onClick={() => setDialog({ kind: 'create' })}>
            <Plus aria-hidden='true' />
            New version
          </Button>
        </div>
      ) : null}

      {current.length === 0 && archived.length === 0 ? (
        <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center'>
          <Rocket aria-hidden='true' className='size-5 text-muted-foreground' />
          <p className='text-sm font-medium'>No versions yet</p>
          <p className='max-w-sm text-sm text-pretty text-muted-foreground'>A version (1.5.0) collects the tasks planned for a release, and shows on the timeline at its date.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>Every version is archived.</p>
      ) : (
        <ul aria-label='Versions' className='flex flex-col divide-y rounded-lg border'>
          {shown.map((version) => {
            const state = pending[version.id]
            const entries = entriesFor(version)
            const when = version.state === 'planned' ? (version.targetDate ? `Due ${day(version.targetDate)}` : 'No date') : version.releasedAt ? `Released ${day(version.releasedAt)}` : 'Released'
            return (
              <ItemContextMenu key={version.id} entries={entries} render={<li />} className='flex min-w-0 flex-col gap-1 px-3 py-2'>
                <div className='flex min-w-0 items-center gap-3'>
                  <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                    <span className='flex min-w-0 items-center gap-2'>
                      <TaskVersionChip name={version.name} state={version.state} className='h-6 max-w-full text-xs' />
                      <span className='shrink-0 text-xs text-muted-foreground'>{when}</span>
                    </span>
                    {version.description ? <span className='truncate text-xs text-muted-foreground'>{version.description}</span> : null}
                  </div>
                  <Progress open={version.openCount ?? 0} done={version.doneCount ?? 0} />
                  {state ? (
                    <Button variant='ghost' size='icon-sm' aria-label={`Actions for ${version.name}`} disabled>
                      <MoreHorizontal aria-hidden='true' />
                    </Button>
                  ) : (
                    <ItemActionsMenu entries={entries} label={`Actions for ${version.name}`} />
                  )}
                </div>
                {state ? (
                  <p role='status' className='flex items-center gap-1.5 text-xs text-muted-foreground'>
                    <Loader2 aria-hidden='true' className='size-3.5 animate-spin' />
                    {PENDING_TEXT[state]}
                  </p>
                ) : null}
                {failures[version.id] ? <Problem onDismiss={() => setFor(setFailures, version.id, null)}>{failures[version.id]}</Problem> : null}
              </ItemContextMenu>
            )
          })}
        </ul>
      )}

      {archived.length > 0 ? (
        <Button variant='ghost' size='sm' className='self-start text-muted-foreground' aria-expanded={showArchived} onClick={() => setShowArchived((open) => !open)}>
          <ChevronDown aria-hidden='true' className={cn('transition-transform', showArchived && 'rotate-180')} />
          {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
        </Button>
      ) : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
          }
        }}
      >
        <DialogContent className='sm:max-w-md'>
          {dialog?.kind === 'create' && onCreate ? <VersionEditor version={null} versions={versions} onSubmit={onCreate} onClose={() => setDialog(null)} /> : null}
          {dialog?.kind === 'edit' && onUpdate ? (
            <VersionEditor version={dialog.version} versions={versions} onSubmit={(input) => onUpdate(dialog.version.id, input)} onClose={() => setDialog(null)} />
          ) : null}
          {dialog?.kind === 'release' && onRelease ? (
            <ReleaseConfirm
              version={dialog.version}
              versions={versions}
              loadOpenTasks={loadOpenTasks}
              onConfirm={(moveOpenTo) => {
                const { id } = dialog.version
                setDialog(null)
                void run(id, 'release', () => onRelease(id, { moveOpenTo }), 'Could not release the version')
              }}
            />
          ) : null}
          {dialog?.kind === 'archive' && onArchive ? (
            <div className='flex flex-col gap-4'>
              <DialogHeader>
                <DialogTitle className='break-words'>Archive {dialog.version.name}?</DialogTitle>
                <DialogDescription>
                  It leaves the version pickers and the timeline. Its {plural((dialog.version.openCount ?? 0) + (dialog.version.doneCount ?? 0), 'task')} keep it, and it can be restored.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
                <Button
                  onClick={() => {
                    const { id } = dialog.version
                    setDialog(null)
                    void run(id, 'archive', () => onArchive(id), 'Could not archive the version')
                  }}
                >
                  <Archive aria-hidden='true' />
                  Archive
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

