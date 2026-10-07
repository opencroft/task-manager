import { ChevronDown, Rows3, SlidersHorizontal, SquareKanban } from 'lucide-react'
import type { ComponentType } from 'react'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { cn } from '@/lib/utils'

import { MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'

export interface BoardDisplayOption {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
  /** Why it cannot be chosen right now (e.g. "Not on a phone"); shown under it, disabled. */
  unavailable?: string | null
}

/** One row of columns, or a swimlane per assignee: what the Board offers today. The first is the default. */
export const BOARD_SWIMLANE_OPTIONS: BoardDisplayOption[] = [
  { id: 'none', label: 'One row of columns', icon: SquareKanban },
  { id: 'assignee', label: 'A swimlane per assignee', icon: Rows3 },
]

export interface BoardDisplayMenuProps {
  /** The swimlane choice shown, an option's id. */
  swimlanes: string
  onSwimlanesChange: (id: string) => void
  /** The choices, the default first. */
  options?: BoardDisplayOption[]
  className?: string
}

/**
 * The Board's display settings behind one Display button, for the App
 * toolbar. The button names the choice while it is not the default, so a
 * changed layout is visible without opening the menu.
 */
export function BoardDisplayMenu({ swimlanes, onSwimlanesChange, options = BOARD_SWIMLANE_OPTIONS, className }: BoardDisplayMenuProps) {
  const current = options.find((option) => option.id === swimlanes)
  const changed = current !== undefined && current !== options[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant='ghost'
            size='sm'
            aria-label={`Display${current ? `: ${current.label}` : ''}`}
            className={cn('max-w-64 shrink-0 gap-1.5', changed && 'bg-primary/5 text-foreground', className)}
          />
        }
      >
        <SlidersHorizontal />
        <span>Display</span>
        {changed ? <span className='min-w-0 truncate text-muted-foreground'>{current.label}</span> : null}
        <ChevronDown className='size-3.5 text-muted-foreground' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className={cn('w-auto min-w-56', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={swimlanes} onValueChange={(value) => onSwimlanesChange(String(value))}>
              {options.map((option) => {
                const Icon = option.icon
                return (
                  <DropdownMenuRadioItem key={option.id} value={option.id} disabled={Boolean(option.unavailable)}>
                    {Icon ? <Icon /> : null}
                    <span className='flex min-w-0 flex-col'>
                      <span className='truncate'>{option.label}</span>
                      {option.unavailable ? <span className='text-xs text-muted-foreground'>{option.unavailable}</span> : null}
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
