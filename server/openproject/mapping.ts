// The decisions of an OpenProject import that need no database: which of our
// statuses, types and people each source one suggests, what the preview
// counts, and how a work package's text and fields translate.

import type {
  OpenProjectCount,
  OpenProjectMapping,
  OpenProjectStatusCount,
  OpenProjectStatusTarget,
  OpenProjectTypeTarget,
} from '../../shared/openproject.ts'
import {
  type Assignee,
  PRIORITIES,
  type Priority,
  STATUS_CATEGORIES,
  type Status,
  type StatusCategory,
  TASK_TYPES,
  type TaskType,
} from '../../shared/types.ts'
import type { AgentInfo, PersonInfo } from '../service.ts'
import { TaskError } from '../service.ts'
import type { SourceStatus, SourceType, SourceWorkPackage } from './api.ts'

/** Everything read from OpenProject for one project, comments aside. */
export interface SourceData {
  workPackages: SourceWorkPackage[]
  statuses: SourceStatus[]
  types: SourceType[]
  /** Every user id met on a work package or comment, with the name OpenProject gave. */
  people: Map<string, string>
}

const lower = (text: string) => text.trim().toLowerCase()

/** The colours a status takes: what status_create accepts. */
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-z-]{1,30})$/

/** The longest status name status_create accepts. */
const STATUS_NAME_MAX = 40

/** A source status name as one of ours: one line, cut to fit. */
const statusName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, STATUS_NAME_MAX).trim()

/** A status category from an OpenProject status: closed is done, a name that says work is under way is in progress, the rest is to do. */
export function guessCategory(status: Pick<SourceStatus, 'name' | 'isClosed'>): StatusCategory {
  if (status.isClosed) {
    return 'done'
  }
  return /progress|develop|review|test|\bqa\b|doing|implement|fail/i.test(status.name) ? 'in_progress' : 'todo'
}

/** Our type for an OpenProject type, by its name. */
export function guessType(name: string): TaskType {
  if (/bug|defect/i.test(name)) {
    return 'bug'
  }
  if (/epic|summary/i.test(name)) {
    return 'epic'
  }
  if (/story|feature/i.test(name)) {
    return 'story'
  }
  return 'task'
}

// A user's name may carry a role in parentheses, e.g. "Alice (Agent)": it also matches without it.
const bareName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()

/** Who an OpenProject user is here: an agent or a person of the same name, else the name alone. */
export function guessPerson(name: string, agents: AgentInfo[], people: PersonInfo[]): Assignee {
  for (const wanted of [lower(name), lower(bareName(name))]) {
    const agent = agents.find((candidate) => lower(candidate.name) === wanted)
    if (agent) {
      return { kind: 'agent', id: agent.id, name: agent.name }
    }
    const person = people.find((candidate) => lower(candidate.name) === wanted)
    if (person) {
      return { kind: 'person', id: person.id, name: person.name }
    }
  }
  return { kind: 'person', name: name.trim() }
}

/** The mapping the preview suggests for the statuses, types and people the work packages use. */
export function suggestMapping(
  source: SourceData,
  ours: Status[],
  agents: AgentInfo[],
  people: PersonInfo[],
): OpenProjectMapping {
  const usedStatuses = new Set(source.workPackages.map((wp) => wp.statusId))
  const statuses: Record<string, OpenProjectStatusTarget> = {}
  for (const status of source.statuses.filter((candidate) => usedStatuses.has(candidate.id))) {
    const same = ours.find((candidate) => lower(candidate.name) === lower(status.name))
    const color = status.color && COLOR.test(status.color) ? status.color : null
    statuses[status.id] = same
      ? { status: same.id }
      : { create: { name: statusName(status.name), category: guessCategory(status), color } }
  }
  const types: Record<string, OpenProjectTypeTarget> = {}
  for (const wp of source.workPackages) {
    types[wp.typeId] ??= guessType(wp.typeName)
  }
  const mapped: Record<string, Assignee | null> = {}
  for (const [id, name] of source.people) {
    mapped[id] = guessPerson(name, agents, people)
  }
  return { statuses, types, people: mapped }
}

