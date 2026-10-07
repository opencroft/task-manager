import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

/** A drag in progress: what is dragged, from where, and where the pointer is now (viewport px). */
export interface DragSession<Source extends string> {
  key: string
  source: Source
  start: { x: number; y: number }
  pointer: { x: number; y: number }
}

export interface TimelineDragOptions<Source extends string> {
  /** Called on every pointer move once the drag has started. */
  onMove?: (session: DragSession<Source>) => void
  /** Called when the pointer is released over the page; not called on cancel. */
  onDrop: (session: DragSession<Source>) => void
}

/** How far the pointer travels before a press becomes a drag, so a click stays a click. */
const ACTIVATION_PX = 5

/**
 * Pointer-events dragging for the timeline: bars, tree rows and backlog items
 * all start drags through the handler this returns, and the one session they
 * share is what lets a drag cross from one list to another.
 *
 * Only mouse and pen start a drag. On touch, a press scrolls the lists and a
 * long press opens the context menu, which offers every drag action too.
 * Escape cancels. The drop target is the caller's to find, from the pointer.
 */
export function useTimelineDrag<Source extends string>({ onMove, onDrop }: TimelineDragOptions<Source>) {
  const [session, setSession] = useState<DragSession<Source> | null>(null)
  const callbacks = useRef({ onMove, onDrop })
  callbacks.current = { onMove, onDrop }
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanup.current?.(), [])

  const start = useCallback((key: string, source: Source, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') {
      return
    }
    cleanup.current?.()
    const origin = { x: event.clientX, y: event.clientY }
    let current: DragSession<Source> | null = null

    const onPointerMove = (move: PointerEvent) => {
      const pointer = { x: move.clientX, y: move.clientY }
      if (!current && Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < ACTIVATION_PX) {
        return
      }
      move.preventDefault()
      current = { key, source, start: origin, pointer }
      setSession(current)
      callbacks.current.onMove?.(current)
    }
    const finish = (drop: boolean) => {
      const ended = current
      stop()
      setSession(null)
      if (ended && drop) {
        // The release would also click whatever it lands on; a drag is not a click.
        window.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
        callbacks.current.onDrop(ended)
      }
    }
    const swallow = (click: MouseEvent) => {
      click.stopPropagation()
      click.preventDefault()
    }
    const onPointerUp = () => finish(true)
    const onCancel = () => finish(false)
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key === 'Escape' && current) {
        key.preventDefault()
        finish(false)
      }
    }
    const stop = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      document.body.style.removeProperty('user-select')
      cleanup.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    document.body.style.setProperty('user-select', 'none')
    cleanup.current = stop
  }, [])

  return { session, start }
}
