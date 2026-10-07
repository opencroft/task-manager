import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react'

import type { TimelineLink } from './timeline-links-model'

/** A dependency being drawn: from a bar's end handle (`drag`) or after the menu's "Blocks…" (`pick`). */
export interface TimelineLinking {
  from: string
  by: 'drag' | 'pick'
  /** The task under the pointer; null until the pointer has moved. */
  over: string | null
  /** The pointer in the link layer's pixels; null until it has moved. */
  point: { x: number; y: number } | null
}

export interface TimelineLinkingOptions {
  /** The element the link layer is drawn in; the draft's point is measured from its corner. */
  layerRef: RefObject<HTMLElement | null>
  /** A link drawn onto another task. */
  onLink?: (link: TimelineLink) => void
}

/** The task under a point: the nearest element marked with its key (a tree row, a lane, a backlog item). */
function taskKeyAt(x: number, y: number): string | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-task-key]')?.dataset.taskKey ?? null
}

/**
 * Drawing a dependency: from a bar's end handle, released on a task; or after
 * "Blocks…", pressed on one. Either ends on the task under the pointer, and Esc
 * cancels either. The press or release that ends it is swallowed, so it does
 * not also select or open what it lands on.
 */
export function useTimelineLinking({ layerRef, onLink }: TimelineLinkingOptions) {
  const [linking, setLinking] = useState<TimelineLinking | null>(null)
  const onLinkRef = useRef(onLink)
  onLinkRef.current = onLink

  const layerPoint = (x: number, y: number) => {
    const box = layerRef.current?.getBoundingClientRect()
    return box ? { x: x - box.left, y: y - box.top } : null
  }
  const layerPointRef = useRef(layerPoint)
  layerPointRef.current = layerPoint

  const from = linking?.from ?? null
  const by = linking?.by ?? null
  useEffect(() => {
    if (from === null) {
      return
    }
    const onMove = (event: globalThis.PointerEvent) => {
      const over = taskKeyAt(event.clientX, event.clientY)
      const point = layerPointRef.current(event.clientX, event.clientY)
      setLinking((current) => current && { ...current, over, point })
    }
    const swallow = (event: MouseEvent) => {
      event.stopPropagation()
      event.preventDefault()
    }
    const onEnd = (event: globalThis.PointerEvent) => {
      event.stopPropagation()
      event.preventDefault()
      const to = taskKeyAt(event.clientX, event.clientY)
      if (to && to !== from) {
        onLinkRef.current?.({ from, to })
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      setLinking(null)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        setLinking(null)
      }
    }
    const endEvent = by === 'drag' ? 'pointerup' : 'pointerdown'
    window.addEventListener('pointermove', onMove)
    window.addEventListener(endEvent, onEnd, { capture: true })
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener(endEvent, onEnd, { capture: true })
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [from, by])

  return {
    linking,
    /** From a bar's end handle: the press that starts the drag. */
    startDrag: (key: string, event: PointerEvent<HTMLElement>) =>
      setLinking({ from: key, by: 'drag', over: null, point: layerPoint(event.clientX, event.clientY) }),
    /** From the menu's "Blocks…": the next press picks the task. */
    startPick: (key: string) => setLinking({ from: key, by: 'pick', over: null, point: null }),
  }
}
