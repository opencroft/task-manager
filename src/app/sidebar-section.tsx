// A page's own section of the App sidebar, below the pages. The App mounts one
// AppSidebar (the pages and a slot under them) and a page that has something
// for the sidebar renders it through PageSidebarSection, which portals it into
// that slot. One sidebar keeps the order fixed: the pages first, the page's
// section second. Only Workflows has one, its workflow list.

import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

const SectionSlot = createContext<HTMLElement | null>(null)

/** Where pages below put their sidebar section; the App passes the slot's element. */
export const SidebarSectionProvider = SectionSlot.Provider

/** This page's section of the App sidebar. Renders nothing until the slot exists. */
export function PageSidebarSection({ children }: { children: ReactNode }) {
  const slot = useContext(SectionSlot)
  return slot ? createPortal(children, slot) : null
}
