import type { ReactNode } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

export interface TaskManagerToolbarProps {
  /** Names the row for assistive tech, e.g. "Board controls". */
  label: string
  /** The controls, in order. Each keeps its own width; what does not fit scrolls sideways. */
  children: ReactNode
  /** Pinned at the right and never scrolled away: a count, or the control that must stay in reach. */
  end?: ReactNode
  className?: string
}

/**
 * A page's controls as one compact row (h-10), for the App toolbar under the
 * title bar. It never wraps: on a narrow screen the controls scroll sideways
 * with the kit's bar, and `end` stays put at the right.
 */
export function TaskManagerToolbar({ label, children, end, className }: TaskManagerToolbarProps) {
  return (
    <div role='toolbar' aria-label={label} data-slot='task-manager-toolbar' className={cn('flex h-10 w-full min-w-0 items-center gap-1', className)}>
      <ScrollArea scrollbars='horizontal' className='h-full min-w-0 flex-1' innerClassName='h-full flex-row items-center gap-1 px-2 [&>*]:shrink-0'>
        {children}
      </ScrollArea>
      {end ? <div className='flex h-full shrink-0 items-center gap-1 pr-2'>{end}</div> : null}
    </div>
  )
}
