import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { cn } from '@/lib/utils'

import { ItemContextMenu, MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'

export interface TaskFieldPickerOption<V extends string> {
  value: V
  /** How the option looks in the list (and on the trigger when chosen). */
  display: ReactNode
  /** Plain text for type-ahead and screen readers. */
  text: string
}

export interface TaskFieldPickerProps<V extends string> {
  value: V | null
  options: TaskFieldPickerOption<V>[]
  onChange: (value: V) => void
  /** Drawn on the trigger when nothing is chosen. */
  placeholder?: ReactNode
  /** Names the menu, e.g. "Status". */
  label: string
  className?: string
}

/**
 * One field's value as a quiet trigger that opens a list of the choices, the
 * current one checked. Used for status, priority, type and assignee on a
 * task's page, so each reads as its value and changes in two presses. A
 * right-click, long press or Shift+F10 offers the same choices as a context
 * menu, as every other field chip does.
 */
export function TaskFieldPicker<V extends string>({ value, options, onChange, placeholder = 'None', label, className }: TaskFieldPickerProps<V>) {
  const current = options.find((option) => option.value === value)
  const entries = options.map((option) => ({
    id: option.value,
    label: <span className="flex min-w-0 flex-1 items-center">{option.display}</span>,
    checked: option.value === value,
    group: 'change' as const,
    onSelect: () => onChange(option.value),
  }))
  return (
    <ItemContextMenu entries={entries} focusable={false} className="min-w-0">
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label}: ${current?.text ?? 'none'}`}
        className={cn(
          'group/picker -mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:bg-muted/70',
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center">{current ? current.display : <span className="text-muted-foreground">{placeholder}</span>}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/picker:opacity-100 group-data-popup-open/picker:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn('max-h-80 w-auto min-w-52', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {options.map((option) => (
              <DropdownMenuItem key={option.value} onClick={() => onChange(option.value)} aria-label={option.text}>
                <span className="flex min-w-0 flex-1 items-center">{option.display}</span>
                <Check className={cn('size-4', option.value === value ? 'opacity-100' : 'opacity-0')} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
    </ItemContextMenu>
  )
}
