import { cn } from '@/lib/utils'

/** The project a task belongs to, on a list that mixes projects. */
export interface TaskProject {
  /** The project key, the prefix of its task keys. */
  key: string
  name: string
  /** Where the project lives, for opening its tasks; not shown. */
  app?: string
}

export interface TaskProjectChipProps {
  /** Nothing is drawn without one, so a row can always include the chip. */
  project?: TaskProject | null
  className?: string
}

/** Names a task's project on a row that lists tasks from several projects. */
export function TaskProjectChip({ project, className }: TaskProjectChipProps) {
  if (!project) {
    return null
  }
  // The size and outline of a version or label chip.
  return (
    <span
      data-slot='task-project-chip'
      title={`In ${project.name} (${project.key})`}
      className={cn('inline-flex h-5 min-w-0 max-w-28 shrink-0 items-center rounded-md border px-1.5 text-[11px] text-muted-foreground', className)}
    >
      <span className='truncate'>{project.name}</span>
    </span>
  )
}
