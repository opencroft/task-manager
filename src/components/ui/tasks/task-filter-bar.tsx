import { Check, ChevronDown, ListFilter, Minus, Search, X } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  /**
   * A search field above the options, focused when the menu opens: typing
   * narrows them to the options whose label holds the text. For a long list.
   */
  searchable?: boolean
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
   * `wrap` (the default): a block above the list with a menu per filter,
   * wrapping onto more lines, the search full width on a phone. `fill`: for
   * a TaskManagerToolbar, or any wrapping flex row: the bar draws no box of
   * its own, so its parts join the row beside the page's other controls.
   * Filters that are not set fold into one Filter menu (a submenu each) and
   * a filter that is set shows as its own menu, so the row stays short. The
   * menus come before the search, which grows into the width the others
   * leave: a change further along the row (the count's width) resizes the
   * search and never moves an open menu. `className` does nothing then.
   */
  layout?: 'wrap' | 'fill'
  className?: string
}

/** The first of `values` by its option's label, and how many more. */
function summary(filter: TaskFilterDef, values: string[]): string {
  const first = filter.options.find((o) => o.value === values[0])?.label ?? values[0]
  return values.length > 1 ? `${first} +${values.length - 1}` : (first ?? '')
}

interface FilterProps {
  filter: TaskFilterDef
  selection: TaskFilterSelection
  onChange: (selection: Required<TaskFilterSelection>) => void
}

function isSet(selection: TaskFilterSelection | undefined): boolean {
  return (selection?.include?.length ?? 0) + (selection?.exclude?.length ?? 0) > 0
}

const SEARCH_INPUT =
  'h-8 w-full rounded-md border border-input bg-transparent pr-2 pl-8 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

/** Keys the menu acts on from its search: the arrows move into the options, Escape closes, Tab leaves. The rest stay in the field, so typing never jumps to an option or closes a submenu. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Escape', 'Tab'])

/**
 * A ref for a field that takes the focus when its menu opens. The menu puts
 * its own opening focus (the popup, or the first option when opened from the
 * keyboard) one frame after it mounts, so the field takes it a frame later.
 */
function useFocusOnOpen() {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [])
  return ref
}

/** A filter's search, kept in view above its options while they scroll. */
function OptionSearch({ label, query, onQueryChange }: { label: string; query: string; onQueryChange: (query: string) => void }) {
  const ref = useFocusOnOpen()
  return (
    <label className="sticky top-0 z-10 flex h-10 items-center bg-popover py-1">
      <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
      <input
        ref={ref}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (!MENU_KEYS.has(event.key)) {
            event.stopPropagation()
          }
        }}
        placeholder={`Search ${label.toLowerCase()}`}
        aria-label={`Search ${label.toLowerCase()}`}
        className={SEARCH_INPUT}
      />
    </label>
  )
}

/**
 * One filter's values, each cycling off, included and excluded, then a clear
 * for the filter while it is set. A searchable filter shows only the values
 * whose label holds what is typed.
 */
