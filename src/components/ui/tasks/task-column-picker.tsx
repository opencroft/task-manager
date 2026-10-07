import { ChevronDown, Columns3 } from 'lucide-react'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { cn } from '@/lib/utils'

import { MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'
import { TASK_TABLE_COLUMNS, TASK_TABLE_HEADS, type TaskTableColumn } from './task-table'

export interface TaskColumnPickerProps {
  /** The columns shown, left to right. */
  columns: TaskTableColumn[]
  onColumnsChange: (columns: TaskTableColumn[]) => void
  /** Columns that cannot be hidden: shown ticked and disabled. */
  required?: readonly TaskTableColumn[]
  /** The host's default set. While the columns differ from it, the button is marked and the menu offers to reset to it. */
  defaultColumns?: readonly TaskTableColumn[]
  className?: string
}

/** `columns` with `column` added where it stands in the table's own order, relative to those shown. */
function withColumn(columns: TaskTableColumn[], column: TaskTableColumn): TaskTableColumn[] {
  const rank = TASK_TABLE_COLUMNS.indexOf(column)
  const at = columns.findIndex((shown) => TASK_TABLE_COLUMNS.indexOf(shown) > rank)
  return at < 0 ? [...columns, column] : [...columns.slice(0, at), column, ...columns.slice(at)]
}

/**
 * Which columns a task table shows, behind one Columns button for the App
 * toolbar. Every column is listed in the table's own order with a tick; the
 * menu stays open while columns are ticked on and off.
 */
export function TaskColumnPicker({ columns, onColumnsChange, required = [], defaultColumns, className }: TaskColumnPickerProps) {
  const changed = defaultColumns !== undefined && columns.join() !== defaultColumns.join()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant='ghost' size='sm' className={cn('shrink-0 gap-1.5', changed && 'bg-primary/5 text-foreground', className)} />}
      >
        <Columns3 />
        <span>Columns</span>
        <ChevronDown className='size-3.5 text-muted-foreground' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className={cn('w-auto min-w-48', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {TASK_TABLE_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={columns.includes(column)}
                disabled={required.includes(column)}
                onCheckedChange={(on) => onColumnsChange(on ? withColumn(columns, column) : columns.filter((shown) => shown !== column))}
              >
                {TASK_TABLE_HEADS[column].label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          {changed && defaultColumns ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onColumnsChange([...defaultColumns])}>Reset to default</DropdownMenuItem>
            </>
          ) : null}
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
