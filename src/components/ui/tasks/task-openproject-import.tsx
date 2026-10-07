import { ArrowLeft, CircleAlert, CircleCheck, Download, KeyRound, Loader2, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'

import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { Input } from '../input'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

/** Where the project comes from. `secretKey` names a Secrets Store key; the token itself never reaches the page. */
export interface OpenProjectConnectionValue {
  url: string
  /** The project's identifier, as in its address, or its id. */
  project: string
  secretKey: string
}

export type OpenProjectTaskType = 'epic' | 'story' | 'task' | 'bug'
export type OpenProjectStatusCategory = 'todo' | 'in_progress' | 'done'

/** One of the project's statuses (by id), or a new one the import creates. */
export type OpenProjectStatusTarget = { status: string } | { create: { name: string; category: OpenProjectStatusCategory; color: string | null } }

/** Who an OpenProject user becomes: an agent, a person (by id, or by name only), or nobody. */
export type OpenProjectPersonTarget = { kind: 'agent'; id: string; name: string } | { kind: 'person'; id?: string; name: string } | null

/** Each keyed by the OpenProject id. */
export interface OpenProjectImportMapping {
  statuses: Record<string, OpenProjectStatusTarget>
  types: Record<string, OpenProjectTaskType | 'skip'>
  people: Record<string, OpenProjectPersonTarget>
}

export interface OpenProjectCountRow {
  id: string
  name: string
  count: number
}

export interface OpenProjectStatusRow extends OpenProjectCountRow {
  isClosed: boolean
  color: string | null
}

/** A task edited here that OpenProject also changed, in the same fields. */
export interface OpenProjectConflictRow {
  key: string
  summary: string
  /** Each field changed on both sides, as each side shows it. */
  fields: readonly { field: string; here: string | null; openProject: string | null }[]
  /** True: OpenProject's values replaced the edits here; false: the edits stayed. */
  overwritten: boolean
}

/** What an import would bring, with the mapping it suggests. */
export interface OpenProjectImportPreview {
  connection: OpenProjectConnectionValue
  project: { identifier: string; name: string }
  workPackages: number
  /** Imported before: a re-run brings these up to date instead of adding them again. */
  alreadyImported: number
  /** What confirming would do with the suggested mapping. */
  plan?: { create: number; update: number; unchanged: number }
  /** Tasks edited here that OpenProject also changed; each keeps its edits unless chosen to take OpenProject's. */
  conflicts?: readonly OpenProjectConflictRow[]
  /** Files the import would bring (bytes as the source reports them), and those over the per-file limit. */
  attachments?: { count: number; bytes: number; skipped: readonly { source: string; summary: string; reason: string }[] }
  /** Relations between tasks the import would add. */
  relations?: number
  byType: readonly OpenProjectCountRow[]
  byStatus: readonly OpenProjectStatusRow[]
  people: readonly OpenProjectCountRow[]
  mapping: OpenProjectImportMapping
  keepNumbers: boolean
}

export interface OpenProjectImportSummary {
  created: number
  updated: number
  unchanged: number
  conflicts?: readonly OpenProjectConflictRow[]
  comments: number
  /** Relations added, by type. */
  relations?: { added: Readonly<Record<string, number>> }
  /** Files attached. */
  attachments?: { added: number; bytes: number }
  statusesCreated: readonly string[]
  skipped: readonly { source: string; summary: string; reason: string }[]
  notes: readonly string[]
}

export interface OpenProjectLastImport {
  /** ISO time. */
  at: string
  by: string
  result: OpenProjectImportSummary
}

/** A status here, for the status mapping. */
export interface OpenProjectTargetStatus {
  id: string
  name: string
  category: OpenProjectStatusCategory
}

/** An agent or person here, for the people mapping. */
export interface OpenProjectTargetPerson {
  kind: 'agent' | 'person'
  id: string
  name: string
}

export interface TaskOpenProjectImportProps {
  /** The saved connection, which the form starts from. */
  connection?: OpenProjectConnectionValue | null
  /** The key name the form offers when nothing is saved. */
  defaultSecretKey?: string
  /** Every key name must start with this; the form says so before asking the server. */
  secretKeyPrefix?: string
  lastImport?: OpenProjectLastImport | null
  statuses: readonly OpenProjectTargetStatus[]
  assignees: readonly OpenProjectTargetPerson[]
  loading?: boolean
  /** Why the saved connection could not load; shown with Retry. */
  error?: string | null
  onRetry?: () => void
  /** Reads the project and suggests a mapping; nothing is imported. A rejection's message shows in the form. */
  onPreview: (connection: OpenProjectConnectionValue) => Promise<OpenProjectImportPreview>
  /** `overwrite` holds the keys of conflicting tasks that take OpenProject's values. */
  onImport: (request: {
    connection: OpenProjectConnectionValue
    mapping: OpenProjectImportMapping
    keepNumbers: boolean
    overwrite: string[]
  }) => Promise<OpenProjectImportSummary>
  /** The schedule: import every `minutes`, or not while null. Shown once there is a last import. */
  sync?: { minutes: number | null; error: { at: string; message: string } | null }
  /** The intervals offered, in minutes. */
  syncChoices?: readonly number[]
  /** Changes the schedule; a rejection's message shows beside it. Without it the schedule is not offered. */
  onSyncChange?: (minutes: number | null) => Promise<void>
  /** Opens the dialog at once. */
  defaultOpen?: boolean
  className?: string
}

const TYPE_LABEL: Record<OpenProjectTaskType | 'skip', string> = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  skip: 'Leave out',
}

