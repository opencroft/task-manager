import { Check, ChevronDown, Flag, Plus } from 'lucide-react'

import { Button } from '../button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../dropdown-menu'
import { MENU_SCROLL_POPUP, MenuScrollArea } from '@/components/ui/tasks/item-menu'
import { milestoneSpanText, type TaskMilestone } from '@/components/ui/tasks/task-milestone-chip'
import { cn } from '@/lib/utils'

export interface TimelineMilestonePickerProps {
  /** The milestones to offer, in the order to list them: the host passes the open ones. */
  milestones: readonly TaskMilestone[]
  /** The milestone shown now. */
  activeId: string | null
  onSelect: (id: string) => void
  /** "New milestone…": the host opens its create dialog. */
  onCreate: () => void
  className?: string
}

function countsText(milestone: TaskMilestone): string {
  return `${milestone.openCount ?? 0} open · ${milestone.doneCount ?? 0} done`
}

/**
 * Which milestone the timeline shows, first in the row of controls above it:
 * a button with a flag, the milestone's name and a chevron, opening the list
 * of milestones (each with its span and open count, the shown one checked)
 * and New milestone…. Beside the button, quietly, the shown milestone's span
 * and its open and done counts.
 */
export function TimelineMilestonePicker({ milestones, activeId, onSelect, onCreate, className }: TimelineMilestonePickerProps) {
  const active = milestones.find((milestone) => milestone.id === activeId) ?? null
  const summary = active ? [milestoneSpanText(active), countsText(active)].filter(Boolean).join(' · ') : null
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant='ghost' size='sm' aria-label={`Milestone: ${active?.name ?? 'none'}`} className='max-w-56 min-w-0 gap-1.5' />}
        >
          <Flag className='text-muted-foreground' />
          <span className='min-w-0 truncate'>{active?.name ?? 'Milestones'}</span>
          <ChevronDown className='text-muted-foreground' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className={cn('max-h-80 w-auto min-w-64', MENU_SCROLL_POPUP)}>
          <MenuScrollArea>
            {milestones.map((milestone) => {
              const span = milestoneSpanText(milestone)
              return (
                <DropdownMenuItem key={milestone.id} onClick={() => onSelect(milestone.id)}>
                  <span className='flex min-w-0 flex-1 flex-col'>
                    <span className='truncate'>{milestone.name}</span>
                    <span className='truncate text-xs text-muted-foreground'>
                      {[span, `${milestone.openCount ?? 0} open`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Check className={cn('ml-auto size-4', milestone.id === activeId ? 'opacity-100' : 'opacity-0')} />
                </DropdownMenuItem>
              )
            })}
            {milestones.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onClick={onCreate}>
              <Plus />
              New milestone…
            </DropdownMenuItem>
          </MenuScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
      {summary ? <span className='min-w-0 truncate text-xs text-muted-foreground tabular-nums'>{summary}</span> : null}
    </div>
  )
}
