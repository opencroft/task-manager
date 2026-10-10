// Where the page pane was scrolled, per address, so Back and Forward return to
// it the way a browser returns to a scrolled document. The host leaves an App's
// scroll to the App: the App stays mounted and one pane scrolls every page, so
// nothing else would put a list back where the reader left it.
//
// - Back / Forward (any move the App did not make itself): the position saved
//   for that address comes back, once the page has laid out enough to hold it.
// - A move to another page: the pane starts at the top.
// - A change of the query only (the peek, a filter): the pane stays where it is.
//
// A page that fills the pane and scrolls a list of its own (Tasks, in its
// table) hands that scroller over through `PageScrollerContext`; while it is
// mounted, it is what is kept and restored instead of the pane.

import { createContext, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

import { takeAppMove, useTasksLocation } from '../lib/router'

interface Position {
  top: number
  left: number
}

/**
 * How long a restore waits for the page to grow tall enough, e.g. while its
 * data loads. Generous because a large list can take seconds to come back,
 * and giving up early lands the reader at the top; any scroll, click or key of
 * theirs ends the wait at once.
 */
const RESTORE_FOR_MS = 5000

const positions = new Map<string, Position>()

/** Where a page that scrolls inside itself puts its scroller; empty while it has none mounted. */
export const PageScrollerContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

function address(): string {
  return `${window.location.pathname}${window.location.search}`
}

/**
 * Puts the scroller back at `target` as soon as its content allows it. Stops at
 * once when the reader scrolls themselves, so a late restore never pulls the
 * page away from them. Returns a function that stops it. The scroller is read
 * on every attempt: a page's own one mounts only once its data has loaded.
 */
function restore(scroller: RefObject<HTMLElement | null>, target: Position): () => void {
  const until = performance.now() + RESTORE_FOR_MS
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) {
      window.removeEventListener(type, stop, true)
    }
  }
  const attempt = () => {
    const element = scroller.current
    if (!element) {
      stop()
      return
    }
    const reachable = element.scrollHeight - element.clientHeight >= target.top
    if (reachable || performance.now() > until) {
      element.scrollTop = target.top
      element.scrollLeft = target.left
      stop()
      return
    }
    frame = requestAnimationFrame(attempt)
  }
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) {
    window.addEventListener(type, stop, { capture: true, passive: true })
  }
  attempt()
  return stop
}

/** Keeps the page's scroll per address; `scroller` is read when used, so it can point at the pane or a page's own scroller. */
export function usePageScrollMemory(scroller: RefObject<HTMLElement | null>): void {
  const location = useTasksLocation()
  const page = location.segments.join('/')
  const query = location.query.toString()
  const lastPage = useRef(page)

  // Heard on the document, not on the pane: the pane can mount after this
  // hook first runs (the project chat renders the App only once it has
  // loaded) and is a new element whenever the chat dock re-parents the App.
  // A listener put on the element this effect found would then be on none,
  // or on the old one, and no position would ever be saved. `scroll` does
  // not bubble, so it is caught on the way down.
  useEffect(() => {
    const save = (event: Event) => {
      const element = scroller.current
      if (element && event.target === element) {
        positions.set(address(), { top: element.scrollTop, left: element.scrollLeft })
      }
    }
    document.addEventListener('scroll', save, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', save, { capture: true })
  }, [scroller])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is a trigger only, so a Back that changes just the query restores too
  useLayoutEffect(() => {
    const element = scroller.current
    const pageChanged = page !== lastPage.current
    lastPage.current = page
    // A move the App did not make is the browser's Back or Forward. Asked
    // here rather than read off popstate: the router handles popstate first
    // and renders before a listener of ours would run.
    const byBrowser = !takeAppMove()
    if (!element) {
      return
    }
    if (byBrowser) {
      const saved = positions.get(address())
      if (saved) {
        return restore(scroller, saved)
      }
    }
    if (pageChanged) {
      element.scrollTop = 0
      element.scrollLeft = 0
    }
  }, [scroller, page, query])
}
