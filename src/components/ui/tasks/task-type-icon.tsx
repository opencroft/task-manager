import { Bookmark, Bug, CircleCheck, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'

export type TaskType = 'task' | 'bug' | 'story' | 'epic'

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  task: 'Task',
  bug: 'Bug',
  story: 'Story',
  epic: 'Epic',
}

export const TASK_TYPES: TaskType[] = ['task', 'bug', 'story', 'epic']

const ICON = { task: CircleCheck, bug: Bug, story: Bookmark, epic: Zap }

const TONE: Record<TaskType, string> = {
  task: 'bg-sky-600 text-white',
  bug: 'bg-red-600 text-white',
  story: 'bg-emerald-600 text-white',
  epic: 'bg-violet-600 text-white',
}

export interface TaskTypeIconProps {
  type: TaskType
  /** Show the type's name beside the glyph. */
  withLabel?: boolean
  className?: string
}

/** A task's type as a small filled square glyph, optionally with its name. */
export function TaskTypeIcon({ type, withLabel = false, className }: TaskTypeIconProps) {
  const Icon = ICON[type]
  return (
    <span
      data-slot="task-type"
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm', className)}
      title={withLabel ? undefined : TASK_TYPE_LABELS[type]}
    >
      <span aria-hidden className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]', TONE[type])}>
        <Icon className="size-3" strokeWidth={2.5} />
      </span>
      {withLabel ? <span>{TASK_TYPE_LABELS[type]}</span> : <span className="sr-only">{TASK_TYPE_LABELS[type]}</span>}
    </span>
  )
}
