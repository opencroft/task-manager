import { cn } from '@/lib/utils'

export type TaskStatusCategory = 'todo' | 'in_progress' | 'done'

export interface TaskStatusBadgeProps {
  /** The status's name, as the project calls it. */
  name: string
  /** What kind of state it is; decides the colour when no colour is given. */
  category: TaskStatusCategory
  /** A hex colour the project chose for this status; overrides the category's. */
  color?: string | null
  size?: 'sm' | 'md'
  className?: string
}

const CATEGORY: Record<TaskStatusCategory, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
  done: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
}

const DOT: Record<TaskStatusCategory, string> = {
  todo: 'bg-muted-foreground/60',
  in_progress: 'bg-blue-500',
  done: 'bg-emerald-500',
}

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-5 px-1.5 text-[11px]',
  md: 'h-6 px-2 text-xs',
}

/**
 * A task's status as a small tinted chip: a dot and the status name. The tint
 * comes from the status category, so a project's own statuses still read at a
 * glance as not started, moving or finished.
 */
export function TaskStatusBadge({ name, category, color, size = 'md', className }: TaskStatusBadgeProps) {
  const custom = color && color.startsWith('#') ? color : null
  return (
    <span
      data-slot="task-status-badge"
      data-category={category}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        SIZE[size],
        custom ? 'text-foreground' : CATEGORY[category],
        className,
      )}
      style={custom ? { backgroundColor: `${custom}22` } : undefined}
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', custom ? null : DOT[category])}
        style={custom ? { backgroundColor: custom } : undefined}
      />
      <span className="truncate">{name}</span>
    </span>
  )
}
