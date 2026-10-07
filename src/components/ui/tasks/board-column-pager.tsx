import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Children, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

import type { BoardColumnStatus } from './board-column'
import { TaskStatusBadge } from './task-status-badge'

export interface BoardColumnPagerColumn {
  id: string | number
  /** The column's own name, on its tab. */
  title?: string
  /** Shown as its badge on the tab when the column has no `title`: a column named after its one status. */
  status?: BoardColumnStatus
  /** Tasks in the column, shown on its tab. */
  count: number
}

export interface BoardColumnPagerProps {
  columns: BoardColumnPagerColumn[]
  /** The column shown. Controlled when given. */
  activeIndex?: number
  defaultActiveIndex?: number
  onActiveIndexChange?: (index: number) => void
  /** One board column per entry in `columns`, in the same order. Each is stretched to the full width. */
  children: ReactNode
  className?: string
}

/** How long the track must be still before a swipe counts as settled on a column. */
const SETTLE_MS = 90

const ARROW =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40'

/**
 * The board at phone width. The columns sit side by side in a track that
 * snaps to one column at a time; a swipe moves to the next, and the tabs
 * above jump to any of them. The page still owns the columns and their cards.
 */
export function BoardColumnPager({
  columns,
  activeIndex,
  defaultActiveIndex = 0,
  onActiveIndexChange,
  children,
  className,
}: BoardColumnPagerProps) {
  const baseId = useId()
  const [ownIndex, setOwnIndex] = useState(defaultActiveIndex)
  const controlled = activeIndex !== undefined
  const last = Math.max(columns.length - 1, 0)
  const active = Math.min(Math.max(controlled ? activeIndex : ownIndex, 0), last)
  const slides = Children.toArray(children)

  const trackRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // The column the track rests on, so a swipe and a tab press don't answer each other.
  const shown = useRef(active)
  const settleTimer = useRef<number | undefined>(undefined)

  const choose = useCallback(
    (index: number) => {
      if (!controlled) {
        setOwnIndex(index)
      }
      onActiveIndexChange?.(index)
    },
    [controlled, onActiveIndexChange],
  )

  // Start on the active column, and stay on it when the width changes (a phone turned sideways).
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) {
      return
    }
    track.scrollLeft = shown.current * track.clientWidth
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      track.scrollLeft = shown.current * track.clientWidth
    })
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  // A new active column from a tab, an arrow or the host: slide to it.
  useEffect(() => {
    const track = trackRef.current
    if (track && shown.current !== active) {
      shown.current = active
      track.scrollTo({ left: active * track.clientWidth, behavior: 'smooth' })
    }
    const strip = stripRef.current
    const tab = tabRefs.current[active]
    if (strip && tab) {
      strip.scrollTo({ left: tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2, behavior: 'smooth' })
    }
  }, [active])

  const onScroll = () => {
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      const track = trackRef.current
      if (!track || track.clientWidth === 0) {
        return
      }
      const index = Math.min(Math.max(Math.round(track.scrollLeft / track.clientWidth), 0), last)
      if (index !== shown.current) {
        shown.current = index
        choose(index)
      }
    }, SETTLE_MS)
  }

  const step = (index: number) => {
    const next = Math.min(Math.max(index, 0), last)
    if (next !== active) {
      choose(next)
    }
    return next
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: last }
    const target = moves[event.key]
    if (target === undefined) {
      return
    }
    event.preventDefault()
    tabRefs.current[step(target)]?.focus()
  }

  return (
    <div data-slot='board-column-pager' className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}>
      <div className='flex shrink-0 items-center gap-0.5 px-1 pb-1'>
        <button type='button' className={ARROW} aria-label='Previous column' disabled={active === 0} onClick={() => step(active - 1)}>
          <ChevronLeft aria-hidden='true' className='size-4' />
        </button>
        <ScrollArea
          ref={stripRef}
          scrollbars='horizontal'
          viewportProps={{ role: 'tablist', 'aria-label': 'Board columns', onKeyDown: onTabKeyDown }}
          className='min-w-0 flex-1'
          innerClassName='flex-row items-center gap-1 pt-1 pb-2'
        >
          {columns.map((column, index) => {
            const selected = index === active
            const name = column.title ?? column.status?.name ?? ''
            return (
              <button
                key={column.id}
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                type='button'
                role='tab'
                id={`${baseId}-tab-${index}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${index}`}
                aria-label={`${name}, ${column.count} ${column.count === 1 ? 'task' : 'tasks'}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => step(index)}
                className={cn(
                  'inline-flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-lg px-1.5 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
                  selected ? 'bg-background shadow-xs ring-1 ring-border' : 'opacity-70 hover:bg-foreground/5 hover:opacity-100',
                )}
              >
                {column.title === undefined && column.status ? (
                  <TaskStatusBadge
                    name={column.status.name}
                    category={column.status.category}
                    color={column.status.color}
                    size='sm'
                    className='min-w-0 shrink'
                  />
                ) : (
                  <span className='min-w-0 truncate text-xs font-medium'>{name}</span>
                )}
                <span className='shrink-0 text-xs font-medium text-muted-foreground tabular-nums'>{column.count}</span>
              </button>
            )
          })}
        </ScrollArea>
        <button type='button' className={ARROW} aria-label='Next column' disabled={active === last} onClick={() => step(active + 1)}>
          <ChevronRight aria-hidden='true' className='size-4' />
        </button>
      </div>

      <ScrollArea
        ref={trackRef}
        data-slot='board-column-pager-track'
        onScroll={onScroll}
        scrollbars='horizontal'
        className='flex-1'
        viewportClassName='snap-x snap-mandatory overscroll-x-contain'
        innerClassName='h-full flex-row'
      >
        {columns.map((column, index) => (
          <div
            key={column.id}
            role='tabpanel'
            id={`${baseId}-panel-${index}`}
            aria-labelledby={`${baseId}-tab-${index}`}
            className='flex h-full w-full shrink-0 snap-center snap-always flex-col px-3 pb-3 *:data-[slot=board-column]:w-full *:data-[slot=board-column]:max-w-none'
          >
            {slides[index]}
          </div>
        ))}
      </ScrollArea>
    </div>
  )
}