function checkStatusTarget(id: string, target: unknown, ours: Status[]): OpenProjectStatusTarget {
  const value = target as Record<string, unknown> | null
  if (value && typeof value.status === 'number') {
    if (!ours.some((status) => status.id === value.status)) {
      throw new TaskError(
        `Status mapping for OpenProject status ${id}: there is no status ${value.status} here (see status_list)`,
      )
    }
    return { status: value.status }
  }
  const create = (value?.create ?? null) as Record<string, unknown> | null
  if (
    create &&
    typeof create.name === 'string' &&
    create.name.trim() &&
    STATUS_CATEGORIES.includes(create.category as StatusCategory)
  ) {
    if (create.name.replace(/\s+/g, ' ').trim().length > STATUS_NAME_MAX) {
      throw new TaskError(
        `Status mapping for OpenProject status ${id}: a status name is at most ${STATUS_NAME_MAX} characters`,
      )
    }
    return {
      create: {
        name: statusName(create.name),
        category: create.category as StatusCategory,
        color: typeof create.color === 'string' && COLOR.test(create.color) ? create.color : null,
      },
    }
  }
  throw new TaskError(
    `Status mapping for OpenProject status ${id} must be {"status": <our status id>} or {"create": {"name", "category": ${STATUS_CATEGORIES.join('|')}, "color"}}`,
  )
}

function checkPersonTarget(id: string, target: unknown, agents: AgentInfo[], people: PersonInfo[]): Assignee | null {
  if (target === null) {
    return null
  }
  const value = target as Record<string, unknown>
  if (value?.kind === 'agent') {
    const agent = agents.find(
      (candidate) =>
        candidate.id === value.id ||
        (!value.id && typeof value.name === 'string' && lower(candidate.name) === lower(value.name)),
    )
    if (!agent) {
      throw new TaskError(
        `People mapping for OpenProject user ${id}: no agent ${JSON.stringify(value.id ?? value.name)} (see assignee_list)`,
      )
    }
    return { kind: 'agent', id: agent.id, name: agent.name }
  }
  if (value?.kind === 'person') {
    if (typeof value.id === 'string' && value.id) {
      const person = people.find((candidate) => candidate.id === value.id)
      if (!person) {
        throw new TaskError(
          `People mapping for OpenProject user ${id}: no person with id "${value.id}" (see assignee_list)`,
        )
      }
      return { kind: 'person', id: person.id, name: person.name }
    }
    if (typeof value.name === 'string' && value.name.trim()) {
      return { kind: 'person', name: value.name.trim() }
    }
  }
  throw new TaskError(
    `People mapping for OpenProject user ${id} must be null, {"kind": "agent", "id"} or {"kind": "person", "id" or "name"}`,
  )
}

/**
 * The mapping an import uses: the suggestion, overlaid with a saved mapping
 * and then with the caller's, entry by entry, each checked. Entries for
 * statuses, types or people the project does not use are dropped.
 */
export function resolveMapping(
  suggested: OpenProjectMapping,
  layers: Array<Partial<OpenProjectMapping> | null | undefined>,
  ours: Status[],
  agents: AgentInfo[],
  people: PersonInfo[],
): OpenProjectMapping {
  const result: OpenProjectMapping = {
    statuses: { ...suggested.statuses },
    types: { ...suggested.types },
    people: { ...suggested.people },
  }
  for (const layer of layers) {
    if (!layer) {
      continue
    }
    for (const [id, target] of Object.entries(layer.statuses ?? {})) {
      if (id in result.statuses) {
        result.statuses[id] = checkStatusTarget(id, target, ours)
      }
    }
    for (const [id, target] of Object.entries(layer.types ?? {})) {
      if (!(id in result.types)) {
        continue
      }
      if (target !== 'skip' && !TASK_TYPES.includes(target as TaskType)) {
        throw new TaskError(
          `Type mapping for OpenProject type ${id} must be one of: ${[...TASK_TYPES, 'skip'].join(', ')}`,
        )
      }
      result.types[id] = target
    }
    for (const [id, target] of Object.entries(layer.people ?? {})) {
      if (id in result.people) {
        result.people[id] = checkPersonTarget(id, target, agents, people)
      }
    }
  }
  return result
}

function countBy(
  items: SourceWorkPackage[],
  key: (wp: SourceWorkPackage) => string,
  name: (wp: SourceWorkPackage) => string,
): OpenProjectCount[] {
  const counts = new Map<string, OpenProjectCount>()
  for (const wp of items) {
    const id = key(wp)
    const entry = counts.get(id) ?? { id, name: name(wp), count: 0 }
    entry.count++
    counts.set(id, entry)
  }
  return [...counts.values()]
}

/** Work packages per type, in OpenProject's type order. */
export function typeCounts(source: SourceData): OpenProjectCount[] {
  const order = source.types.map((type) => type.id)
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length)
  return countBy(
    source.workPackages,
    (wp) => wp.typeId,
    (wp) => wp.typeName,
  ).sort((a, b) => rank(a.id) - rank(b.id))
}

/** Work packages per status, in OpenProject's status order. */
export function statusCounts(source: SourceData): OpenProjectStatusCount[] {
  const byId = new Map(source.statuses.map((status) => [status.id, status]))
  return countBy(
    source.workPackages,
    (wp) => wp.statusId,
    (wp) => wp.statusName,
  )
    .map((entry) => ({
      ...entry,
      isClosed: byId.get(entry.id)?.isClosed ?? false,
      color: byId.get(entry.id)?.color ?? null,
    }))
    .sort((a, b) => (byId.get(a.id)?.position ?? 0) - (byId.get(b.id)?.position ?? 0))
}

