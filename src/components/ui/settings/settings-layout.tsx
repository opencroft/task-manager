import { type ComponentType, type ReactNode, useId, useLayoutEffect, useRef } from 'react'

import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

export interface SettingsLayoutSection {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
}

export interface SettingsLayoutProps {
  /** The page's heading, e.g. "Settings". */
  title: ReactNode
  sections: readonly SettingsLayoutSection[]
  /** Id of the section shown. */
  active: string
  /** Each section's address; the list is made of real links to it. */
  hrefFor: (id: string) => string
  /** The section shown, usually one SettingsSection. */
  children: ReactNode
  className?: string
}

/**
 * A settings page: its sections as links down the left and the section shown
 * beside them. Below 42rem of its own width (a container query, so it holds
 * in a panel as well as on a phone) the links become a row of tabs above the
 * section that scrolls sideways, the current one scrolled into view. The
 * section scrolls on its own, so the links stay put.
 */
export function SettingsLayout({ title, sections, active, hrefFor, children, className }: SettingsLayoutProps) {
  const row = useRef<HTMLDivElement>(null)

  // Bring the current tab into the row's view. Measured, not scrollIntoView, so the page itself never moves;
  // while the row is hidden (a wide layout) every rect is empty and nothing changes.
  useLayoutEffect(() => {
    const viewport = row.current
    const link = viewport?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!viewport || !link) {
      return
    }
    const box = viewport.getBoundingClientRect()
    const tab = link.getBoundingClientRect()
    if (tab.left < box.left) {
      viewport.scrollLeft += tab.left - box.left - 8
    } else if (tab.right > box.right) {
      viewport.scrollLeft += tab.right - box.right + 8
    }
  }, [active])

  return (
    <div data-slot='settings-layout' className={cn('@container/settings flex h-full min-h-0 flex-col', className)}>
      <div className='flex min-h-0 flex-1 flex-col @2xl/settings:flex-row'>
        <div className='shrink-0 border-b @2xl/settings:hidden'>
          <h1 className='truncate px-4 pt-3 text-base font-semibold'>{title}</h1>
          <nav aria-label='Settings sections'>
            <ScrollArea ref={row} scrollbars='horizontal' innerClassName='flex-row gap-1 px-2'>
              {sections.map((section) => {
                const Icon = section.icon
                const current = section.id === active
                return (
                  <a
                    key={section.id}
                    href={hrefFor(section.id)}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'relative flex h-10 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                      'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full',
                      current && 'font-medium text-foreground after:bg-primary',
                    )}
                  >
                    {Icon ? <Icon className='size-4' /> : null}
                    {section.label}
                  </a>
                )
              })}
            </ScrollArea>
          </nav>
        </div>

        <div className='hidden w-56 shrink-0 flex-col border-r @2xl/settings:flex'>
          <h1 className='truncate px-5 pt-5 pb-3 text-base font-semibold'>{title}</h1>
          <nav aria-label='Settings sections' className='flex min-h-0 flex-1 flex-col'>
            <ScrollArea className='min-h-0 flex-1' innerClassName='gap-0.5 px-3 pb-3'>
              {sections.map((section) => {
                const Icon = section.icon
                const current = section.id === active
                return (
                  <a
                    key={section.id}
                    href={hrefFor(section.id)}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                      current && 'bg-accent font-medium text-accent-foreground hover:bg-accent',
                    )}
                  >
                    {Icon ? <Icon className='size-4 shrink-0' /> : null}
                    <span className='truncate'>{section.label}</span>
                  </a>
                )
              })}
            </ScrollArea>
          </nav>
        </div>

        <ScrollArea className='min-h-0 min-w-0 flex-1'>
          <div className='mx-auto flex w-full max-w-3xl flex-col gap-10 p-4 @2xl/settings:p-6'>{children}</div>
        </ScrollArea>
      </div>
    </div>
  )
}

export interface SettingsSectionProps {
  title: ReactNode
  /** What the section changes, in a sentence or two, under the heading. */
  description?: ReactNode
  /** Controls beside the heading (a link to a page, an Add button); they wrap under it when there is no room. */
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

/** One section of a settings page: its heading, description and actions over its content. */
export function SettingsSection({ title, description, actions, children, className }: SettingsSectionProps) {
  const heading = useId()
  return (
    <section data-slot='settings-section' aria-labelledby={heading} className={cn('flex min-w-0 flex-col gap-4', className)}>
      <header className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2'>
        <div className='min-w-0 flex-1 basis-64'>
          <h2 id={heading} className='text-lg font-semibold break-words'>
            {title}
          </h2>
          {description ? <p className='mt-1 text-sm text-pretty text-muted-foreground'>{description}</p> : null}
        </div>
        {actions ? <div className='flex shrink-0 flex-wrap items-center gap-2'>{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}
