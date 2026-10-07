import {
  ArrowLeft,
  CalendarRange,
  ChevronsUp,
  CircleDot,
  Columns3,
  ListTodo,
  Loader2,
  Play,
  Plus,
  UserRound,
  Workflow,
} from 'lucide-react'
import { Fragment, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog'
import { TaskAssignee, type TaskAssigneeValue } from '../tasks/task-assignee'
import {
  TASK_PRIORITIES,
  TaskPriorityIcon,
  type TaskPriority,
} from '../tasks/task-priority-icon'
import { type TaskProject, TaskProjectChip } from '../tasks/task-project-chip'
import { TaskStatusBadge, type TaskStatusCategory } from '../tasks/task-status-badge'
import { TaskTypeIcon, type TaskType } from '../tasks/task-type-icon'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'
import { findShortcut, ShortcutKeys, type ShortcutPlatform } from './keyboard-shortcuts-dialog'
import { readTaskKeyQuery } from './task-key-query'

export type TaskCommandPalettePage = 'my-work' | 'tasks' | 'board' | 'timeline' | 'workflows'

/** `root` is the search; the others are the step after picking an action. */
export type TaskCommandPaletteView = 'root' | 'create' | 'status' | 'assignee' | 'priority' | 'workflow'

export interface TaskCommandPaletteStatus {
  id?: string | number
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface TaskCommandPaletteAssignee extends TaskAssigneeValue {
  id?: string
}

export interface TaskCommandPaletteTask {
  key: string
  summary: string
  type: TaskType
  priority: TaskPriority
  status: TaskCommandPaletteStatus
  assignee: TaskCommandPaletteAssignee | null
  /** Set on a task of another project (see `elsewhere`); shown on its row, handed back to `onOpenTask`. */
  project?: TaskProject
}

export interface TaskCommandPaletteWorkflow {
  id: string
  name: string
  isDefault?: boolean
}

export interface TaskCommandPalettePanelProps {
  /** Tasks to search. With `filterTasks` off, the results for the current query. */
  tasks: TaskCommandPaletteTask[]
  /** Keys of recently opened tasks, most recent first: shown before typing, and ranked first in results. */
  recentKeys?: string[]
  /** Filter `tasks` by the query here. Turn off when the host searches on the server. */
  filterTasks?: boolean
  /** A server search is in flight. */
  searching?: boolean
  /** Tasks of other projects matching the query, each with its `project`: listed under Other projects. */
  elsewhere?: TaskCommandPaletteTask[]
  /** The search of other projects is in flight. */
  searchingElsewhere?: boolean
  defaultQuery?: string
  onQueryChange?: (query: string) => void
  view?: TaskCommandPaletteView
  defaultView?: TaskCommandPaletteView
  onViewChange?: (view: TaskCommandPaletteView) => void
  /** The page it was opened on; left out of Go to. */
  currentPage?: TaskCommandPalettePage
  /** The open task, which the status, assignee, priority and workflow actions apply to. */
  currentTask?: TaskCommandPaletteTask | null
  statuses?: TaskCommandPaletteStatus[]
  assignees?: TaskCommandPaletteAssignee[]
  workflows?: TaskCommandPaletteWorkflow[]
  onOpenTask?: (task: TaskCommandPaletteTask) => void
  /** Create a task with this summary. */
  onCreateTask?: (summary: string) => void
  onNavigate?: (page: TaskCommandPalettePage) => void
  onChangeStatus?: (status: TaskCommandPaletteStatus) => void
  onChangeAssignee?: (assignee: TaskCommandPaletteAssignee | null) => void
  onChangePriority?: (priority: TaskPriority) => void
  onStartWorkflow?: (workflow: TaskCommandPaletteWorkflow) => void
  /** Called after an action runs. Without it the panel returns to the search. */
  onClose?: () => void
  platform?: ShortcutPlatform
  className?: string
}

const PAGES: { page: TaskCommandPalettePage; label: string; icon: ComponentType<{ className?: string }>; shortcut: string }[] = [
  { page: 'my-work', label: 'My work', icon: UserRound, shortcut: 'go-my-work' },
  { page: 'tasks', label: 'Tasks', icon: ListTodo, shortcut: 'go-tasks' },
  { page: 'board', label: 'Board', icon: Columns3, shortcut: 'go-board' },
  { page: 'timeline', label: 'Timeline', icon: CalendarRange, shortcut: 'go-timeline' },
  { page: 'workflows', label: 'Workflows', icon: Workflow, shortcut: 'go-workflows' },
]

const VIEW_TITLE: Record<TaskCommandPaletteView, string> = {
  root: '',
  create: 'Create a task',
  status: 'Change status',
  assignee: 'Change assignee',
  priority: 'Change priority',
  workflow: 'Start a workflow',
}

const PLACEHOLDER: Record<TaskCommandPaletteView, string> = {
  root: 'Find a task by key or summary, or type a command…',
  create: 'Summary of the new task',
  status: 'Find a status…',
  assignee: 'Find a person or agent…',
  priority: 'Find a priority…',
  workflow: 'Find a workflow…',
}

const RECENT_LIMIT = 5
const RESULT_LIMIT = 8

function tokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function matches(text: string, words: string[]): boolean {
  const haystack = text.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * Tasks whose key or summary contains every word, or the task a key-shaped query names (see `readTaskKeyQuery`):
 * the named task, then key prefix, then summary prefix; recent first within each.
 */
function searchTasks(tasks: TaskCommandPaletteTask[], query: string, recentKeys: string[]): TaskCommandPaletteTask[] {
  const q = query.trim().toLowerCase()
  const words = tokens(query)
  const named = readTaskKeyQuery(query)
  const isNamed = (task: TaskCommandPaletteTask) =>
    named !== null && (named.project ? task.key === `${named.project}-${named.number}` : task.key.endsWith(`-${named.number}`))
  const recentRank: Record<string, number> = {}
  recentKeys.forEach((key, index) => {
    recentRank[key] = index
  })
  const score = (task: TaskCommandPaletteTask) => {
    const key = task.key.toLowerCase()
    if (isNamed(task)) return 0
    if (key.startsWith(q)) return 1
    if (task.summary.toLowerCase().startsWith(q)) return 2
    return 3
  }
  return tasks
    .filter((task) => isNamed(task) || matches(`${task.key} ${task.summary}`, words))
    .map((task, index) => ({ task, index, score: score(task), recent: recentRank[task.key] ?? recentKeys.length }))
    .sort((a, b) => a.score - b.score || a.recent - b.recent || a.index - b.index)
    .map((entry) => entry.task)
}

function sameAssignee(a: TaskCommandPaletteAssignee, b: TaskCommandPaletteAssignee | null | undefined): boolean {
  if (!b) return false
  if (a.id && b.id) return a.id === b.id
  return a.kind === b.kind && a.name === b.name
}

function sameStatus(a: TaskCommandPaletteStatus, b: TaskCommandPaletteStatus | undefined): boolean {
  if (!b) return false
  if (a.id != null && b.id != null) return a.id === b.id
  return a.name.toLowerCase() === b.name.toLowerCase()
}

function Hint({ id, platform }: { id: string; platform?: ShortcutPlatform }) {
  const shortcut = findShortcut(id)
  if (!shortcut) return null
  return (
    <CommandShortcut className='hidden tracking-normal @sm:inline-flex'>
      <ShortcutKeys keys={shortcut.keys} platform={platform} />
    </CommandShortcut>
  )
}

function TaskRow({ task }: { task: TaskCommandPaletteTask }) {
  return (
    <>
      <TaskTypeIcon type={task.type} />
      <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
      <TaskProjectChip project={task.project} />
      <span className='min-w-0 flex-1 truncate'>{task.summary}</span>
      <TaskStatusBadge
        name={task.status.name}
        category={task.status.category}
        color={task.status.color}
        size='sm'
        className='hidden max-w-32 shrink-0 @md:inline-flex'
      />
      <TaskPriorityIcon priority={task.priority} className='hidden @sm:inline-flex' />
      <TaskAssignee assignee={task.assignee} size='sm' className='hidden @sm:inline-flex' />
    </>
  )
}

interface ActionEntry {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  shortcut?: string
  trailing?: ReactNode
  run: () => void
}

/** The palette's contents without the dialog: for showing it inline, or inside a host's own overlay. */
export function TaskCommandPalettePanel({
  tasks,
  recentKeys = [],
  filterTasks = true,
  searching = false,
  elsewhere = [],
  searchingElsewhere = false,
  defaultQuery = '',
  onQueryChange,
  view,
  defaultView = 'root',
  onViewChange,
  currentPage,
  currentTask,
  statuses,
  assignees,
  workflows,
  onOpenTask,
  onCreateTask,
  onNavigate,
  onChangeStatus,
  onChangeAssignee,
  onChangePriority,
  onStartWorkflow,
  onClose,
  platform,
  className,
}: TaskCommandPalettePanelProps) {
  const [query, setQuery] = useState(defaultQuery)
  const [innerView, setInnerView] = useState<TaskCommandPaletteView>(defaultView)
  const current = view ?? innerView
  const words = tokens(query)
  const typed = query.trim()

  function changeQuery(next: string) {
    setQuery(next)
    onQueryChange?.(next)
  }

  function go(next: TaskCommandPaletteView) {
    setInnerView(next)
    onViewChange?.(next)
    changeQuery('')
  }

  function done(run: () => void) {
    run()
    if (onClose) onClose()
    else go('root')
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (current === 'root') return
    if (event.key === 'Escape' || (event.key === 'Backspace' && query === '')) {
      event.preventDefault()
      event.stopPropagation()
      go('root')
    }
  }

  const canStatus = !!(currentTask && onChangeStatus && statuses?.length)
  const canAssignee = !!(currentTask && onChangeAssignee && assignees)
  const canPriority = !!(currentTask && onChangePriority)
  const onlyWorkflow = workflows?.length === 1 ? workflows[0] : undefined
  const canWorkflow = !!(currentTask && onStartWorkflow && workflows?.length)

  const taskActions: ActionEntry[] = []
  if (currentTask && canStatus) {
    taskActions.push({
      id: 'status',
      label: 'Change status…',
      icon: CircleDot,
      shortcut: 'status',
      trailing: (
        <TaskStatusBadge
          name={currentTask.status.name}
          category={currentTask.status.category}
          color={currentTask.status.color}
          size='sm'
          className='hidden max-w-32 @md:inline-flex'
        />
      ),
      run: () => go('status'),
    })
  }
  if (currentTask && canAssignee) {
    taskActions.push({
      id: 'assignee',
      label: 'Change assignee…',
      icon: UserRound,
      shortcut: 'assignee',
      trailing: <TaskAssignee assignee={currentTask.assignee} size='sm' className='hidden @md:inline-flex' />,
      run: () => go('assignee'),
    })
  }
  if (currentTask && canPriority) {
    taskActions.push({
      id: 'priority',
      label: 'Change priority…',
      icon: ChevronsUp,
      shortcut: 'priority',
      trailing: <TaskPriorityIcon priority={currentTask.priority} className='hidden @md:inline-flex' />,
      run: () => go('priority'),
    })
  }
  if (canWorkflow && onStartWorkflow) {
    taskActions.push(
      onlyWorkflow
        ? {
            id: 'workflow',
            label: `Start workflow: ${onlyWorkflow.name}`,
            icon: Play,
            run: () => done(() => onStartWorkflow(onlyWorkflow)),
          }
        : { id: 'workflow', label: 'Start a workflow…', icon: Play, run: () => go('workflow') },
    )
  }

  const pageActions: ActionEntry[] = onNavigate
    ? PAGES.filter((entry) => entry.page !== currentPage).map((entry) => ({
        id: `go-${entry.page}`,
        label: `Go to ${entry.label}`,
        icon: entry.icon,
        shortcut: entry.shortcut,
        run: () => done(() => onNavigate(entry.page)),
      }))
    : []

  function renderActions(entries: ActionEntry[]) {
    return entries.map((entry) => {
      const Icon = entry.icon
      return (
        <CommandItem key={entry.id} value={entry.id} onSelect={entry.run}>
          <Icon className='text-muted-foreground' />
          <span className='min-w-0 flex-1 truncate'>{entry.label}</span>
          {entry.trailing}
          {entry.shortcut && <Hint id={entry.shortcut} platform={platform} />}
        </CommandItem>
      )
    })
  }

  function renderTasks(heading: string, list: TaskCommandPaletteTask[]) {
    return (
      <CommandGroup heading={heading}>
        {list.map((task) => (
          <CommandItem
            key={`${task.project?.app ?? task.project?.key ?? ''}:${task.key}`}
            value={`task:${task.project?.app ?? task.project?.key ?? ''}:${task.key}`}
            onSelect={() => done(() => onOpenTask?.(task))}
          >
            <TaskRow task={task} />
          </CommandItem>
        ))}
      </CommandGroup>
    )
  }

  function renderRoot() {
    const createItem = onCreateTask ? (
      <CommandGroup heading='Create'>
        {typed ? (
          <CommandItem value='create' onSelect={() => done(() => onCreateTask(typed))}>
            <Plus className='text-muted-foreground' />
            <span className='shrink-0'>Create task</span>
            <span className='min-w-0 flex-1 truncate text-muted-foreground'>“{typed}”</span>
          </CommandItem>
        ) : (
          <CommandItem value='create' onSelect={() => go('create')}>
            <Plus className='text-muted-foreground' />
            <span className='min-w-0 flex-1 truncate'>Create a task…</span>
            <Hint id='create' platform={platform} />
          </CommandItem>
        )}
      </CommandGroup>
    ) : null

    if (!typed) {
      const byKey: Record<string, TaskCommandPaletteTask> = {}
      for (const task of tasks) byKey[task.key] = task
      const recent = recentKeys
        .map((key) => byKey[key])
        .filter((task): task is TaskCommandPaletteTask => !!task)
        .slice(0, RECENT_LIMIT)
      const sections: { key: string; node: ReactNode }[] = []
      if (currentTask && taskActions.length > 0) {
        sections.push({
          key: 'task',
          node: <CommandGroup heading={`On ${currentTask.key}`}>{renderActions(taskActions)}</CommandGroup>,
        })
      }
      if (recent.length > 0) sections.push({ key: 'recent', node: renderTasks('Recent', recent) })
      if (pageActions.length > 0) {
        sections.push({ key: 'go', node: <CommandGroup heading='Go to'>{renderActions(pageActions)}</CommandGroup> })
      }
      if (createItem) sections.push({ key: 'create', node: createItem })
      if (sections.length === 0) {
        return <p className='px-3 py-6 text-center text-sm text-muted-foreground'>Type to find a task.</p>
      }
      return sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 && <CommandSeparator />}
          {section.node}
        </Fragment>
      ))
    }

    const found = (filterTasks ? searchTasks(tasks, typed, recentKeys) : tasks).slice(0, RESULT_LIMIT)
    const actions = [...taskActions, ...pageActions].filter((entry) => matches(entry.label, words))
    const others = elsewhere.slice(0, RESULT_LIMIT)
    const nothing = found.length === 0 && others.length === 0 && actions.length === 0 && !createItem && !searching && !searchingElsewhere
    const otherGroup =
      others.length > 0 ? renderTasks(searchingElsewhere ? 'Other projects · searching…' : 'Other projects', others) : null

    if (nothing) {
      return (
        <p className='px-3 py-6 text-center text-sm text-muted-foreground [overflow-wrap:anywhere]'>
          Nothing matches “{typed}”.
        </p>
      )
    }

    return (
      <>
        {searching && found.length === 0 && (
          <p className='flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
            Searching…
          </p>
        )}
        {!searching && found.length === 0 && (
          <p className='px-3 pt-3 pb-1 text-sm text-muted-foreground [overflow-wrap:anywhere]'>
            {others.length > 0 || searchingElsewhere ? 'No task in this project matches' : 'No task matches'} “{typed}”.
          </p>
        )}
        {found.length === 0 && others.length === 0 && createItem}
        {found.length > 0 && renderTasks(searching ? 'Tasks · searching…' : 'Tasks', found)}
        {otherGroup}
        {searchingElsewhere && others.length === 0 && (
          <p className='flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
            Searching other projects…
          </p>
        )}
        {actions.length > 0 && <CommandGroup heading='Commands'>{renderActions(actions)}</CommandGroup>}
        {(found.length > 0 || others.length > 0) && createItem}
      </>
    )
  }

  function renderView() {
    if (current === 'create') {
      return (
        <CommandGroup>
          <CommandItem
            value='create'
            disabled={!typed || !onCreateTask}
            onSelect={() => done(() => onCreateTask?.(typed))}
          >
            <Plus className='text-muted-foreground' />
            {typed ? (
              <>
                <span className='shrink-0'>Create task</span>
                <span className='min-w-0 flex-1 truncate text-muted-foreground'>“{typed}”</span>
              </>
            ) : (
              <span className='min-w-0 flex-1 truncate'>Type a summary, then press Enter</span>
            )}
          </CommandItem>
        </CommandGroup>
      )
    }

    if (current === 'status') {
      const list = (statuses ?? []).filter((status) => matches(status.name, words))
      if (list.length === 0) return <NoMatch query={typed} />
      return (
        <CommandGroup>
          {list.map((status) => (
            <CommandItem
              key={status.id ?? status.name}
              value={`status:${status.id ?? status.name}`}
              data-checked={sameStatus(status, currentTask?.status)}
              onSelect={() => done(() => onChangeStatus?.(status))}
            >
              <TaskStatusBadge name={status.name} category={status.category} color={status.color} />
            </CommandItem>
          ))}
        </CommandGroup>
      )
    }

    if (current === 'assignee') {
      const list = (assignees ?? []).filter((assignee) => matches(assignee.name, words))
      const showUnassigned = matches('Unassigned', words)
      if (list.length === 0 && !showUnassigned) return <NoMatch query={typed} />
      return (
        <CommandGroup>
          {showUnassigned && (
            <CommandItem
              value='assignee:none'
              data-checked={!!currentTask && !currentTask.assignee}
              onSelect={() => done(() => onChangeAssignee?.(null))}
            >
              <TaskAssignee assignee={null} size='sm' />
              <span className='min-w-0 flex-1 truncate text-muted-foreground'>Unassigned</span>
            </CommandItem>
          )}
          {list.map((assignee) => (
            <CommandItem
              key={assignee.id ?? `${assignee.kind}:${assignee.name}`}
              value={`assignee:${assignee.id ?? `${assignee.kind}:${assignee.name}`}`}
              data-checked={sameAssignee(assignee, currentTask?.assignee)}
              onSelect={() => done(() => onChangeAssignee?.(assignee))}
            >
              <TaskAssignee assignee={assignee} size='sm' />
              <span className='min-w-0 flex-1 truncate'>{assignee.name}</span>
              {assignee.kind === 'agent' && <span className='shrink-0 text-xs text-muted-foreground'>Agent</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      )
    }

    if (current === 'priority') {
      const list = TASK_PRIORITIES.filter((priority) => matches(priority, words))
      if (list.length === 0) return <NoMatch query={typed} />
      return (
        <CommandGroup>
          {list.map((priority) => (
            <CommandItem
              key={priority}
              value={`priority:${priority}`}
              data-checked={currentTask?.priority === priority}
              onSelect={() => done(() => onChangePriority?.(priority))}
            >
              <TaskPriorityIcon priority={priority} withLabel />
            </CommandItem>
          ))}
        </CommandGroup>
      )
    }

    const list = (workflows ?? []).filter((workflow) => matches(workflow.name, words))
    if (list.length === 0) return <NoMatch query={typed} />
    return (
      <CommandGroup>
        {list.map((workflow) => (
          <CommandItem
            key={workflow.id}
            value={`workflow:${workflow.id}`}
            onSelect={() => done(() => onStartWorkflow?.(workflow))}
          >
            <Workflow className='text-muted-foreground' />
            <span className='min-w-0 flex-1 truncate'>{workflow.name}</span>
            {workflow.isDefault && <span className='shrink-0 text-xs text-muted-foreground'>Default</span>}
          </CommandItem>
        ))}
      </CommandGroup>
    )
  }

  return (
    <Command
      shouldFilter={false}
      loop
      label='Command palette'
      onKeyDown={onKeyDown}
      className={cn('@container h-auto shadow-lg ring-1 ring-foreground/10', className)}
    >
      {current !== 'root' && (
        <div className='flex min-w-0 items-center gap-1.5 px-1 pt-1 text-xs text-muted-foreground'>
          <button
            type='button'
            tabIndex={-1}
            aria-label='Back'
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => go('root')}
            className='inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground'
          >
            <ArrowLeft className='size-3.5' />
          </button>
          {currentTask && current !== 'create' && (
            <span className='shrink-0 font-mono'>{currentTask.key}</span>
          )}
          <span className='min-w-0 truncate font-medium text-foreground'>{VIEW_TITLE[current]}</span>
        </div>
      )}
      <CommandInput
        autoFocus
        value={query}
        onValueChange={changeQuery}
        placeholder={PLACEHOLDER[current]}
        aria-label={current === 'root' ? 'Search tasks and commands' : VIEW_TITLE[current]}
      />
      <ScrollArea className='max-h-[min(24rem,60vh)]' viewportClassName='scroll-py-1'>
        <CommandList className='max-h-none overflow-visible'>{current === 'root' ? renderRoot() : renderView()}</CommandList>
      </ScrollArea>
      <div className='mt-1 hidden items-center gap-3 border-t px-2 pt-2 pb-1 text-[11px] text-muted-foreground @sm:flex'>
        <span className='inline-flex items-center gap-1'>
          <ShortcutKeys keys={[['↑', '↓']]} platform={platform} />
          Move
        </span>
        <span className='inline-flex items-center gap-1'>
          <ShortcutKeys keys={[['Enter']]} platform={platform} />
          Select
        </span>
        <span className='inline-flex items-center gap-1'>
          <ShortcutKeys keys={[['Esc']]} platform={platform} />
          {current === 'root' ? 'Close' : 'Back'}
        </span>
      </div>
    </Command>
  )
}

function NoMatch({ query }: { query: string }) {
  return (
    <p className='px-3 py-6 text-center text-sm text-muted-foreground [overflow-wrap:anywhere]'>
      Nothing matches “{query}”.
    </p>
  )
}

export interface TaskCommandPaletteProps extends Omit<TaskCommandPalettePanelProps, 'view' | 'onViewChange' | 'onClose'> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The palette in a dialog. The host opens it (Ctrl/Cmd+K); Esc steps back out of an action, then closes. */
export function TaskCommandPalette({ open, onOpenChange, defaultView = 'root', className, ...panel }: TaskCommandPaletteProps) {
  const [view, setView] = useState<TaskCommandPaletteView>(defaultView)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setView(defaultView)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean, details?: { reason?: string; cancel?: () => void }) => {
        if (!next && details?.reason === 'escape-key' && view !== 'root') {
          details.cancel?.()
          setView('root')
          return
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className='top-[12vh] block translate-y-0 bg-transparent p-0 ring-0 sm:max-w-xl'
      >
        <DialogTitle className='sr-only'>Command palette</DialogTitle>
        <DialogDescription className='sr-only'>
          Find a task, run a command or go to a page.
        </DialogDescription>
        <TaskCommandPalettePanel
          {...panel}
          view={view}
          onViewChange={setView}
          onClose={() => onOpenChange(false)}
          className={className}
        />
      </DialogContent>
    </Dialog>
  )
}
