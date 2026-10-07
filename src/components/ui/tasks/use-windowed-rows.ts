import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface WindowedRowsOptions {
  /** How many rows the list holds. */
  count: number
  /** Each row's height in pixels: one number for every row, or one per row in order. */
  rowHeight: number | readonly number[]
  /** The element the first row starts at. Its position is measured against the scroller. */
  listRef: RefObject<HTMLElement | null>
  /** The element that scrolls. Without it, the nearest scrolling ancestor of the list, or the page. */
  scrollerRef?: RefObject<HTMLElement | null>
  /** Rows rendered past each edge of the visible ones, so the next row a key steps to is already there. */
  overscan?: number
  /** Height of a sticky header over the scroller's top edge; `scrollToIndex` keeps rows below it. */
  stickyTop?: number
}

export interface WindowedRows {
  /** The first row to render. */
  start: number
  /** One past the last row to render. */
  end: number
  /** Space standing in for the rows above `start`. */
  padTop: number
  /** Space standing in for the rows from `end` on. */
  padBottom: number
  /** Scrolls the least distance that shows row `index` whole. */
  scrollToIndex: (index: number) => void
}

/** Where every row starts, plus where the last one ends: `count + 1` ascending offsets. */
export function rowOffsets(count: number, rowHeight: number | readonly number[]): number[] {
  const offsets = new Array<number>(count + 1)
  offsets[0] = 0
  for (let i = 0; i < count; i++) {
    offsets[i + 1] = offsets[i] + (typeof rowHeight === 'number' ? rowHeight : (rowHeight[i] ?? 0))
  }
  return offsets
}

/** The index of the first row whose bottom is below `y`. */
function firstBelow(offsets: readonly number[], y: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid + 1] > y) {
      high = mid
    } else {
      low = mid + 1
    }
  }
  return low
}

function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (/auto|scroll|overlay/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
  }
  return null
}

/**
 * Renders a long list of rows in step with its scroll position: only the rows
 * in view, plus `overscan` on each side, with two spacers keeping the list's
 * full height. Row heights are known in advance, so every row's position is
 * arithmetic and nothing is measured per row.
 */
export function useWindowedRows({
  count,
  rowHeight,
  listRef,
  scrollerRef,
  overscan = 10,
  stickyTop = 0,
}: WindowedRowsOptions): WindowedRows {
  const offsets = useMemo(() => rowOffsets(count, rowHeight), [count, rowHeight])
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, overscan * 3) }))
  const frame = useRef(0)

  const scroller = useCallback(
    () => scrollerRef?.current ?? (listRef.current ? scrollingAncestor(listRef.current) : null),
    [listRef, scrollerRef],
  )

  /** The visible band in list coordinates: its top, and its height. */
  const band = useCallback((): { top: number; height: number } | null => {
    const list = listRef.current
    if (!list) {
      return null
    }
    const element = scroller()
    const viewTop = element ? element.getBoundingClientRect().top : 0
    const height = element ? element.clientHeight : window.innerHeight
    return { top: viewTop - list.getBoundingClientRect().top, height }
  }, [listRef, scroller])

  const measure = useCallback(() => {
    const view = band()
    if (!view) {
      return
    }
    const first = firstBelow(offsets, Math.max(0, view.top))
    const last = firstBelow(offsets, Math.max(0, view.top + view.height))
    const start = Math.max(0, Math.min(count, first) - overscan)
    const end = Math.min(count, last + 1 + overscan)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [band, count, offsets, overscan])

  useLayoutEffect(() => {
    measure()
    const element = scroller()
    const target: HTMLElement | Window = element ?? window
    const schedule = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(measure)
    }
    target.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resize = element ? new ResizeObserver(schedule) : null
    resize?.observe(element as HTMLElement)
    return () => {
      cancelAnimationFrame(frame.current)
      target.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resize?.disconnect()
    }
  }, [measure, scroller])

  const scrollToIndex = useCallback(
    (index: number) => {
      const view = band()
      if (!view || index < 0 || index >= count) {
        return
      }
      const top = offsets[index]
      const bottom = offsets[index + 1]
      const visibleTop = view.top + stickyTop
      const delta = top < visibleTop ? top - visibleTop : bottom > view.top + view.height ? bottom - (view.top + view.height) : 0
      if (delta !== 0) {
        const element = scroller()
        if (element) {
          element.scrollTop += delta
        } else {
          window.scrollBy(0, delta)
        }
      }
    },
    [band, count, offsets, scroller, stickyTop],
  )

  const start = Math.min(range.start, count)
  const end = Math.min(range.end, count)
  return {
    start,
    end,
    padTop: offsets[start],
    padBottom: offsets[count] - offsets[end],
    scrollToIndex,
  }
}
