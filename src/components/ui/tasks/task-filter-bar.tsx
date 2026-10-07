import { Check, ChevronDown, Minus, Search, X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { MENU_SCROLL_POPUP, MenuScrollArea } from '@/components/ui/tasks/item-menu'
import { cn } from '@/lib/utils'

export interface TaskFilterOption {
  value: string
  label: string
  /** Drawn before the label (a status badge, a priority glyph). */
  icon?: ReactNode
}

export interface TaskFilterDef {
  id: string
  label: string
  options: TaskFilterOption[]
  /** Shown when there is nothing to pick from. */
  emptyText?: string
}

/**
 * One filter's picks: a task must have one of `include` (when it has any) and
 * none of `exclude`. A value is in at most one of the two.
 */
export interface TaskFilterSelection {
  include?: string[]
  exclude?: string[]
}

/** Where one value of a filter stands; a press moves it to the next. */
export type TaskFilterState = 'off' | 'include' | 'exclude'

const NEXT_STATE: Record<TaskFilterState, TaskFilterState> = { off: 'include', include: 'exclude', exclude: 'off' }

/** What a screen reader hears after the option's label. */
const STATE_TEXT: Record<TaskFilterState, string> = { off: 'off', include: 'included', exclude: 'excluded' }

function stateOf(selection: TaskFilterSelection, value: string): TaskFilterState {
  if (selection.exclude?.includes(value)) {
    return 'exclude'
  }
  return selection.include?.includes(value) ? 'include' : 'off'
}

/** `selection` with `value` moved to `state`. */
function withState(selection: TaskFilterSelection, value: string, state: TaskFilterState): Required<TaskFilterSelection> {
  const include = (selection.include ?? []).filter((v) => v !== value)
  const exclude = (selection.exclude ?? []).filter((v) => v !== value)
  return {
    include: state === 'include' ? [...include, value] : include,
    exclude: state === 'exclude' ? [...exclude, value] : exclude,
  }
}

export interface TaskFilterBarProps {
  query: string
  onQueryChange: (query: string) => void
  filters: TaskFilterDef[]
  /** Picks per filter id. */
  values: Record<string, TaskFilterSelection | undefined>
  /** A filter's new picks, with both lists present (empty when nothing is picked). */
  onValuesChange: (id: string, selection: Required<TaskFilterSelection>) => void
  onClear?: () => void
  searchPlaceholder?: string
  /** The search field, for a host that focuses it (e.g. from a shortcut). */
  searchRef?: Ref<HTMLInputElement>
  /** Trailing content, e.g. a result count or a view switch. */
  children?: ReactNode
  /**
   * `wrap` (the default): a block above the list that wraps onto more lines,
   * the search full width on a phone. `row`: one line that never wraps, for
   * a TaskManagerToolbar in the App toolbar, which scrolls it sideways when
   * it does not fit.
   */
  layout?: 'wrap' | 'row'
  className?: string
}

/** The first of `values` by its option's label, and how many more. */
function summary(filter: TaskFilterDef, values: string[]): string {
  const first = filter.options.find((o) => o.value === values[0])?.label ?? values[0]
  return values.length > 1 ? `${first} +${values.length - 1}` : (first ?? '')
}

function FilterMenu({
  filter,
  selection,
  onChange,
}: {
  filter: TaskFilterDef
  selection: TaskFilterSelection
  onChange: (selection: Required<TaskFilterSelection>) => void
}) {
  const included = selection.include ?? []
  const excluded = selection.exclude ?? []
  const active = included.length > 0 || excluded.length > 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn('shrink-0 gap-1.5 font-normal', active && 'border-primary/40 bg-primary/5 text-foreground')}
          />
        }
      >
        <span className="text-muted-foreground">{filter.label}</span>
        {included.length > 0 ? <span className="max-w-32 truncate font-medium">{summary(filter, included)}</span> : null}
        {excluded.length > 0 ? (
          <span className="max-w-32 truncate font-medium text-muted-foreground line-through decoration-destructive">
            <span className="sr-only">not </span>
            {summary(filter, excluded)}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn('max-h-80 w-auto min-w-52', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
            {filter.options.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">{filter.emptyText ?? 'Nothing to filter by yet'}</div>
            ) : (
              <>
                <div className="px-2 pb-1 text-xs text-muted-foreground">Click to include, again to exclude</div>
                {filter.options.map((option) => {
                  const state = stateOf(selection, option.value)
                  return (
                    <DropdownMenuItem
                      key={option.value}
                      data-state={state}
                      closeOnClick={false}
                      className="pr-8"
                      onClick={() => onChange(withState(selection, option.value, NEXT_STATE[state]))}
                    >
                      <span className="pointer-events-none absolute right-2 flex items-center justify-center" aria-hidden>
                        {state === 'include' ? <Check /> : state === 'exclude' ? <Minus className="text-destructive" /> : null}
                      </span>
                      <span className={cn('flex min-w-0 items-center gap-2', state === 'exclude' && 'line-through opacity-60')}>
                        {option.icon ?? null}
                        <span className="truncate">{option.icon ? null : option.label}</span>
                      </span>
                      <span className="sr-only">, {STATE_TEXT[state]}</span>
                    </DropdownMenuItem>
                  )
                })}
              </>
            )}
          </DropdownMenuGroup>
          {active ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onChange({ include: [], exclude: [] })}>Clear {filter.label.toLowerCase()}</DropdownMenuItem>
            </>
          ) : null}
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The search and filter row above a task list: a search field, then one menu
 * per filter whose values each cycle off, included and excluded, then a
 * clear-all while anything is set. Controlled — the host owns the values,
 * usually in the URL.
 */
export function TaskFilterBar({
  query,
  onQueryChange,
  filters,
  values,
  onValuesChange,
  onClear,
  searchPlaceholder = 'Search tasks',
  searchRef,
  children,
  layout = 'wrap',
  className,
}: TaskFilterBarProps) {
  const anyActive =
    query.trim() !== '' || Object.values(values).some((selection) => (selection?.include?.length ?? 0) + (selection?.exclude?.length ?? 0) > 0)
  const row = layout === 'row'
  return (
    <div
      data-slot="task-filter-bar"
      data-layout={layout}
      className={cn(row ? 'flex shrink-0 items-center gap-1.5' : 'flex flex-wrap items-center gap-2', className)}
    >
      <label className={cn('relative flex h-8 items-center', row ? 'w-40 shrink-0 sm:w-56' : 'w-full min-w-40 sm:w-64')}>
        <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              onQueryChange('')
            }
          }}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-8 w-full rounded-md border border-input bg-transparent pr-2 pl-8 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
      </label>
      {filters.map((filter) => (
        <FilterMenu
          key={filter.id}
          filter={filter}
          selection={values[filter.id] ?? {}}
          onChange={(next) => onValuesChange(filter.id, next)}
        />
      ))}
      {anyActive && onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0 text-muted-foreground">
          <X />
          Clear
        </Button>
      ) : null}
      {children ? <div className={cn('flex shrink-0 items-center gap-2', !row && 'ml-auto')}>{children}</div> : null}
    </div>
  )
}
