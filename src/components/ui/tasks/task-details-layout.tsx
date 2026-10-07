import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface TaskDetailsCrumb {
  label: string
  href?: string
}

export interface TaskDetailsLayoutProps {
  /** Where the task sits: the project, then its ancestors. */
  breadcrumbs?: TaskDetailsCrumb[]
  /** The task's key and type, drawn above the title. */
  identity: ReactNode
  /** The summary — usually an in-place editable heading. */
  title: ReactNode
  /** Controls at the end of the identity row (copy link, the task menu). */
  actions?: ReactNode
  /** The body: description, subtasks, workflow, comments. */
  children: ReactNode
  /** The fields column: status, assignee, priority, dates, labels, people. */
  fields: ReactNode
  className?: string
}

/**
 * A task's page: breadcrumbs, the key and title, then the body beside a
 * fields column. The column moves above the body when the layout itself is
 * narrow (a phone, or a side peek), so the status and assignee stay the first
 * thing seen.
 */
export function TaskDetailsLayout({ breadcrumbs = [], identity, title, actions, children, fields, className }: TaskDetailsLayoutProps) {
  return (
    <article data-slot="task-details" className={cn('@container mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6', className)}>
      <header className="flex flex-col gap-2">
        {breadcrumbs.length ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <ChevronRight className="size-3.5 shrink-0" /> : null}
                {crumb.href ? (
                  <a href={crumb.href} className="truncate rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                    {crumb.label}
                  </a>
                ) : (
                  <span className="truncate">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
        <div>{title}</div>
      </header>
      <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
        <aside className="order-first flex w-full flex-col gap-1 rounded-lg border p-3 @3xl:order-last @3xl:sticky @3xl:top-4 @3xl:w-80 @3xl:shrink-0">
          {fields}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-8">{children}</div>
      </div>
    </article>
  )
}

export interface TaskDetailsSectionProps {
  title: ReactNode
  /** Controls at the end of the heading. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** One section of a task's body, with its heading. */
export function TaskDetailsSection({ title, actions, children, className }: TaskDetailsSectionProps) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export interface TaskDetailsFieldProps {
  label: string
  children: ReactNode
}

/** One labelled row of the fields column. */
export function TaskDetailsField({ label, children }: TaskDetailsFieldProps) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 pr-1.5">{children}</div>
    </div>
  )
}
