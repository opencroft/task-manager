import { AlertTriangle, Ban, CircleAlert, Loader2, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'

import { Button } from '../button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../command'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { linkConflict } from '../timeline/timeline-links-model'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskType, TaskTypeIcon } from './task-type-icon'

/** How a related task stands to this one. Only `blockedBy` holds this task back. */
export type TaskDependencyRelation = 'blockedBy' | 'blocks' | 'follows' | 'precedes' | 'duplicates' | 'duplicatedBy' | 'relatesTo'

export interface TaskDependency {
  key: string
  summary: string
  type?: TaskType
  status: { name: string; category: TaskStatusCategory; color?: string | null }
  startDate?: string | null
  endDate?: string | null
}

export interface TaskDependenciesProps {
  /** The related tasks by relation; a relation left out has none. */
  relations: Partial<Record<TaskDependencyRelation, TaskDependency[]>>
  /** This task's dates; given, a clash with a blocking or following task's dates is flagged on its row. */
  task?: { key?: string; startDate?: string | null; endDate?: string | null }
  onOpen: (key: string) => void
  /** Relates a task. A rejection keeps the picker open and shows its message, e.g. a cycle. */
  onAdd?: (relation: TaskDependencyRelation, key: string) => Promise<unknown> | unknown
  /** Removes a relation. A rejection shows its message under the group. */
  onRemove?: (relation: TaskDependencyRelation, key: string) => Promise<unknown> | unknown
  /** A row's menu on right-click, long press, the Menu key or Shift+F10: e.g. open, copy, remove the relation. */
  rowMenu?: (relation: TaskDependencyRelation, item: TaskDependency) => ItemMenuEntries
  /** What the picker offers. This task and those already related are left out. */
  candidates?: TaskDependency[]
  /** Search on the server instead of filtering `candidates` here. */
  onSearch?: (query: string) => void
  searching?: boolean
  className?: string
}

/**
 * Each relation's wording, in the order the groups show. `order` says which
 * side's dates a clash compares: `after`, this task should start after the
 * related one ends; `before`, the other way round.
 */
const GROUP: Record<TaskDependencyRelation, { title: string; empty: string; add: string; heading: string; order?: 'after' | 'before' }> = {
  blockedBy: { title: 'Blocked by', empty: 'Nothing blocks this task.', add: 'Add a task this one waits for', heading: 'This task waits for', order: 'after' },
  blocks: { title: 'Blocks', empty: 'This task blocks nothing.', add: 'Add a task that waits for this one', heading: 'Waits for this task', order: 'before' },
  follows: { title: 'Follows', empty: '', add: 'Add a task this one comes after', heading: 'This task comes after', order: 'after' },
  precedes: { title: 'Precedes', empty: '', add: 'Add a task that comes after this one', heading: 'Comes after this task', order: 'before' },
  duplicates: { title: 'Duplicates', empty: '', add: 'Add a task this one duplicates', heading: 'This task duplicates' },
  duplicatedBy: { title: 'Duplicated by', empty: '', add: 'Add a task that duplicates this one', heading: 'Duplicates this task' },
  relatesTo: { title: 'Relates to', empty: '', add: 'Add a related task', heading: 'Related to this task' },
}

const RELATIONS = Object.keys(GROUP) as TaskDependencyRelation[]

/** Shown even when empty, as the two that hold work back. */
const ALWAYS_SHOWN: ReadonlySet<TaskDependencyRelation> = new Set(['blockedBy', 'blocks'])

function message(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return typeof error === 'string' && error ? error : 'That did not work.'
}

const dated = (value: { startDate?: string | null; endDate?: string | null }) => ({
  startDate: value.startDate ?? null,
  endDate: value.endDate ?? null,
})

const SELECT =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground'

interface PickerProps {
  /** The relation added; with more than one, the picker offers a choice, starting at the first. */
  relations: readonly TaskDependencyRelation[]
  label: string
  candidates: TaskDependency[]
  onAdd: NonNullable<TaskDependenciesProps['onAdd']>
  onSearch?: (query: string) => void
  searching?: boolean
}

