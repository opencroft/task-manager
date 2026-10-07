import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Equal } from 'lucide-react'

import { cn } from '@/lib/utils'

export type TaskPriority = 'lowest' | 'low' | 'medium' | 'high' | 'highest'

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  lowest: 'Lowest',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  highest: 'Highest',
}

/** Highest first — the order a picker lists them in. */
export const TASK_PRIORITIES: TaskPriority[] = ['highest', 'high', 'medium', 'low', 'lowest']

const ICON = { highest: ChevronsUp, high: ChevronUp, medium: Equal, low: ChevronDown, lowest: ChevronsDown }

const TONE: Record<TaskPriority, string> = {
  highest: 'text-red-600 dark:text-red-400',
  high: 'text-orange-500 dark:text-orange-400',
  medium: 'text-amber-500 dark:text-amber-400',
  low: 'text-sky-500 dark:text-sky-400',
  lowest: 'text-sky-400 dark:text-sky-300',
}

export interface TaskPriorityIconProps {
  priority: TaskPriority
  /** Show the priority's name beside the glyph. */
  withLabel?: boolean
  className?: string
}

/** A task's priority as a coloured chevron glyph, optionally with its name. */
export function TaskPriorityIcon({ priority, withLabel = false, className }: TaskPriorityIconProps) {
  const Icon = ICON[priority]
  return (
    <span
      data-slot="task-priority"
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm', className)}
      title={withLabel ? undefined : `${TASK_PRIORITY_LABELS[priority]} priority`}
    >
      <Icon aria-hidden className={cn('size-4 shrink-0', TONE[priority])} strokeWidth={2.5} />
      {withLabel ? <span>{TASK_PRIORITY_LABELS[priority]}</span> : <span className="sr-only">{TASK_PRIORITY_LABELS[priority]}</span>}
    </span>
  )
}
