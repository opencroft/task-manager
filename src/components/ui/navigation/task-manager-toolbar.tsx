import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface TaskManagerToolbarProps {
  /** Names the row for assistive tech, e.g. "Board controls". */
  label: string
  /** The controls, in order. A control that should take the free width grows itself (`flex-1`). */
  children: ReactNode
  /** Closes the row at the right: a count, or the control that must stay in reach. */
  end?: ReactNode
  className?: string
}

/**
 * A page's controls as one row in the page, above its content: Tasks above
 * the table, Board above the board. When the row is too narrow the controls
 * wrap onto more lines, so nothing is cut off; `end` stays last, at the right.
 */
export function TaskManagerToolbar({ label, children, end, className }: TaskManagerToolbarProps) {
  return (
    <div role='toolbar' aria-label={label} data-slot='task-manager-toolbar' className={cn('flex w-full min-w-0 flex-wrap items-center gap-2', className)}>
      {children}
      {end ? <div className='ml-auto flex shrink-0 items-center gap-2'>{end}</div> : null}
    </div>
  )
}
