// Whether a surface is as narrow as a phone. Decided by the element's own
// measured width rather than by the device, so a narrow pane on a desktop gets
// the same layout as a phone, and a phone turned sideways gets the wide one.

import { type RefObject, useLayoutEffect, useState } from 'react'

/** Below this width in px the task manager lays out for a phone (Tailwind's `sm`). */
export const PHONE_MAX_WIDTH = 640

export function usePhoneWidth(ref: RefObject<HTMLElement | null>): boolean {
  const [phone, setPhone] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const measure = () => setPhone(element.getBoundingClientRect().width < PHONE_MAX_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return phone
}