const CATEGORY_LABEL: Record<OpenProjectStatusCategory, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  done: 'done',
}

const SELECT =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground'

/** The category a new status gets when the preview did not suggest one: closed is done, a name that says work is under way is in progress. */
function guessCategory(row: OpenProjectStatusRow): OpenProjectStatusCategory {
  if (row.isClosed) {
    return 'done'
  }
  return /progress|develop|review|test|\bqa\b|doing|implement/i.test(row.name) ? 'in_progress' : 'todo'
}

function messageOf(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
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

const FIELD_LABEL: Record<string, string> = {
  summary: 'Summary',
  description: 'Description',
  status: 'Status',
  type: 'Type',
  priority: 'Priority',
  assignee: 'Assignee',
  dates: 'Dates',
  parent: 'Parent',
}

const shown = (value: string | null) => value ?? 'none'

/**
 * Tasks changed here and in OpenProject, field by field. With `chosen`, each
 * has a checkbox to take OpenProject's values; without, it says which side won.
 */
function ConflictList({ conflicts, chosen, onToggle }: { conflicts: readonly OpenProjectConflictRow[]; chosen?: ReadonlySet<string>; onToggle?: (key: string) => void }) {
  return (
    <section className='flex min-w-0 flex-col gap-1.5'>
      <h3 className='text-sm font-medium'>Changed here and in OpenProject ({conflicts.length})</h3>
      <p className='text-xs text-muted-foreground'>
        {onToggle ? 'The changes made here are kept unless you choose to use OpenProject’s values.' : 'Where both sides changed a field, this is what the import did.'}
      </p>
      <ul className='flex flex-col divide-y rounded-md border text-sm'>
        {conflicts.map((conflict) => (
          <li key={conflict.key} className='flex min-w-0 flex-col gap-1 px-3 py-2'>
            <span className='flex min-w-0 items-baseline gap-2'>
              <span className='shrink-0 font-mono text-xs text-muted-foreground'>{conflict.key}</span>
              <span className='min-w-0 truncate'>{conflict.summary}</span>
            </span>
            <dl className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs'>
              {conflict.fields.map((entry) => (
                <div key={entry.field} className='contents'>
                  <dt className='text-muted-foreground'>{FIELD_LABEL[entry.field] ?? entry.field}</dt>
                  <dd className='min-w-0 break-words'>
                    Here: {shown(entry.here)} · OpenProject: {shown(entry.openProject)}
                  </dd>
                </div>
              ))}
            </dl>
            {onToggle ? (
              <label className='flex cursor-pointer items-center gap-2 text-xs'>
                <input type='checkbox' checked={chosen?.has(conflict.key) ?? false} onChange={() => onToggle(conflict.key)} className='accent-primary' />
                Use OpenProject’s values
              </label>
            ) : (
              <span className='text-xs text-muted-foreground'>{conflict.overwritten ? 'Took OpenProject’s values' : 'Kept the changes made here'}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What an import did: the counts, the statuses it made, the conflicts, what it left out and why. */
function Summary({ result }: { result: OpenProjectImportSummary }) {
  const counts: Array<[string, number]> = [
    ['Created', result.created],
    ['Updated', result.updated],
    ['Unchanged', result.unchanged],
    ['Comments', result.comments],
  ]
  if (result.relations) {
    counts.push(['Relations', Object.values(result.relations.added).reduce((sum, count) => sum + count, 0)])
  }
  if (result.attachments) {
    counts.push(['Attachments', result.attachments.added])
  }
  return (
    <div className='flex min-w-0 flex-col gap-3'>
      <dl className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
        {counts.map(([label, value]) => (
          <div key={label} className='rounded-md border px-3 py-2'>
            <dt className='text-xs text-muted-foreground'>{label}</dt>
            <dd className='text-lg font-semibold tabular-nums'>{value}</dd>
          </div>
        ))}
      </dl>
      {result.statusesCreated.length > 0 ? (
        <p className='text-sm'>
          <span className='text-muted-foreground'>New statuses: </span>
          {result.statusesCreated.join(', ')}
        </p>
      ) : null}
      {result.notes.map((note) => (
        <p key={note} className='text-sm text-muted-foreground'>
          {note}
        </p>
      ))}
      {result.conflicts && result.conflicts.length > 0 ? <ConflictList conflicts={result.conflicts} /> : null}
      {result.skipped.length > 0 ? (
        <div className='flex min-w-0 flex-col gap-1'>
          <p className='text-sm font-medium'>Left out ({result.skipped.length})</p>
          <ul className='flex flex-col divide-y rounded-md border text-sm'>
            {result.skipped.map((item, index) => (
              <li key={`${item.source}-${index}`} className='flex min-w-0 flex-col gap-0.5 px-3 py-1.5'>
                <span className='flex min-w-0 items-baseline gap-2'>
                  <span className='shrink-0 font-mono text-xs text-muted-foreground'>{item.source}</span>
                  <span className='min-w-0 truncate'>{item.summary}</span>
                </span>
                <span className='text-xs text-muted-foreground'>{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

interface ConnectProps {
  initial: OpenProjectConnectionValue
  secretKeyPrefix?: string
  onPreview: TaskOpenProjectImportProps['onPreview']
  onPreviewed: (preview: OpenProjectImportPreview) => void
}

/** Step one: the address, the project and the key name. Preview reads the project; nothing is imported yet. */
function ConnectStep({ initial, secretKeyPrefix, onPreview, onPreviewed }: ConnectProps) {
  const [url, setUrl] = useState(initial.url)
  const [project, setProject] = useState(initial.project)
  const [secretKey, setSecretKey] = useState(initial.secretKey)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const id = useId()
  const keyProblem = secretKeyPrefix && secretKey.trim() && !secretKey.trim().toUpperCase().startsWith(secretKeyPrefix) ? `The key name must start with ${secretKeyPrefix}.` : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || keyProblem) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      onPreviewed(await onPreview({ url: url.trim(), project: project.trim(), secretKey: secretKey.trim() }))
    } catch (caught) {
      setFailure(messageOf(caught, 'Could not read the project'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='flex min-w-0 flex-col gap-4'>
      <DialogHeader>
        <DialogTitle>Import from OpenProject</DialogTitle>
        <DialogDescription>Work packages come in as tasks, with their parents, descriptions, dates, comments, relations and attachments. A preview comes first; nothing is imported until you confirm.</DialogDescription>
      </DialogHeader>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>OpenProject address</span>
        <Input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to fill the form.
          autoFocus={!initial.url}
          type='url'
          inputMode='url'
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder='https://openproject.example.com'
        />
      </label>
      {/* The help lines sit outside the labels, so a field's name is its label alone and the help is its description. */}
      <div className='flex flex-col gap-1.5 text-sm'>
        <label htmlFor={`${id}-project`} className='font-medium'>
          Project
        </label>
        <Input
          id={`${id}-project`}
          aria-describedby={`${id}-project-help`}
          required
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder='website-relaunch'
          className='font-mono'
        />
        <p id={`${id}-project-help`} className='text-xs text-muted-foreground'>
          Its identifier, as in the project's address in OpenProject, or its id.
        </p>
      </div>
      <div className='flex flex-col gap-1.5 text-sm'>
        <label htmlFor={`${id}-key`} className='font-medium'>
          Secrets Store key
        </label>
        <Input
          id={`${id}-key`}
          aria-describedby={`${id}-key-help`}
          required
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          aria-invalid={keyProblem ? true : undefined}
          autoComplete='off'
          spellCheck={false}
          className='font-mono'
        />
        {keyProblem ? <Problem>{keyProblem}</Problem> : null}
        <p id={`${id}-key-help`} className='flex items-start gap-1.5 text-xs text-muted-foreground'>
          <KeyRound aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
          <span>The name of the key that holds an OpenProject API token. The token is read on the server for each import and never shown here.</span>
        </p>
      </div>
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
      <DialogFooter>
        <DialogClose render={<Button type='button' variant='outline' />}>Cancel</DialogClose>
        <Button type='submit' disabled={busy || Boolean(keyProblem)}>
          {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
          {busy ? 'Reading the project…' : 'Preview'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function MappingRow({ name, detail, count, children }: { name: ReactNode; detail?: ReactNode; count: number; children: ReactNode }) {
  return (
    <li className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_3rem_minmax(0,13rem)]'>
      <span className='flex min-w-0 items-center gap-2 text-sm'>
        <span className='min-w-0 truncate'>{name}</span>
        {detail}
      </span>
      <span className='text-right text-xs text-muted-foreground tabular-nums'>{count}</span>
      <span className='col-span-2 min-w-0 sm:col-span-1'>{children}</span>
    </li>
  )
}

function MappingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='flex min-w-0 flex-col gap-1.5'>
      <h3 className='text-sm font-medium'>{title}</h3>
      <ul className='flex flex-col divide-y rounded-md border'>{children}</ul>
    </section>
  )
}

const statusValue = (target: OpenProjectStatusTarget | undefined) => (target && 'status' in target ? `status:${target.status}` : 'create')

function personValue(target: OpenProjectPersonTarget | undefined): string {
  if (target === undefined) {
    return 'name'
  }
  if (target === null) {
    return 'none'
  }
  return target.id ? `${target.kind}:${target.id}` : 'name'
}

interface PreviewProps {
  preview: OpenProjectImportPreview
  statuses: readonly OpenProjectTargetStatus[]
  assignees: readonly OpenProjectTargetPerson[]
  onBack: () => void
  onConfirm: (mapping: OpenProjectImportMapping, keepNumbers: boolean, overwrite: string[]) => void
}

/** Step two: the counts, the conflicts, and where each type, status and person lands. */
function PreviewStep({ preview, statuses, assignees, onBack, onConfirm }: PreviewProps) {
  const [mapping, setMapping] = useState<OpenProjectImportMapping>(preview.mapping)
  const [keepNumbers, setKeepNumbers] = useState(preview.keepNumbers)
  const [overwrite, setOverwrite] = useState<ReadonlySet<string>>(new Set())
  const toggleOverwrite = (key: string) =>
    setOverwrite((current) => {
      const next = new Set(current)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  const planCounts: Array<[string, number]> = preview.plan
    ? [
        ['To create', preview.plan.create],
        ['To update', preview.plan.update],
        ['Left as they are', preview.plan.unchanged],
      ]
    : []
  const incoming = preview.byType.filter((type) => mapping.types[type.id] !== 'skip').reduce((sum, type) => sum + type.count, 0)
  const key = preview.project.identifier.toUpperCase()

  const setStatus = (row: OpenProjectStatusRow, value: string) => {
    const suggested = preview.mapping.statuses[row.id]
    const target: OpenProjectStatusTarget = value.startsWith('status:')
      ? { status: value.slice('status:'.length) }
      : suggested && 'create' in suggested
        ? suggested
        : { create: { name: row.name, category: guessCategory(row), color: row.color } }
    setMapping((current) => ({ ...current, statuses: { ...current.statuses, [row.id]: target } }))
  }
  const setPerson = (row: OpenProjectCountRow, value: string) => {
    const [kind, id] = value.split(/:(.*)/s)
    const match = assignees.find((person) => person.kind === kind && person.id === id)
    const target: OpenProjectPersonTarget = value === 'none' ? null : match ? { kind: match.kind, id: match.id, name: match.name } : { kind: 'person', name: row.name }
    setMapping((current) => ({ ...current, people: { ...current.people, [row.id]: target } }))
  }
  const createLabel = (row: OpenProjectStatusRow) => {
    const suggested = preview.mapping.statuses[row.id]
    const create = suggested && 'create' in suggested ? suggested.create : { name: row.name, category: guessCategory(row) }
    return `New: ${create.name} (${CATEGORY_LABEL[create.category]})`
  }

  return (
    <div className='flex min-h-0 min-w-0 flex-col gap-4'>
      <DialogHeader>
        <DialogTitle className='break-words'>Import {preview.project.name}?</DialogTitle>
        <DialogDescription>
          {plural(preview.workPackages, 'work package')} in OpenProject.
          {preview.alreadyImported > 0 ? ` ${plural(preview.alreadyImported, 'was', 'were')} imported before: those are brought up to date, never added twice.` : ''} Check where
          each type, status and person lands.
        </DialogDescription>
      </DialogHeader>
      <div className='-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6'>
        {planCounts.length > 0 ? (
          <dl aria-label='What the import would do' className='grid grid-cols-3 gap-2'>
            {planCounts.map(([label, value]) => (
              <div key={label} className='min-w-0 rounded-md border px-3 py-2'>
                <dt className='truncate text-xs text-muted-foreground'>{label}</dt>
                <dd className='text-lg font-semibold tabular-nums'>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {preview.attachments || preview.relations !== undefined ? (
          <p className='text-sm text-muted-foreground'>
            {[
              preview.relations !== undefined ? `Up to ${plural(preview.relations, 'relation')} between tasks` : null,
              preview.attachments ? `${plural(preview.attachments.count, 'attachment')} (${fileSize(preview.attachments.bytes)})` : null,
            ]
              .filter(Boolean)
              .join(' and ')}{' '}
            come along.
            {preview.attachments && preview.attachments.skipped.length > 0
              ? ` ${plural(preview.attachments.skipped.length, 'file is', 'files are')} over the size limit and left out: ${preview.attachments.skipped.map((item) => `${item.summary} on ${item.source}`).join(', ')}.`
              : ''}
          </p>
        ) : null}
        {preview.conflicts && preview.conflicts.length > 0 ? <ConflictList conflicts={preview.conflicts} chosen={overwrite} onToggle={toggleOverwrite} /> : null}
        <MappingGroup title='Types'>
          {preview.byType.map((row) => (
            <MappingRow key={row.id} name={row.name} count={row.count}>
              <select
                aria-label={`${row.name} becomes`}
                className={SELECT}
                value={mapping.types[row.id] ?? 'task'}
                onChange={(event) => setMapping((current) => ({ ...current, types: { ...current.types, [row.id]: event.target.value as OpenProjectTaskType | 'skip' } }))}
              >
                {(Object.keys(TYPE_LABEL) as Array<OpenProjectTaskType | 'skip'>).map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </MappingRow>
          ))}
        </MappingGroup>
        <MappingGroup title='Statuses'>
          {preview.byStatus.map((row) => (
            <MappingRow
              key={row.id}
              name={
                <span className='flex min-w-0 items-center gap-2'>
                  <span aria-hidden='true' className='size-2.5 shrink-0 rounded-full bg-muted-foreground/40' style={row.color ? { backgroundColor: row.color } : undefined} />
                  <span className='truncate'>{row.name}</span>
                </span>
              }
              detail={row.isClosed ? <span className='shrink-0 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground'>closed</span> : null}
              count={row.count}
            >
              <select aria-label={`${row.name} becomes`} className={SELECT} value={statusValue(mapping.statuses[row.id])} onChange={(event) => setStatus(row, event.target.value)}>
                {statuses.map((status) => (
                  <option key={status.id} value={`status:${status.id}`}>
                    {status.name}
                  </option>
                ))}
                <option value='create'>{createLabel(row)}</option>
              </select>
            </MappingRow>
          ))}
        </MappingGroup>
        {preview.people.length > 0 ? (
          <MappingGroup title='People'>
            {preview.people.map((row) => (
              <MappingRow key={row.id} name={row.name} count={row.count}>
                <select aria-label={`${row.name} becomes`} className={SELECT} value={personValue(mapping.people[row.id])} onChange={(event) => setPerson(row, event.target.value)}>
                  <option value='name'>Keep the name only</option>
                  <option value='none'>Nobody</option>
                  {assignees.map((person) => (
                    <option key={`${person.kind}:${person.id}`} value={`${person.kind}:${person.id}`}>
                      {person.kind === 'agent' ? `${person.name} (agent)` : person.name}
                    </option>
                  ))}
                </select>
              </MappingRow>
            ))}
          </MappingGroup>
        ) : null}
        <label className='flex cursor-pointer items-start gap-2 text-sm'>
          <input type='checkbox' checked={keepNumbers} onChange={(event) => setKeepNumbers(event.target.checked)} className='mt-0.5 accent-primary' />
          <span>
            Keep OpenProject's numbers
            <span className='block text-xs text-muted-foreground'>{key}-12 becomes task 12 here where that number is still free.</span>
          </span>
        </label>
      </div>
      <DialogFooter>
        <Button variant='outline' onClick={onBack}>
          <ArrowLeft aria-hidden='true' />
          Back
        </Button>
        <Button onClick={() => onConfirm(mapping, keepNumbers, [...overwrite])} disabled={incoming === 0} className='min-w-0'>
          <Download aria-hidden='true' />
          <span className='truncate'>Import {plural(incoming, 'work package')}</span>
        </Button>
      </DialogFooter>
    </div>
  )
}

function every(minutes: number): string {
  return minutes % 60 === 0 ? (minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`) : `Every ${minutes} minutes`
}

interface ScheduleProps {
  sync: NonNullable<TaskOpenProjectImportProps['sync']>
  choices: readonly number[]
  onChange: NonNullable<TaskOpenProjectImportProps['onSyncChange']>
}

/** Import again on a schedule, with the last import's mapping, keeping every change made here. */
function Schedule({ sync, choices, onChange }: ScheduleProps) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const id = useId()

  const change = async (value: string) => {
    setBusy(true)
    setFailure(null)
    try {
      await onChange(value === 'off' ? null : Number(value))
    } catch (caught) {
      setFailure(messageOf(caught, 'The schedule could not change'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='flex min-w-0 flex-col gap-1.5 text-sm'>
      <div className='flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3'>
        <label htmlFor={`${id}-sync`} className='font-medium sm:flex-1'>
          Keep in step with OpenProject
        </label>
        <select
          id={`${id}-sync`}
          aria-describedby={`${id}-sync-help`}
          className={cn(SELECT, 'sm:w-44')}
          value={sync.minutes === null ? 'off' : String(sync.minutes)}
          disabled={busy}
          onChange={(event) => void change(event.target.value)}
        >
          <option value='off'>Off</option>
          {choices.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {every(minutes)}
            </option>
          ))}
        </select>
      </div>
      <p id={`${id}-sync-help`} className='text-xs text-muted-foreground'>
        Imports again on its own with the last import's mapping. Changes made here are kept; where OpenProject changed the same field, the last import lists it.
      </p>
      {sync.error ? (
        <Problem>
          The scheduled import failed {when(sync.error.at)}: {sync.error.message}
        </Problem>
      ) : null}
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
    </div>
  )
}

type Step =
  | { kind: 'connect' }
  | { kind: 'preview'; preview: OpenProjectImportPreview }
  | { kind: 'importing'; preview: OpenProjectImportPreview }
  | { kind: 'failed'; preview: OpenProjectImportPreview; message: string }
  | { kind: 'done'; preview: OpenProjectImportPreview; result: OpenProjectImportSummary }

/**
 * Importing a project from OpenProject, for the settings page: the saved
 * connection and what the last import did, and a dialog that connects, shows
 * a preview with the type, status and people mapping, and then imports.
 */
export function TaskOpenProjectImport({
  connection = null,
  defaultSecretKey = 'OPENPROJECT_API_TOKEN',
  secretKeyPrefix,
  lastImport = null,
  statuses,
  assignees,
  loading = false,
  error = null,
  onRetry,
  onPreview,
  onImport,
  sync = { minutes: null, error: null },
  syncChoices = [5, 15, 60],
  onSyncChange,
  defaultOpen = false,
  className,
}: TaskOpenProjectImportProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [step, setStep] = useState<Step>({ kind: 'connect' })
  // What the form starts from: the last preview's connection, else the saved one.
  const [draft, setDraft] = useState<OpenProjectConnectionValue | null>(null)

  if (loading) {
    return (
      <div role='status' aria-label='Loading the import settings' className={cn('flex flex-col gap-2', className)}>
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-9 w-48' />
      </div>
    )
  }
  if (error) {
    return <TaskManagerError variant='inline' title='The import settings could not load' message={error} onRetry={onRetry} className={className} />
  }

  const initial = draft ?? connection ?? { url: '', project: '', secretKey: defaultSecretKey }
  const openDialog = () => {
    setStep({ kind: 'connect' })
    setOpen(true)
  }
  const confirm = async (preview: OpenProjectImportPreview, mapping: OpenProjectImportMapping, keepNumbers: boolean, overwrite: string[]) => {
    setStep({ kind: 'importing', preview })
    try {
      const result = await onImport({ connection: preview.connection, mapping, keepNumbers, overwrite })
      setStep({ kind: 'done', preview, result })
    } catch (caught) {
      setStep({ kind: 'failed', preview, message: messageOf(caught, 'The import failed') })
    }
  }

  return (
    <div data-slot='task-openproject-import' className={cn('flex min-w-0 flex-col gap-4', className)}>
      <div className='flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center'>
        <div className='min-w-0 flex-1 text-sm'>
          {connection ? (
            <>
              <p className='truncate font-medium'>{connection.url}</p>
              <p className='truncate text-xs text-muted-foreground'>
                Project <span className='font-mono'>{connection.project}</span> · token from <span className='font-mono'>{connection.secretKey}</span>
              </p>
            </>
          ) : (
            <>
              <p className='font-medium'>Not connected</p>
              <p className='text-xs text-muted-foreground'>Connect an OpenProject project to bring its work packages in as tasks.</p>
            </>
          )}
        </div>
        <Button onClick={openDialog} className='shrink-0 self-start sm:self-auto'>
          <Download aria-hidden='true' />
          {connection ? 'Import again…' : 'Import from OpenProject…'}
        </Button>
      </div>

      {lastImport && onSyncChange ? <Schedule sync={sync} choices={syncChoices} onChange={onSyncChange} /> : null}

      {lastImport ? (
        <section className='flex min-w-0 flex-col gap-2'>
          <h3 className='text-sm font-medium'>
            Last import <span className='font-normal text-muted-foreground'>· {when(lastImport.at)}{lastImport.by ? ` by ${lastImport.by}` : ''}</span>
          </h3>
          <Summary result={lastImport.result} />
        </section>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl'>
          {step.kind === 'connect' ? (
            <ConnectStep
              initial={initial}
              secretKeyPrefix={secretKeyPrefix}
              onPreview={onPreview}
              onPreviewed={(preview) => {
                setDraft(preview.connection)
                setStep({ kind: 'preview', preview })
              }}
            />
          ) : null}
          {step.kind === 'preview' ? (
            <PreviewStep
              preview={step.preview}
              statuses={statuses}
              assignees={assignees}
              onBack={() => setStep({ kind: 'connect' })}
              onConfirm={(mapping, keepNumbers, overwrite) => void confirm(step.preview, mapping, keepNumbers, overwrite)}
            />
          ) : null}
          {step.kind === 'importing' ? (
            <div className='flex flex-col gap-4'>
              <DialogHeader>
                <DialogTitle className='break-words'>Importing {step.preview.project.name}…</DialogTitle>
                <DialogDescription>Each work package's comments and files are read one by one, so a large project takes a few minutes. Closing this does not stop it.</DialogDescription>
              </DialogHeader>
              <p role='status' className='flex items-center gap-2 text-sm text-muted-foreground'>
                <Loader2 aria-hidden='true' className='size-4 animate-spin' />
                Importing…
              </p>
            </div>
          ) : null}
          {step.kind === 'failed' ? (
            <div className='flex flex-col gap-4'>
              <DialogHeader>
                <DialogTitle>The import failed</DialogTitle>
                <DialogDescription>Nothing was imported: an import is written all at once or not at all.</DialogDescription>
              </DialogHeader>
              <Problem>{step.message}</Problem>
              <DialogFooter>
                <Button variant='outline' onClick={() => setStep({ kind: 'preview', preview: step.preview })}>
                  <ArrowLeft aria-hidden='true' />
                  Back
                </Button>
              </DialogFooter>
            </div>
          ) : null}
          {step.kind === 'done' ? (
            <div className='flex min-h-0 flex-col gap-4'>
              <DialogHeader>
                <DialogTitle className='flex items-center gap-2 break-words'>
                  <CircleCheck aria-hidden='true' className='size-5 shrink-0 text-emerald-600' />
                  {step.preview.project.name} is imported
                </DialogTitle>
                <DialogDescription>Import again at any time: what changed in OpenProject is brought up to date, changes made here are kept, and nothing is added twice.</DialogDescription>
              </DialogHeader>
              <div className='-mx-6 min-h-0 flex-1 overflow-y-auto px-6'>
                <Summary result={step.result} />
              </div>
              <DialogFooter>
                <DialogClose render={<Button />}>Done</DialogClose>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
