import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { anchoredScroll, clampPxPerDay, DEFAULT_PX_PER_DAY, fitPxPerDay } from './timeline-scale'

export interface TimelineZoomOptions {
  /** The element that scrolls the scale horizontally. */
  scrollerRef: RefObject<HTMLElement | null>
  /** Width of the fixed column left of the scale inside the scroller (the task tree). */
  gutter: number
  /** Day number at x = 0 of the scale. */
  origin: number
  /** Remembers the zoom level in this browser under this key. */
  storageKey?: string
}

export interface TimelineZoom {
  pxPerDay: number
  /** The zoom came from this browser's storage, not the default: the timeline has been opened here before. */
  restored: boolean
  /** The scrolled scale's visible window: its left edge in scale pixels, and its width. */
  viewport: { left: number; width: number }
  /** Multiply the zoom, keeping the day under `anchorX` (px from the scale's visible left edge) in place. */
  zoomBy: (factor: number, anchorX?: number) => void
  /** Scroll so `day` sits at `fraction` of the visible width. */
  scrollToDay: (day: number, fraction?: number) => void
  /** Zoom and scroll so the days `from`–`to` (inclusive) fill the visible width. */
  fit: (from: number, to: number) => void
}

function readStored(key: string | undefined): number | null {
  if (!key || typeof localStorage === 'undefined') {
    return null
  }
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? clampPxPerDay(value) : null
}

/**
 * Zoom and horizontal scroll for a timeline scale. Ctrl or Cmd + wheel zooms
 * around the pointer, and so does a trackpad pinch (browsers deliver it as a
 * Ctrl + wheel; Safari as gesture events) and a two-finger pinch on a touch
 * screen. The zoom is continuous, so the
 * header moves smoothly from days through weeks and months to quarters.
 */
export function useTimelineZoom({ scrollerRef, gutter, origin, storageKey }: TimelineZoomOptions): TimelineZoom {
  const [stored] = useState(() => readStored(storageKey))
  const [pxPerDay, setPxPerDay] = useState(stored ?? DEFAULT_PX_PER_DAY)
  const [viewport, setViewport] = useState({ left: 0, width: 0 })
  // The scroll offset to apply once the new zoom has rendered the wider or narrower scale.
  const pendingScroll = useRef<number | null>(null)
  const pxRef = useRef(pxPerDay)
  pxRef.current = pxPerDay

  const visibleWidth = useCallback(() => Math.max(0, (scrollerRef.current?.clientWidth ?? 0) - gutter), [scrollerRef, gutter])

  const zoomTo = useCallback(
    (next: number, anchorX?: number) => {
      const el = scrollerRef.current
      const from = pxRef.current
      const to = clampPxPerDay(next)
      if (!el || to === from) {
        return
      }
      pendingScroll.current = anchoredScroll(el.scrollLeft, anchorX ?? visibleWidth() / 2, from, to)
      pxRef.current = to
      setPxPerDay(to)
    },
    [scrollerRef, visibleWidth],
  )

  const zoomBy = useCallback((factor: number, anchorX?: number) => zoomTo(pxRef.current * factor, anchorX), [zoomTo])

  const scrollToDay = useCallback(
    (day: number, fraction = 1 / 3) => {
      const el = scrollerRef.current
      if (el) {
        el.scrollLeft = Math.max(0, (day - origin) * pxRef.current - visibleWidth() * fraction)
      }
    },
    [scrollerRef, origin, visibleWidth],
  )

  const fit = useCallback(
    (from: number, to: number) => {
      const el = scrollerRef.current
      if (!el) {
        return
      }
      // A day of margin on each side, so the first and last bars are not flush with the edges.
      const next = fitPxPerDay(to - from + 3, visibleWidth())
      const left = Math.max(0, (from - 1 - origin) * next)
      if (next === pxRef.current) {
        el.scrollLeft = left
        return
      }
      pendingScroll.current = left
      pxRef.current = next
      setPxPerDay(next)
    },
    [scrollerRef, origin, visibleWidth],
  )

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && pendingScroll.current !== null) {
      el.scrollLeft = pendingScroll.current
      pendingScroll.current = null
    }
    if (storageKey && typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, String(pxPerDay))
    }
  }, [pxPerDay, scrollerRef, storageKey])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) {
      return
    }
    const anchorOf = (clientX: number) => {
      const x = clientX - el.getBoundingClientRect().left - gutter
      return x > 0 ? x : undefined
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      event.preventDefault()
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      zoomBy(Math.exp(-delta * 0.0025), anchorOf(event.clientX))
    }
    // Safari reports a trackpad pinch as gesture events with a cumulative scale.
    let lastScale = 1
    const onGestureStart = (event: Event) => {
      event.preventDefault()
      lastScale = 1
    }
    const onGestureChange = (event: Event) => {
      event.preventDefault()
      const gesture = event as Event & { scale: number; clientX: number }
      zoomBy(gesture.scale / lastScale, anchorOf(gesture.clientX))
      lastScale = gesture.scale
    }
    // A two-finger pinch on a touch screen: the fingers' spread scales the zoom
    // around their midpoint. One finger is left to the browser as a scroll.
    let spread = 0
    const fingers = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]]
      return { spread: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), midX: (a.clientX + b.clientX) / 2 }
    }
    const onTouchStart = (event: TouchEvent) => {
      spread = event.touches.length === 2 ? fingers(event).spread : 0
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || spread === 0) {
        return
      }
      event.preventDefault()
      const now = fingers(event)
      zoomBy(now.spread / spread, anchorOf(now.midX))
      spread = now.spread
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        spread = 0
      }
    }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewport({ left: el.scrollLeft, width: Math.max(0, el.clientWidth - gutter) }))
    }
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('scroll', measure)
    }
  }, [scrollerRef, gutter, zoomBy])

  return { pxPerDay, restored: stored !== null, viewport, zoomBy, scrollToDay, fit }
}