/** Everyone on a work package as assignee or author, most work packages first. */
export function peopleCounts(source: SourceData): OpenProjectCount[] {
  const counts = new Map<string, number>()
  for (const wp of source.workPackages) {
    for (const id of new Set([wp.assigneeId, wp.authorId])) {
      if (id) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
  }
  return [...source.people.entries()]
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Our priority for an OpenProject one, by its (default) name; anything else is medium. */
export function mapPriority(name: string | null): Priority {
  const wanted = lower(name ?? '')
  if (wanted === 'immediate' || wanted === 'urgent') {
    return 'highest'
  }
  if (wanted === 'normal') {
    return 'medium'
  }
  return PRIORITIES.includes(wanted as Priority) ? (wanted as Priority) : 'medium'
}

/**
 * A work package's dates as a task holds them: both or neither. A milestone's
 * single date, or a work package with only a start or only a finish, becomes a
 * one-day task on that date.
 */
export function mapDates(wp: Pick<SourceWorkPackage, 'startDate' | 'dueDate' | 'date'>): {
  start: string | null
  end: string | null
} {
  const start = wp.startDate ?? wp.date ?? wp.dueDate
  const end = wp.dueDate ?? wp.date ?? wp.startDate
  if (!start || !end) {
    return { start: null, end: null }
  }
  return end < start ? { start, end: start } : { start, end }
}

/**
 * OpenProject markdown as ours: a mention tag becomes its plain `@Name`, an
 * embedded image of an attachment imported here shows the copy (see
 * `pointAtCopies`), and any other link relative to the OpenProject server
 * points back at it.
 */
export function mapMarkdown(markdown: string, base: string, copies: ReadonlyMap<string, string> = new Map()): string {
  return pointAtCopies(markdown, base, copies)
    .replace(/<mention\b[^>]*?data-text="([^"]*)"[^>]*>[\s\S]*?<\/mention>/g, (_match, label: string) => label)
    .replace(/\]\((\/[^)\s]*)/g, (_match, path: string) => `](${base}${path}`)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Each image that embeds an OpenProject attachment, where that attachment
 * was imported here (`copies`: its OpenProject id to our attachment id),
 * as the reference the task page draws from our copy: `![name](attachment:<id>)`.
 * Both markdown images and HTML `<img>` tags, with the address relative or
 * absolute, as `/api/v3/attachments/<id>/content` or `/attachments/<id>/<name>`.
 * An image of an attachment not imported here, and a plain link, are left as
 * they are.
 */
export function pointAtCopies(text: string, base: string, copies: ReadonlyMap<string, string>): string {
  if (copies.size === 0 || !text.includes('attachments/')) {
    return text
  }
  const address = new RegExp(
    `^(?:${escapeRegExp(base)})?(?:/api/v3/attachments/(\\d+)/content|/attachments/(\\d+)(?:/[^\\s)"'<>]*)?)$`,
  )
  const copyOf = (url: string) => {
    const match = address.exec(url.trim())
    return match ? copies.get((match[1] ?? match[2]) as string) : undefined
  }
  const image = (name: string, id: string) => `![${name.replace(/[[\]\n]/g, ' ').trim()}](attachment:${id})`
  return text
    .replace(/!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (match, name: string, url: string) => {
      const id = copyOf(url)
      return id ? image(name, id) : match
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
      const id = src ? copyOf(src) : undefined
      return id ? image(/\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '', id) : tag
    })
}

/** The summary a task gets from a subject: one line, within our 500 characters. */
export function mapSummary(subject: string, id: number): string {
  const line = subject.replace(/\s+/g, ' ').trim()
  if (!line) {
    return `OpenProject work package #${id}`
  }
  return line.length > 500 ? `${line.slice(0, 499)}…` : line
}

/** How the import refers to a work package in its summary: `PROJ-12`, or `#41`. */
export const sourceLabel = (wp: Pick<SourceWorkPackage, 'id' | 'displayId'>) => wp.displayId ?? `#${wp.id}`

/** The number in `PROJ-12`, the id where there is no display id. */
export function sourceNumber(wp: Pick<SourceWorkPackage, 'id' | 'displayId'>): number {
  const match = wp.displayId ? /-(\d+)$/.exec(wp.displayId) : null
  return match ? Number(match[1]) : wp.id
}

/** OpenProject's note on a parent when a child changed: not something a person wrote. */
export const isAutomaticNote = (body: string) => /^_Updated automatically by /.test(body.trim())