function FilterOptions({ filter, selection, onChange }: FilterProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const options = needle ? filter.options.filter((option) => option.label.toLowerCase().includes(needle)) : filter.options
  return (
    <MenuScrollArea>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
        {filter.options.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{filter.emptyText ?? 'Nothing to filter by yet'}</div>
        ) : (
          <>
            {filter.searchable ? <OptionSearch label={filter.label} query={query} onQueryChange={setQuery} /> : null}
            <div className="px-2 pb-1 text-xs text-muted-foreground">Click to include, again to exclude</div>
            {options.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No {filter.label.toLowerCase()} matches</div> : null}
            {options.map((option) => {
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
      {isSet(selection) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({ include: [], exclude: [] })}>Clear {filter.label.toLowerCase()}</DropdownMenuItem>
        </>
      ) : null}
    </MenuScrollArea>
  )
}

// Capped at the screen's width so a long value (a person's full name) truncates on a phone rather than widening the menu past the edge.
const OPTIONS_POPUP = cn('max-h-80 w-auto max-w-[calc(100vw-1rem)] min-w-52', MENU_SCROLL_POPUP)

/** A filter as its own menu; the trigger shows the first included value and how many more, then the excluded ones struck through. */
function FilterMenu({ onOpenChange, ...props }: FilterProps & { onOpenChange?: (open: boolean) => void }) {
  const { filter, selection } = props
  const included = selection.include ?? []
  const excluded = selection.exclude ?? []
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn('shrink-0 gap-1.5 font-normal', isSet(selection) && 'border-primary/40 bg-primary/5 text-foreground')}
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
      <DropdownMenuContent className={OPTIONS_POPUP}>
        <FilterOptions {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Every filter behind one button, a submenu each; a filter's submenu trigger counts its picks. */
function FilterPicker({
  filters,
  values,
  onValuesChange,
  onOpenChange,
}: Pick<TaskFilterBarProps, 'filters' | 'values' | 'onValuesChange'> & { onOpenChange: (open: boolean) => void }) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="shrink-0 gap-1.5 font-normal" />}>
        <ListFilter className="text-muted-foreground" />
        Filter
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Filter by</DropdownMenuLabel>
          {filters.map((filter) => {
            const selection = values[filter.id] ?? {}
            const picks = (selection.include?.length ?? 0) + (selection.exclude?.length ?? 0)
            return (
              <DropdownMenuSub key={filter.id}>
                <DropdownMenuSubTrigger>
                  {filter.label}
                  {picks > 0 ? <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{picks}</span> : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={OPTIONS_POPUP}>
                  <FilterOptions filter={filter} selection={selection} onChange={(next) => onValuesChange(filter.id, next)} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the row shows besides the search: the filters drawn as their own menus, and whether Clear is there. */
interface RowParts {
  shown: string[]
  clear: boolean
}

/**
 * The search and filter row above a task list: a search field, then the
 * filters, whose values each cycle off, included and excluded, then a
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
  const fill = layout === 'fill'
  const live: RowParts = {
    shown: filters.filter((filter) => !fill || isSet(values[filter.id])).map((filter) => filter.id),
    clear: query.trim() !== '' || Object.values(values).some(isSet),
  }
  // While one of the bar's menus is open the row keeps the parts it had when
  // it opened, so a filter set or cleared in the menu does not add or remove
  // a button under it, moving the menu or closing it; the row catches up when
  // the menu closes.
  const [held, setHeld] = useState<RowParts | null>(null)
  const parts = held ?? live
  const hold = (open: boolean) => setHeld(open ? live : null)
  const search = (
    <label className={cn('relative flex h-8 items-center', fill ? 'min-w-40 flex-1' : 'w-full min-w-40 sm:w-64')}>
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
        className={SEARCH_INPUT}
      />
    </label>
  )
  return (
    <div
      data-slot="task-filter-bar"
      data-layout={layout}
      className={cn(fill ? 'contents' : 'flex flex-wrap items-center gap-2', !fill && className)}
    >
      {fill ? null : search}
      {fill && filters.length > 0 ? <FilterPicker filters={filters} values={values} onValuesChange={onValuesChange} onOpenChange={hold} /> : null}
      {filters
        .filter((filter) => parts.shown.includes(filter.id))
        .map((filter) => (
          <FilterMenu
            key={filter.id}
            filter={filter}
            selection={values[filter.id] ?? {}}
            onChange={(next) => onValuesChange(filter.id, next)}
            onOpenChange={fill ? hold : undefined}
          />
        ))}
      {fill ? search : null}
      {parts.clear && onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0 text-muted-foreground">
          <X />
          Clear
        </Button>
      ) : null}
      {children ? <div className={cn('flex shrink-0 items-center gap-2', !fill && 'ml-auto')}>{children}</div> : null}
    </div>
  )
}
