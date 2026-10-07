import type { ComponentType, MouseEvent, ReactNode } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

export interface TasksNavItem {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
  href: string
}

export interface TasksNavProps {
  /** The project's name or key, leading the bar. Leave it out where the page's title bar already names the project. */
  title?: ReactNode
  items: TasksNavItem[]
  /** Id of the page shown. */
  active: string | null
  /** Controls at the end of the bar (settings, create). */
  actions?: ReactNode
  className?: string
}

export interface TasksSidebarProps {
  /** The pages, in order: My work, Tasks, Board, Timeline, Workflows. */
  items: TasksNavItem[]
  /** Id of the page shown; null marks none (e.g. while a single task is open). */
  active: string | null
  /**
   * A page link was pressed (not with a modifier, which opens a new tab). The
   * link still navigates; this is the hook for closing the phone sheet.
   */
  onNavigate?: (href: string) => void
  /** The page's own section below the pages, e.g. the Workflows page's list. It fills the rest and scrolls. */
  children?: ReactNode
  className?: string
}

/**
 * The task manager's pages for the App sidebar (`AppSidebar`): a list of real
 * links with the current page marked, then the page's own section, if it has
 * one, filling the rest. It uses the sidebar's colours and row metrics but no
 * sidebar context, so it works inside whatever sidebar the host renders.
 */
export function TasksSidebar({ items, active, onNavigate, children, className }: TasksSidebarProps) {
  const pressed = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      onNavigate?.(href)
    }
  }
  return (
    <div data-slot='tasks-sidebar' className={cn('flex h-full min-h-0 flex-col text-sidebar-foreground', className)}>
      <nav aria-label='Task manager pages' className='shrink-0 p-2'>
        <ul className='flex flex-col gap-1'>
          {items.map((item) => {
            const Icon = item.icon
            const current = item.id === active
            return (
              <li key={item.id}>
                <a
                  href={item.href}
                  aria-current={current ? 'page' : undefined}
                  data-active={current || undefined}
                  onClick={(event) => pressed(event, item.href)}
                  className={cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0',
                    current && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )}
                >
                  {Icon ? <Icon /> : null}
                  <span className='truncate'>{item.label}</span>
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
      {children ? (
        <>
          <div aria-hidden='true' className='mx-2 h-px shrink-0 bg-sidebar-border' />
          <div data-slot='tasks-sidebar-section' className='flex min-h-0 flex-1 flex-col'>
            {children}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * The task manager's header: the project, then its pages as tabs, then the
 * page actions. The App itself lists its pages in its sidebar
 * (TasksSidebar). Every tab is a real link, so a page opens in a new tab and a
 * reload stays where it was. Tabs scroll rather than wrap on a narrow screen.
 */
export function TasksNav({ title, items, active, actions, className }: TasksNavProps) {
  return (
    <header data-slot="tasks-nav" className={cn('flex h-12 shrink-0 items-center gap-3 border-b px-3 sm:px-4', className)}>
      {title ? <div className="shrink-0 truncate text-sm font-semibold">{title}</div> : null}
      <nav aria-label="Task manager pages" className="h-full min-w-0 flex-1">
        <ScrollArea scrollbars="horizontal" className="h-full" innerClassName="h-full flex-row items-stretch gap-1">
          {items.map((item) => {
            const Icon = item.icon
            const current = item.id === active
            return (
              <a
                key={item.id}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'relative flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full',
                  current && 'font-medium text-foreground after:bg-primary',
                )}
              >
                {Icon ? <Icon className="size-4" /> : null}
                {item.label}
              </a>
            )
          })}
        </ScrollArea>
      </nav>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  )
}
