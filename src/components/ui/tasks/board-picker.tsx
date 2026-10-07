import { Check, ChevronDown, Columns3, Pencil, Plus, Trash2 } from 'lucide-react'

import { Button } from '../button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../dropdown-menu'
import { cn } from '@/lib/utils'

import { MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'

export interface BoardPickerBoard {
  id: string
  name: string
}

export interface BoardPickerProps {
  /** The project's boards, in the order to list them. */
  boards: BoardPickerBoard[]
  /** The board shown now. */
  activeId: string | null
  onSelect: (id: string) => void
  /** Opens the setup of a new board. */
  onCreate: () => void
  /** Opens the shown board's setup. */
  onEdit?: () => void
  /** Deletes the shown board. Its handler confirms first. */
  onDelete?: () => void
  className?: string
}

/**
 * The board the page shows, and the way to the others: the list of the
 * project's boards, then creating one, and the shown board's setup and
 * deletion.
 */
export function BoardPicker({ boards, activeId, onSelect, onCreate, onEdit, onDelete, className }: BoardPickerProps) {
  const active = boards.find((board) => board.id === activeId) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant='ghost' size='sm' aria-label={`Board: ${active?.name ?? 'none'}`} className={cn('max-w-56 min-w-0 gap-1.5', className)} />}
      >
        <Columns3 className='text-muted-foreground' />
        <span className='min-w-0 truncate'>{active?.name ?? 'Boards'}</span>
        <ChevronDown className='text-muted-foreground' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className={cn('max-h-80 w-auto min-w-56', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          {boards.map((board) => (
            <DropdownMenuItem key={board.id} onClick={() => onSelect(board.id)}>
              <span className='min-w-0 flex-1 truncate'>{board.name}</span>
              <Check className={cn('ml-auto size-4', board.id === activeId ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          ))}
          {boards.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={onCreate}>
            <Plus />
            New board
          </DropdownMenuItem>
          {active && onEdit ? (
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              Edit board
            </DropdownMenuItem>
          ) : null}
          {active && onDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant='destructive' onClick={onDelete}>
                <Trash2 />
                Delete board…
              </DropdownMenuItem>
            </>
          ) : null}
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
