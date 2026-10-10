// The inbox's storage and addressing. Pure: a database and a
// directory of agents and people in, rows out — the host is reached only
// through ./index.ts, so this module runs under `node --test`.
//
// A recipient is keyed by a durable id — 'person:<directory user id>' or
// 'agent:<agent node id>' — so a rename keeps the inbox. Names are resolved to
// ids against the directory when a notification is made; a person named in
// free text, who is in no directory and cannot sign in, has no inbox.

import type { ActionInputs } from '../../shared/action-inputs.ts'
import {
  INBOX_FILTERS,
  type InboxFilter,
  type InboxListResult,
  type NotificationStatus,
  type TaskNotification,
  type TaskNotificationKind,
} from '../../shared/inbox.ts'
import type { Actor, Status, TaskType } from '../../shared/types.ts'
import { type Db, transaction } from '../db.ts'

/** Someone a notification can be about or for. `id` is the agent node id or directory user id, when known. */
export interface Party {
  kind: 'agent' | 'person'
  id?: string | null
  name: string
}

/** Who exists: the agents and the people of the host's directory. */
export interface Directory {
  agents(): Promise<Array<{ id: string; name: string }>>
  people(): Promise<Array<{ id: string; name: string }>>
}

/** A recipient by party, or by the role they have on the task. */
export type Addressee = Party | 'reporter' | 'assignee'

export interface NotificationDraft {
  kind: TaskNotificationKind
  taskNumber: number
  recipients: Addressee[]
  /** Who did it; never notified of their own action. Null for the workflow engine. */
  actor: Party | null
  workflow?: { name: string }
  step?: { name: string }
  from?: NotificationStatus
  to?: NotificationStatus
  excerpt?: string
}

/** Read notifications older than this are dropped when the recipient gets a new one. */
const KEEP_READ_MS = 90 * 24 * 60 * 60 * 1000
const EXCERPT_MAX = 280
const LIMIT_DEFAULT = 30
const LIMIT_MAX = 100

export class InboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InboxError'
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The inbox key of a party, or null when it has none (free-text person, unknown agent). */
export async function recipientKey(dir: Directory, party: Party): Promise<string | null> {
  if (party.id) {
    return `${party.kind}:${party.id}`
  }
  const list = party.kind === 'agent' ? await dir.agents() : await dir.people()
  const matches = list.filter((entry) => same(entry.name, party.name))
  // Two people with one name cannot be told apart by it: neither gets it rather than the wrong one.
  return matches.length === 1 ? `${party.kind}:${matches[0].id}` : null
}

/** A status as notifications keep it. */
export function statusSnapshot(status: Pick<Status, 'name' | 'category' | 'color'>): NotificationStatus {
  return { name: status.name, category: status.category, color: status.color ?? null }
}

/** A comment as an excerpt: one line of plain-ish text, cut at a word. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= EXCERPT_MAX) {
    return flat
  }
  const cut = flat.slice(0, EXCERPT_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

interface TaskPartiesRow {
  id: number
  reporter_kind: 'agent' | 'person'
  reporter_name: string
  assignee_kind: 'agent' | 'person' | null
  assignee_id: string | null
  assignee_name: string | null
}

/**
 * Record one notification for each of its recipients, except the actor.
 * Returns the recipient keys it was delivered to (empty when nobody had an
 * inbox for it).
 */
export async function deliver(db: Db, dir: Directory, draft: NotificationDraft, now: string): Promise<string[]> {
  const task = db
    .prepare(
      'SELECT id, reporter_kind, reporter_name, assignee_kind, assignee_id, assignee_name FROM task WHERE number = ?',
    )
    .get(draft.taskNumber) as TaskPartiesRow | undefined
  if (!task) {
    return []
  }
  const parties: Party[] = []
  for (const to of draft.recipients) {
    if (to === 'reporter') {
      parties.push({ kind: task.reporter_kind, name: task.reporter_name })
    } else if (to === 'assignee') {
      if (task.assignee_kind && task.assignee_name) {
        parties.push({ kind: task.assignee_kind, id: task.assignee_id, name: task.assignee_name })
      }
    } else {
      parties.push(to)
    }
  }
  const actorKey = draft.actor ? await recipientKey(dir, draft.actor) : null
  // Every producer comes through here, so a mute holds for all of them.
  const muted = new Set(
    (db.prepare('SELECT recipient FROM inbox_mute WHERE task_id = ?').all(task.id) as Array<{ recipient: string }>).map(
      (row) => row.recipient,
    ),
  )
  const keys = new Set<string>()
  for (const party of parties) {
    const key = await recipientKey(dir, party)
    if (key && key !== actorKey && !muted.has(key)) {
      keys.add(key)
    }
  }
  if (keys.size === 0) {
    return []
  }
  const detail: Record<string, unknown> = {}
  for (const field of ['workflow', 'step', 'from', 'to', 'excerpt'] as const) {
    if (draft[field] !== undefined) {
      detail[field] = draft[field]
    }
  }
  const expired = new Date(Date.parse(now) - KEEP_READ_MS).toISOString()
  transaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO inbox (recipient, kind, task_id, actor_kind, actor_name, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const prune = db.prepare('DELETE FROM inbox WHERE recipient = ? AND read_at IS NOT NULL AND created_at < ?')
    for (const key of keys) {
      insert.run(
        key,
        draft.kind,
        task.id,
        draft.actor?.kind ?? null,
        draft.actor?.name ?? null,
        JSON.stringify(detail),
        now,
      )
      prune.run(key, expired)
    }
  })
  return [...keys]
}

