import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

/** A lifted card: what it is, where the press began, and where the finger is now (viewport px). */
export interface BoardTouchDragSession<Source extends string> {
  key: string
  source: Source
  start: { x: number; y: number }
  pointer: { x: number; y: number }
}

export interface BoardTouchReorderOptions<Source extends string> {
  /** The card lifted: the moment to show the drop line. */
  onLift?: (session: BoardTouchDragSession<Source>) => void
  /** Called on every move while the card is lifted. */
  onMove?: (session: BoardTouchDragSession<Source>) => void
  /** The finger was lifted with the card up. Not called when the press became a scroll or was cancelled. */
  onDrop: (session: BoardTouchDragSession<Source>) => void
  /** How long the press is held before the card lifts, in ms. */
  delay?: number
  /** How far the press may drift before it lifts; further, and it is a scroll. */
  tolerance?: number
  /** Which pointers start a lift. */
  pointerTypes?: string[]
}

// The chat list's long-press values, which were tuned on real phones: long
// enough that a quick scroll never lifts a card, short enough not to feel slow.
const DELAY_MS = 250
const TOLERANCE_PX = 5

/**
 * Long-press dragging for board cards. A press held still for `delay` lifts
 * the card, which then follows the finger; the page stops scrolling under it
 * until release. A press that moves before then is left to the browser as a
 * scroll or a swipe, and the native long-press menu is held back so it does
 * not open over a lifted card. The drop target is the caller's to find.
 */
export function useBoardTouchReorder<Source extends string>(options: BoardTouchReorderOptions<Source>) {
  const [session, setSession] = useState<BoardTouchDragSession<Source> | null>(null)
  const latest = useRef(options)
  latest.current = options
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanup.current?.(), [])

  const start = useCallback((key: string, source: Source, event: ReactPointerEvent<HTMLElement>) => {
    const { delay = DELAY_MS, tolerance = TOLERANCE_PX, pointerTypes = ['touch'] } = latest.current
    if (!pointerTypes.includes(event.pointerType) || (event.pointerType === 'mouse' && event.button !== 0)) {
      return
    }
    cleanup.current?.()
    const pointerId = event.pointerId
    const origin = { x: event.clientX, y: event.clientY }
    let current: BoardTouchDragSession<Source> | null = null

    const lift = () => {
      current = { key, source, start: origin, pointer: origin }
      setSession(current)
      document.body.style.setProperty('user-select', 'none')
      navigator.vibrate?.(10)
      latest.current.onLift?.(current)
    }
    const timer = window.setTimeout(lift, delay)

    const onPointerMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) {
        return
      }
      const pointer = { x: move.clientX, y: move.clientY }
      if (!current) {
        if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) > tolerance) {
          finish(false)
        }
        return
      }
      current = { ...current, pointer }
      setSession(current)
      latest.current.onMove?.(current)
    }
    // Registered before the browser decides the gesture, so that once the card
    // is up the finger moves the card and not the page.
    const onTouchMove = (touch: TouchEvent) => {
      if (current && touch.cancelable) {
        touch.preventDefault()
      }
    }
    const onContextMenu = (menu: Event) => menu.preventDefault()
    const swallow = (click: MouseEvent) => {
      click.stopPropagation()
      click.preventDefault()
    }
    const onPointerUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) {
        finish(true)
      }
    }
    const onPointerCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) {
        finish(false)
      }
    }

    function finish(drop: boolean) {
      const ended = current
      stop()
      setSession(null)
      if (ended && drop) {
        // The release would also press whatever it lands on; a drag is not a press.
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
        latest.current.onDrop(ended)
      }
    }
    function stop() {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('contextmenu', onContextMenu, { capture: true })
      document.body.style.removeProperty('user-select')
      cleanup.current = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    cleanup.current = stop
  }, [])

  return { session, start }
}