function Picker({ relations, label, candidates, onAdd, onSearch, searching = false }: PickerProps) {
  const [open, setOpen] = useState(false)
  const [relation, setRelation] = useState<TaskDependencyRelation>(relations[0] as TaskDependencyRelation)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const choiceId = useId()

  const reset = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery('')
      setError(null)
      setRelation(relations[0] as TaskDependencyRelation)
    }
  }
  const pick = async (key: string) => {
    setPending(key)
    setError(null)
    try {
      await onAdd(relation, key)
      reset(false)
    } catch (caught) {
      setError(message(caught))
    } finally {
      setPending(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger render={<Button variant='ghost' size='xs' aria-label={label} title={label} />}>
        <Plus aria-hidden='true' />
        {relations.length > 1 ? 'Add relation' : 'Add'}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(22rem,calc(100vw-1rem))] gap-0 p-0'>
        {relations.length > 1 ? (
          <div className='flex items-center gap-2 border-b px-3 py-2'>
            <label htmlFor={choiceId} className='shrink-0 text-xs text-muted-foreground'>
              This task
            </label>
            <select
              id={choiceId}
              className={SELECT}
              value={relation}
              onChange={(event) => {
                setRelation(event.target.value as TaskDependencyRelation)
                setError(null)
              }}
            >
              {relations.map((choice) => (
                <option key={choice} value={choice}>
                  {GROUP[choice].title.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Command shouldFilter={!onSearch}>
          <CommandInput
            value={query}
            onValueChange={(value) => {
              setQuery(value)
              onSearch?.(value)
            }}
            placeholder='Find a task by key or summary…'
          />
          <ScrollArea className='max-h-72' viewportClassName='scroll-py-1'>
            <CommandList className='max-h-none overflow-visible'>
              {searching ? (
                <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>
                  <Loader2 aria-hidden='true' className='size-4 animate-spin' />
                  Searching
                </div>
              ) : (
                <CommandEmpty>No task matches.</CommandEmpty>
              )}
              {!searching && candidates.length > 0 ? (
                <CommandGroup heading={GROUP[relation].heading}>
                  {candidates.map((candidate) => (
                    <CommandItem
                      key={candidate.key}
                      value={`${candidate.key} ${candidate.summary}`}
                      disabled={pending !== null}
                      onSelect={() => pick(candidate.key)}
                      className='gap-2'
                    >
                      {candidate.type ? <TaskTypeIcon type={candidate.type} /> : null}
                      <span className='shrink-0 font-mono text-xs text-muted-foreground'>{candidate.key}</span>
                      <span className='min-w-0 flex-1 truncate'>{candidate.summary}</span>
                      {pending === candidate.key ? (
                        <Loader2 aria-label='Linking' className='size-3.5 shrink-0 animate-spin' />
                      ) : (
                        <TaskStatusBadge size='sm' name={candidate.status.name} category={candidate.status.category} color={candidate.status.color} className='max-w-24' />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </ScrollArea>
        </Command>
        {error ? (
          <p role='alert' className='flex items-start gap-1.5 border-t px-3 py-2 text-xs text-destructive'>
            <CircleAlert aria-hidden='true' className='mt-px size-3.5 shrink-0' />
            <span className='min-w-0 break-words'>{error}</span>
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

interface GroupProps extends Omit<TaskDependenciesProps, 'relations' | 'className'> {
  relation: TaskDependencyRelation
  items: TaskDependency[]
  exclude: ReadonlySet<string>
}

function Group({ relation, items, exclude, task, onOpen, onAdd, onRemove, rowMenu, candidates = [], onSearch, searching }: GroupProps) {
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const meta = GROUP[relation]
  const open = relation === 'blockedBy' ? items.filter((item) => item.status.category !== 'done').length : 0
  const headingId = `${useId()}-${relation}`

  const remove = async (key: string) => {
    if (!onRemove) {
      return
    }
    setRemoving(key)
    setError(null)
    try {
      await onRemove(relation, key)
    } catch (caught) {
      setError(message(caught))
    } finally {
      setRemoving(null)
    }
  }

  const clash = (item: TaskDependency) => {
    if (!task || !meta.order) {
      return false
    }
    return meta.order === 'after' ? linkConflict(dated(item), dated(task)) : linkConflict(dated(task), dated(item))
  }

  const clashing = items.filter(clash).map((item) => item.key)
  const clashNote = meta.order === 'after' ? 'Ends after this task starts' : 'Starts before this task ends'

  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-1.5'>
      <div className='flex min-w-0 items-center gap-2'>
        <h4 id={headingId} className='text-xs font-medium text-muted-foreground'>
          {meta.title}
        </h4>
        {items.length > 0 ? <span className='text-xs text-muted-foreground tabular-nums'>{items.length}</span> : null}
        {open > 0 ? (
          <span className='inline-flex h-5 items-center rounded-md bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300'>{open} open</span>
        ) : null}
        {onAdd ? (
          <span className='ml-auto'>
            <Picker
              relations={[relation]}
              label={meta.add}
              candidates={candidates.filter((candidate) => !exclude.has(candidate.key))}
              onAdd={onAdd}
              onSearch={onSearch}
              searching={searching}
            />
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{meta.empty}</p>
      ) : (
        <ul className='flex flex-col overflow-hidden rounded-md border'>
          {items.map((item) => {
            const clashes = clash(item)
            const busy = removing === item.key
            return (
              <ItemContextMenu
                key={item.key}
                entries={rowMenu?.(relation, item) ?? []}
                render={<li />}
                className={cn('flex min-w-0 items-center border-b last:border-b-0', busy && 'opacity-50')}
              >
                <button
                  type='button'
                  onClick={() => onOpen(item.key)}
                  className='flex h-10 min-w-0 flex-1 items-center gap-2.5 px-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset'
                >
                  {item.type ? <TaskTypeIcon type={item.type} /> : null}
                  <span className='shrink-0 font-mono text-xs text-muted-foreground'>{item.key}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-sm', item.status.category === 'done' && 'text-muted-foreground')}>{item.summary}</span>
                  {clashes ? (
                    <span className='shrink-0 text-destructive' title={clashNote}>
                      <AlertTriangle aria-hidden='true' className='size-3.5' />
                      <span className='sr-only'>{clashNote}</span>
                    </span>
                  ) : null}
                  <TaskStatusBadge size='sm' name={item.status.name} category={item.status.category} color={item.status.color} className='max-w-28' />
                </button>
                {onRemove ? (
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    className='mr-1.5 shrink-0'
                    aria-label={`Remove the relation to ${item.key}`}
                    title='Remove the relation'
                    disabled={busy}
                    onClick={() => remove(item.key)}
                  >
                    {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : <X aria-hidden='true' />}
                  </Button>
                ) : null}
              </ItemContextMenu>
            )
          })}
        </ul>
      )}
      {clashing.length > 0 ? (
        <p className='flex items-start gap-1.5 text-xs text-destructive'>
          <AlertTriangle aria-hidden='true' className='mt-px size-3.5 shrink-0' />
          <span className='min-w-0 break-words'>
            {clashing.join(', ')} {meta.order === 'after' ? (clashing.length === 1 ? 'ends' : 'end') : clashing.length === 1 ? 'starts' : 'start'}{' '}
            {meta.order === 'after' ? 'after this task starts.' : 'before this task ends.'}
          </span>
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='flex items-start gap-1.5 text-xs text-destructive'>
          <CircleAlert aria-hidden='true' className='mt-px size-3.5 shrink-0' />
          <span className='min-w-0 break-words'>{error}</span>
        </p>
      ) : null}
    </section>
  )
}

/**
 * A task's relations, for a section of its details page: Blocked by and Blocks
 * always, then each other relation it has, in a fixed order, and a way to add
 * any of them. While a blocker is not done a line says the task is blocked.
 */
export function TaskDependencies({ relations, className, ...rest }: TaskDependenciesProps) {
  const itemsOf = (relation: TaskDependencyRelation) => relations[relation] ?? []
  const exclude = new Set([...(rest.task?.key ? [rest.task.key] : []), ...RELATIONS.flatMap((relation) => itemsOf(relation).map((item) => item.key))])
  const open = itemsOf('blockedBy').filter((item) => item.status.category !== 'done')
  const shown = RELATIONS.filter((relation) => ALWAYS_SHOWN.has(relation) || itemsOf(relation).length > 0)
  return (
    <div data-slot='task-dependencies' className={cn('flex min-w-0 flex-col gap-4', className)}>
      {open.length > 0 ? (
        <p className='flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200'>
          <Ban aria-hidden='true' className='size-4 shrink-0' />
          <span className='min-w-0'>
            Blocked until {open.length === 1 ? <span className='font-mono'>{open[0].key}</span> : `${open.length} tasks`} {open.length === 1 ? 'is' : 'are'} done.
          </span>
        </p>
      ) : null}
      {shown.map((relation) => (
        <Group key={relation} relation={relation} items={itemsOf(relation)} exclude={exclude} {...rest} />
      ))}
      {rest.onAdd ? (
        <div className='flex justify-start'>
          <Picker
            relations={RELATIONS.filter((relation) => !ALWAYS_SHOWN.has(relation))}
            label='Add another relation: follows, precedes, duplicates, duplicated by or relates to'
            candidates={(rest.candidates ?? []).filter((candidate) => !exclude.has(candidate.key))}
            onAdd={rest.onAdd}
            onSearch={rest.onSearch}
            searching={rest.searching}
          />
        </div>
      ) : null}
    </div>
  )
}
