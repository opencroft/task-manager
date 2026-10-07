import { ArrowRight, CalendarRange, Columns3, Inbox, ListTodo, Loader2, Plus, SearchX, Workflow } from 'lucide-react'
import type { ComponentType } from 'react'

import { Button } from '../button'
import { TaskInlineCreate } from '../tasks/task-inline-create'
import { cn } from '@/lib/utils'

export type TaskManagerEmptyKind = 'no-tasks' | 'no-results' | 'timeline-unscheduled' | 'backlog' | 'no-workflows' | 'no-boards'

export interface TaskManagerEmptyProps {
  kind: TaskManagerEmptyKind
  /** `no-tasks`: creates a task from the typed summary. The field is open and focused. */
  onCreateTask?: (summary: string) => Promise<unknown> | unknown
  /** `no-results`: clears the search and every filter. */
  onClearFilters?: () => void
  /** `no-workflows`: creates the Development, Review, QA workflow in one press. */
  onUseTemplate?: () => void
  /** `no-workflows`: opens an empty workflow to build by hand. */
  onCreateWorkflow?: () => void
  /** `no-boards`: opens the setup of a new board. */
  onCreateBoard?: () => void
  /** An action is in flight: its button spins and the others wait. */
  busy?: boolean
  /** `page` fills a page's empty body; `compact` sits inside a pane or a table. Each kind has its natural size. */
  size?: 'page' | 'compact'
  className?: string
}

interface Copy {
  icon: ComponentType<{ className?: string }>
  title: string
  text: string
  size: 'page' | 'compact'
}

const COPY: Record<TaskManagerEmptyKind, Copy> = {
  'no-tasks': {
    icon: ListTodo,
    title: 'Create your first task',
    text: 'Type what needs doing and press Enter. Details, dates and an assignee can come later; the board, the timeline and workflows all start from here.',
    size: 'page',
  },
  'no-results': {
    icon: SearchX,
    title: 'No tasks match',
    text: 'Nothing fits this search and these filters. Try other words, or clear them to see every task.',
    size: 'compact',
  },
  'timeline-unscheduled': {
    icon: CalendarRange,
    title: 'Nothing on the timeline yet',
    text: 'Drag a task from the backlog, or draw on a row across the days it should take.',
    size: 'compact',
  },
  backlog: {
    icon: Inbox,
    title: 'The backlog is empty',
    text: 'Every task has dates. New tasks without dates wait here until you schedule them.',
    size: 'compact',
  },
  'no-workflows': {
    icon: Workflow,
    title: 'Create a workflow',
    text: 'A workflow takes a task through steps worked by agents. Each step opens a chat session for its agent when the task reaches that step’s status.',
    size: 'page',
  },
  'no-boards': {
    icon: Columns3,
    title: 'Set up a board',
    text: 'A board shows tasks in columns of the statuses you choose, a section per status, and can keep to a filter. Nothing appears here until one is set up.',
    size: 'page',
  },
}

const TEMPLATE = ['Development', 'Review', 'QA']

/**
 * What a page or pane shows when it has nothing to show, pointing at the one
 * action that fills it. An empty project is the first screen a new user sees,
 * so each state leads somewhere rather than leaving a blank grid.
 */
export function TaskManagerEmpty({
  kind,
  onCreateTask,
  onClearFilters,
  onUseTemplate,
  onCreateWorkflow,
  onCreateBoard,
  busy = false,
  size,
  className,
}: TaskManagerEmptyProps) {
  const copy = COPY[kind]
  const Icon = copy.icon
  const page = (size ?? copy.size) === 'page'

  return (
    <div
      data-slot='task-manager-empty'
      data-kind={kind}
      className={cn(
        'mx-auto flex w-full flex-col items-center text-center',
        page ? 'max-w-md gap-4 px-4 py-12' : 'max-w-sm gap-3 px-3 py-6',
        className,
      )}
    >
      <span
        aria-hidden='true'
        className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground', page ? 'size-12' : 'size-9')}
      >
        <Icon className={page ? 'size-6' : 'size-4.5'} />
      </span>
      <div className='flex flex-col gap-1.5'>
        <h2 className={cn('font-semibold text-foreground', page ? 'text-lg' : 'text-sm')}>{copy.title}</h2>
        <p className='text-sm text-pretty text-muted-foreground'>{copy.text}</p>
      </div>

      {kind === 'no-tasks' && onCreateTask ? (
        <div className='w-full max-w-sm text-left'>
          <TaskInlineCreate onCreate={onCreateTask} defaultOpen placeholder='e.g. Draft the release notes' />
        </div>
      ) : null}

      {kind === 'no-results' && onClearFilters ? (
        <Button variant='outline' size='sm' onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}

      {kind === 'no-boards' && onCreateBoard ? (
        <Button onClick={onCreateBoard}>
          <Plus />
          Create board
        </Button>
      ) : null}

      {kind === 'no-workflows' ? (
        <div className='flex w-full flex-col items-center gap-3'>
          <ol aria-label='Template steps' className='flex flex-wrap items-center justify-center gap-1.5 text-xs'>
            {TEMPLATE.map((step, index) => (
              <li key={step} className='flex items-center gap-1.5'>
                {index > 0 ? <ArrowRight aria-hidden='true' className='size-3.5 text-muted-foreground' /> : null}
                <span className='rounded-md border bg-card px-2 py-1 font-medium'>{step}</span>
              </li>
            ))}
          </ol>
          <div className='flex flex-wrap items-center justify-center gap-2'>
            {onUseTemplate ? (
              <Button onClick={onUseTemplate} disabled={busy}>
                {busy ? <Loader2 className='animate-spin' /> : null}
                Use this template
              </Button>
            ) : null}
            {onCreateWorkflow ? (
              <Button variant='outline' onClick={onCreateWorkflow} disabled={busy}>
                Start from scratch
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
