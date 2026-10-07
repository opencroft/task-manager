import { ListPlus } from 'lucide-react'
import { Children, type ComponentProps, type ReactNode, useState } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskInlineCreate } from './task-inline-create'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'

/** A status as the status list returns it. */
export interface BoardColumnStatus {
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface BoardColumnProps extends Omit<ComponentProps<'section'>, 'title'> {
  /** The column's own name, shown in its header. */
  title?: string
  /** Shown as its badge in the header when the column has no `title`: a column named after its one status. */
  status?: BoardColumnStatus
  /** Tasks in this column, as the header shows it. */
  count: number
  /** A dragged card is over this column. */
  dropTarget?: boolean
  /** Creates a task in this column from a typed summary. Without it, the column has no create field. */
  onCreate?: (summary: string) => Promise<unknown> | unknown
  /** Open the create field immediately, e.g. after a "new task here" command. */
  defaultCreateOpen?: boolean
  /** Shown in an empty column. */
  emptyLabel?: string
  /** Controls placed in the header before the column's … button. */
  headerActions?: ReactNode
  /**
   * More entries for the column's menu (right-click or long press on the
   * header, and its … button), after the column's own Add task here. E.g.
   * sort, move every card.
   */
  headerMenu?: ItemMenuEntries
  /**
   * The card list scrolls inside the column (the default). Off where the
   * column grows with its cards and the board around it scrolls, as in
   * swimlanes.
   */
  scrolls?: boolean
  /** Spread onto the card list, the column of cards (inside the column's scroller when it scrolls). */
  listProps?: ComponentProps<'div'>
  /** The cards, with a drop indicator where a drag would land; or one `BoardColumnSection` per status. */
  children?: ReactNode
}

export interface BoardColumnSectionProps extends Omit<ComponentProps<'div'>, 'title'> {
  /** The status this section holds. */
  status: BoardColumnStatus
  /** Tasks in the section, beside its label. */
  count: number
  /** Names the section with its status. Off for a column's only status, which its header already names. */
  labelled?: boolean
  /** A dragged card is over this section. */
  dropTarget?: boolean
  /** The section's cards. Without any it is a drop place: a dashed card-sized gap. */
  children?: ReactNode
}

/** The column's scroller around the card list; the list alone when the board scrolls instead. */
function BoardColumnScroller({ scrolls, children }: { scrolls: boolean; children: ReactNode }) {
  return scrolls ? (
    <ScrollArea className='flex-1' innerClassName='min-h-full' viewportClassName='overscroll-y-contain'>
      {children}
    </ScrollArea>
  ) : (
    children
  )
}

/**
 * One column of the board: one status, or several. The page fills it with
 * cards, or with one section per status, and decides where a drop lands; the
 * column draws the header, the scrolling list, the empty and drop-target
 * states, and the create field pinned to its bottom.
 */
export function BoardColumn({
  title,
  status,
  count,
  dropTarget = false,
  onCreate,
  defaultCreateOpen = false,
  emptyLabel = 'No tasks',
  headerActions,
  headerMenu = [],
  scrolls = true,
  listProps,
  children,
  className,
  ...props
}: BoardColumnProps) {
  // Each "Add task here" remounts the create field open.
  const [createAsked, setCreateAsked] = useState(0)
  const empty = Children.toArray(children).length === 0
  const name = title ?? status?.name ?? ''
  const label = `${name}, ${count} ${count === 1 ? 'task' : 'tasks'}`
  const menu: ItemMenuEntries = [
    onCreate && {
      id: 'add',
      label: 'Add task here',
      icon: ListPlus,
      group: 'open',
      onSelect: () => setCreateAsked((n) => n + 1),
    },
    ...headerMenu,
  ]

  return (
    <section
      data-slot='board-column'
      data-drop-target={dropTarget || undefined}
      aria-label={label}
      className={cn(
        'flex h-full max-h-full w-72 max-w-[calc(100vw-2rem)] shrink-0 flex-col rounded-xl bg-muted/60 transition-colors',
        dropTarget && 'bg-primary/5 ring-2 ring-primary/30',
        className,
      )}
      {...props}
    >
      <ItemContextMenu entries={menu} render={<header />} className='flex h-11 shrink-0 items-center gap-1.5 pr-1.5 pl-2.5'>
        {title === undefined && status ? (
          <TaskStatusBadge name={status.name} category={status.category} color={status.color} size='sm' className='min-w-0 shrink' />
        ) : (
          <h3 className='min-w-0 truncate text-sm font-medium'>{name}</h3>
        )}
        <span className='shrink-0 text-xs font-medium text-muted-foreground tabular-nums'>{count}</span>
        <div className='ml-auto flex shrink-0 items-center gap-0.5'>
          {headerActions}
          <ItemActionsMenu entries={menu} label={`${name} column actions`} size='icon-xs' />
        </div>
      </ItemContextMenu>

      <BoardColumnScroller scrolls={scrolls}>
        <div
          data-slot='board-column-list'
          {...listProps}
          className={cn('flex min-h-0 flex-1 flex-col gap-2 px-2 pt-0.5 pb-2', listProps?.className)}
        >
          {empty ? (
            <div
              data-slot='board-column-empty'
              className={cn(
                'flex min-h-24 shrink-0 items-center justify-center rounded-lg border-2 border-dashed px-3 text-center text-sm transition-colors',
                dropTarget ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground',
              )}
            >
              {dropTarget ? 'Drop here' : emptyLabel}
            </div>
          ) : (
            children
          )}
        </div>
      </BoardColumnScroller>

      {onCreate ? (
        <div className='shrink-0 px-2 pb-2'>
          <TaskInlineCreate key={createAsked} onCreate={onCreate} defaultOpen={defaultCreateOpen || createAsked > 0} />
        </div>
      ) : null}
    </section>
  )
}

/**
 * One status inside a column: the column split horizontally, a section per
 * status in the board's order, each labelled with its status and count.
 * Dropping a card into a section moves it to that status. A section with no
 * cards is a dashed drop place.
 */
export function BoardColumnSection({
  status,
  count,
  labelled = true,
  dropTarget = false,
  children,
  className,
  ...props
}: BoardColumnSectionProps) {
  const empty = Children.toArray(children).length === 0
  return (
    <div
      data-slot='board-column-section'
      data-drop-target={dropTarget || undefined}
      role='group'
      aria-label={`${status.name}, ${count} ${count === 1 ? 'task' : 'tasks'}`}
      className={cn(
        'flex shrink-0 flex-col gap-2 rounded-lg transition-colors',
        labelled && 'border-t border-border/70 pt-1.5 first:border-t-0 first:pt-0',
        dropTarget && 'bg-primary/5 ring-2 ring-primary/30',
        className,
      )}
      {...props}
    >
      {labelled ? (
        <div className='flex h-6 items-center gap-1.5 px-0.5'>
          <TaskStatusBadge name={status.name} category={status.category} color={status.color} size='sm' className='min-w-0 shrink' />
          <span className='shrink-0 text-xs font-medium text-muted-foreground tabular-nums'>{count}</span>
        </div>
      ) : null}
      {empty ? (
        <div
          data-slot='board-column-section-empty'
          className={cn(
            'flex min-h-16 items-center justify-center rounded-lg border-2 border-dashed px-3 text-center text-sm transition-colors',
            dropTarget ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground',
          )}
        >
          Drop here
        </div>
      ) : (
        children
      )}
    </div>
  )
}
