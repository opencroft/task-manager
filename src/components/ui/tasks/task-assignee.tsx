import { Bot, UserRound } from 'lucide-react'
import { type ReactNode, createContext, useContext, useMemo, useState } from 'react'

import { cn } from 'cn'

export interface TaskAssigneeValue {
  kind: 'agent' | 'person'
  name: string
  /** The agent node or account id, when known: matched before the name. */
  id?: string
}

/** One person or agent the App knows a picture for; null when they have none. */
export interface TaskAvatar {
  kind: 'agent' | 'person'
  id: string
  name: string
  avatarUrl: string | null
}

interface AvatarIndex {
  byId: Record<string, string | null>
  byName: Record<string, string | null>
}

// By id first; by name for the places that only carry a name. A name two of
// the same kind share resolves to no picture, never to one of theirs.
function indexAvatars(avatars: readonly TaskAvatar[]): AvatarIndex {
  const byId: Record<string, string | null> = {}
  const byName: Record<string, string | null> = {}
  for (const avatar of avatars) {
    byId[`${avatar.kind}:${avatar.id}`] = avatar.avatarUrl
    const nameKey = `${avatar.kind}:${avatar.name}`
    byName[nameKey] = nameKey in byName ? null : avatar.avatarUrl
  }
  return { byId, byName }
}

const TaskAvatarsContext = createContext<AvatarIndex | null>(null)

/** The pictures every TaskAssignee below it draws; one without a match keeps its initials or glyph. */
export function TaskAvatarsProvider({ value, children }: { value: readonly TaskAvatar[]; children: ReactNode }) {
  const index = useMemo(() => indexAvatars(value), [value])
  return <TaskAvatarsContext.Provider value={index}>{children}</TaskAvatarsContext.Provider>
}

/** Their picture from the nearest TaskAvatarsProvider; null with none, or when they have no picture. */
export function useTaskAvatar(who: TaskAssigneeValue | null): string | null {
  const index = useContext(TaskAvatarsContext)
  if (!index || !who) {
    return null
  }
  const byId = who.id ? index.byId[`${who.kind}:${who.id}`] : undefined
  return byId ?? index.byName[`${who.kind}:${who.name}`] ?? null
}

/**
 * Their picture in a round frame sized by `className`, or `fallback` when they
 * have none or it fails to load. For a surface that draws someone its own way
 * and only needs the picture when there is one.
 */
export function TaskAvatarPicture({ who, fallback, className }: { who: TaskAssigneeValue; fallback: ReactNode; className?: string }) {
  const avatarUrl = useTaskAvatar(who)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!avatarUrl || avatarUrl === failedUrl) {
    return <>{fallback}</>
  }
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 overflow-hidden rounded-full bg-muted', className)}>
      <img src={avatarUrl} alt="" className="size-full object-cover" onError={() => setFailedUrl(avatarUrl)} />
    </span>
  )
}

export interface TaskAssigneeProps {
  /** Who the task is assigned to; null draws the unassigned state. */
  assignee: TaskAssigneeValue | null
  /** Show the name beside the avatar. */
  withName?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-5 text-[9px]',
  md: 'size-6 text-[10px]',
}

const ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-3',
  md: 'size-3.5',
}

// A stable tint per name, so the same person reads the same everywhere.
const TINTS = [
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-lime-500/15 text-lime-700 dark:text-lime-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
]

function tintFor(name: string): string {
  let hash = 0
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  return TINTS[hash % TINTS.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/**
 * Who a task is assigned to: a round avatar — their picture from
 * TaskAvatarsProvider, else initials for a person and a bot glyph for an
 * agent — and optionally the name. Unassigned is a dashed empty circle, so a
 * missing owner is visible rather than blank.
 */
export function TaskAssignee({ assignee, withName = false, size = 'md', className }: TaskAssigneeProps) {
  const label = assignee ? assignee.name : 'Unassigned'
  return (
    <span data-slot="task-assignee" className={cn('inline-flex min-w-0 items-center gap-2 text-sm', className)} title={withName ? undefined : label}>
      {assignee === null ? (
        <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground', SIZE[size])}>
          <UserRound className={ICON_SIZE[size]} />
        </span>
      ) : (
        <TaskAvatarPicture
          who={assignee}
          className={SIZE[size]}
          fallback={
            assignee.kind === 'agent' ? (
              <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary', SIZE[size])}>
                <Bot className={ICON_SIZE[size]} />
              </span>
            ) : (
              <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', SIZE[size], tintFor(assignee.name))}>
                {initials(assignee.name)}
              </span>
            )
          }
        />
      )}
      {withName ? (
        <span className={cn('truncate', assignee === null && 'text-muted-foreground')}>{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  )
}
