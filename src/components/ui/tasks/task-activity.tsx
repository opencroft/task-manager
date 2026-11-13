import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskAssignee } from './task-assignee'

export interface TaskActivityItem {
  id: number | string
  actor: { kind: 'agent' | 'person'; name: string }
  kind: string
  field: string | null
  from: string | null
  to: string | null
  at: string
}

export interface TaskActivityProps {
  entries: TaskActivityItem[]
  /** Newest first (default) or oldest first. */
  order?: 'newest' | 'oldest'
  /**
   * A row's menu on right-click, long press, the Menu key or Shift+F10, given
   * the row as one line of plain text (for "Copy").
   */
  rowMenu?: (entry: TaskActivityItem, line: string) => ItemMenuEntries
  /** Show every description edit's before and after texts expanded (each row still toggles). */
  textChangesOpen?: boolean
  className?: string
}

const FIELD_NAMES: Record<string, string> = {
  summary: 'summary',
  description: 'description',
  status: 'status',
  type: 'type',
  priority: 'priority',
  assignee: 'assignee',
  dates: 'schedule',
  labels: 'labels',
  parent: 'parent',
}

function Value({ children, className }: { children: string; className?: string }) {
  return <span className={cn('rounded-md bg-muted px-1.5 font-medium text-foreground', className)}>{children}</span>
}

/** A description entry that carries its texts; entries stored without them say only that it was edited. */
function hasTexts(entry: TaskActivityItem): boolean {
  return entry.kind === 'field' && entry.field === 'description' && (entry.from !== null || entry.to !== null)
}

function TextSide({ label, text }: { label: string; text: string | null }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 max-h-48 overflow-y-auto rounded-md bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap break-words text-foreground">
        {text ? text : <span className="text-muted-foreground italic">empty</span>}
      </div>
    </div>
  )
}

/** The before and after texts of a description edit, behind a toggle so the row stays one line. */
function TextChange({ entry, defaultOpen = false }: { entry: TaskActivityItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      <Button variant="link" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide changes' : 'Show changes'}
      </Button>
      {open && (
        <div data-slot="task-activity-text-change" className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <TextSide label="Before" text={entry.from} />
          <TextSide label="After" text={entry.to} />
        </div>
      )}
    </>
  )
}

function describe(entry: TaskActivityItem) {
  switch (entry.kind) {
    case 'created':
      return <>created the task</>
    case 'subtask_added':
      return (
        <>
          added subtask <Value>{entry.to ?? ''}</Value>
        </>
      )
    case 'subtask_removed':
      return (
        <>
          removed subtask <Value>{entry.from ?? ''}</Value>
        </>
      )
    case 'attachment_added':
      // A file name has no spaces to wrap at, so it may break anywhere.
      return (
        <>
          attached <Value className="break-all">{entry.to ?? ''}</Value>
        </>
      )
    case 'attachment_removed':
      return (
        <>
          removed attachment <Value className="break-all">{entry.from ?? ''}</Value>
        </>
      )
    case 'field': {
      const field = FIELD_NAMES[entry.field ?? ''] ?? entry.field
      if (entry.field === 'description') {
        return <>edited the description</>
      }
      if (entry.from && entry.to) {
        return (
          <>
            changed {field} <Value>{entry.from}</Value> → <Value>{entry.to}</Value>
          </>
        )
      }
      if (entry.to) {
        return (
          <>
            set {field} to <Value>{entry.to}</Value>
          </>
        )
      }
      if (entry.from) {
        return (
          <>
            cleared {field} (was <Value>{entry.from}</Value>)
          </>
        )
      }
      return <>changed {field}</>
    }
    default:
      return <>{entry.kind.replace(/_/g, ' ')}</>
  }
}

/** The same sentence as `describe`, as plain text. */
function describeText(entry: TaskActivityItem): string {
  switch (entry.kind) {
    case 'created':
      return 'created the task'
    case 'subtask_added':
      return `added subtask ${entry.to ?? ''}`
    case 'subtask_removed':
      return `removed subtask ${entry.from ?? ''}`
    case 'attachment_added':
      return `attached ${entry.to ?? ''}`
    case 'attachment_removed':
      return `removed attachment ${entry.from ?? ''}`
    case 'field': {
      const field = FIELD_NAMES[entry.field ?? ''] ?? entry.field
      if (entry.field === 'description') {
        return 'edited the description'
      }
      if (entry.from && entry.to) {
        return `changed ${field} ${entry.from} → ${entry.to}`
      }
      if (entry.to) {
        return `set ${field} to ${entry.to}`
      }
      if (entry.from) {
        return `cleared ${field} (was ${entry.from})`
      }
      return `changed ${field}`
    }
    default:
      return entry.kind.replace(/_/g, ' ')
  }
}

/** A history row as one line: who, what, when. */
export function activityLine(entry: TaskActivityItem): string {
  return `${entry.actor.name} ${describeText(entry)} · ${when(entry.at)}`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A task's history: who changed what, from what to what, and when. */
export function TaskActivity({
  entries,
  order = 'newest',
  rowMenu,
  textChangesOpen = false,
  className,
}: TaskActivityProps) {
  const sorted = order === 'newest' ? [...entries].reverse() : entries
  if (sorted.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>No activity yet.</p>
  }
  return (
    <ol data-slot="task-activity" className={cn('flex flex-col gap-3', className)}>
      {sorted.map((entry) => (
        <ItemContextMenu
          key={entry.id}
          entries={rowMenu?.(entry, activityLine(entry)) ?? []}
          render={<li tabIndex={rowMenu ? 0 : undefined} />}
          className="-mx-1 flex items-start gap-2.5 rounded-md px-1 text-sm outline-none select-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <TaskAssignee assignee={entry.actor} size="sm" className="mt-px" />
          <div className="min-w-0 flex-1 leading-6 text-muted-foreground">
            <span className="font-medium text-foreground">{entry.actor.name}</span> {describe(entry)}
            <span className="ml-2 text-xs whitespace-nowrap">{when(entry.at)}</span>
            {hasTexts(entry) && <TextChange entry={entry} defaultOpen={textChangesOpen} />}
          </div>
        </ItemContextMenu>
      ))}
    </ol>
  )
}