interface InboxRow {
  id: number
  kind: TaskNotificationKind
  actor_kind: 'agent' | 'person' | null
  actor_name: string | null
  detail: string
  created_at: string
  read_at: string | null
  muted: number
  number: number
  summary: string
  type: TaskType
}

function unreadCount(db: Db, recipient: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE recipient = ? AND read_at IS NULL').get(recipient) as {
      n: number
    }
  ).n
}

function cleanId(value: string, field: string): number {
  const text = value.trim()
  if (!/^\d+$/.test(text)) {
    throw new InboxError(`${field} "${text}" is not a notification id; ids come from inbox_list`)
  }
  return Number(text)
}

/** One page of a recipient's inbox, newest first. */
export function listInbox(
  db: Db,
  projectKey: string,
  recipient: string,
  input: ActionInputs['inbox_list'] = {},
): InboxListResult {
  const filter: InboxFilter = input.filter ?? 'all'
  const limit = input.limit === undefined ? LIMIT_DEFAULT : Math.trunc(input.limit)
  if (!Number.isFinite(limit) || limit < 1 || limit > LIMIT_MAX) {
    throw new InboxError(`limit is 1–${LIMIT_MAX}`)
  }
  const where = ['i.recipient = ?']
  const args: Array<string | number> = [recipient]
  const kinds = INBOX_FILTERS[filter]
  if (kinds) {
    where.push(`i.kind IN (${kinds.map(() => '?').join(', ')})`)
    args.push(...kinds)
  }
  if (input.before !== undefined && input.before !== '') {
    where.push('i.id < ?')
    args.push(cleanId(input.before, 'before'))
  }
  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.actor_kind, i.actor_name, i.detail, i.created_at, i.read_at, t.number, t.summary, t.type,
         m.task_id IS NOT NULL AS muted
       FROM inbox i JOIN task t ON t.id = i.task_id
       LEFT JOIN inbox_mute m ON m.recipient = i.recipient AND m.task_id = i.task_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as unknown as InboxRow[]
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => toNotification(projectKey, row)),
    unread: unreadCount(db, recipient),
    nextBefore: rows.length > limit && last ? String(last.id) : null,
  }
}

function toNotification(projectKey: string, row: InboxRow): TaskNotification {
  const detail = JSON.parse(row.detail) as Partial<TaskNotification>
  return {
    id: String(row.id),
    kind: row.kind,
    createdAt: row.created_at,
    read: row.read_at !== null,
    actor: row.actor_kind && row.actor_name ? { kind: row.actor_kind, name: row.actor_name } : null,
    task: { key: `${projectKey}-${row.number}`, summary: row.summary, type: row.type },
    ...detail,
    ...(row.muted ? { muted: true } : {}),
  }
}

/** Mark some or all of a recipient's notifications read. Ids of anyone else's are ignored. */
export function markRead(
  db: Db,
  recipient: string,
  input: ActionInputs['inbox_mark_read'],
  now: string,
): { unread: number } {
  const { all, ids } = input
  if (all === true) {
    db.prepare('UPDATE inbox SET read_at = ? WHERE recipient = ? AND read_at IS NULL').run(now, recipient)
  } else if (ids && ids.length > 0) {
    const numbers = ids.map((id) => cleanId(id, 'id'))
    db.prepare(
      `UPDATE inbox SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND id IN (${numbers.map(() => '?').join(', ')})`,
    ).run(now, recipient, ...numbers)
  } else {
    throw new InboxError('Pass ids (from inbox_list) to mark those read, or all: true for every one')
  }
  return { unread: unreadCount(db, recipient) }
}

/** Mark some of a recipient's notifications unread again. Ids of anyone else's are ignored. */
export function markUnread(db: Db, recipient: string, input: ActionInputs['inbox_mark_unread']): { unread: number } {
  const { ids } = input
  if (ids.length === 0) {
    throw new InboxError('Pass ids (from inbox_list) to mark those unread')
  }
  const numbers = ids.map((id) => cleanId(id, 'id'))
  db.prepare(
    `UPDATE inbox SET read_at = NULL WHERE recipient = ? AND id IN (${numbers.map(() => '?').join(', ')})`,
  ).run(recipient, ...numbers)
  return { unread: unreadCount(db, recipient) }
}

/** Mute or unmute a task for one recipient. */
export function setMuted(
  db: Db,
  projectKey: string,
  recipient: string,
  input: ActionInputs['inbox_mute'],
  now: string,
): { task: string; muted: boolean } {
  const match = new RegExp(`^${projectKey}-(\\d+)$`, 'i').exec(input.task.trim())
  const task = match
    ? (db.prepare('SELECT id FROM task WHERE number = ?').get(Number(match[1])) as { id: number } | undefined)
    : undefined
  if (!task || !match) {
    throw new InboxError(`No task "${input.task}" in ${projectKey}`)
  }
  if (input.muted) {
    db.prepare('INSERT OR IGNORE INTO inbox_mute (recipient, task_id, created_at) VALUES (?, ?, ?)').run(
      recipient,
      task.id,
      now,
    )
  } else {
    db.prepare('DELETE FROM inbox_mute WHERE recipient = ? AND task_id = ?').run(recipient, task.id)
  }
  return { task: `${projectKey}-${match[1]}`, muted: input.muted }
}

/** The actor of a task-model event as a party. */
export function actorParty(actor: Actor, personId?: string | null): Party {
  return { kind: actor.kind, id: actor.kind === 'person' ? (personId ?? null) : null, name: actor.name }
}
