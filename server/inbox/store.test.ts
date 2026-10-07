import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'

import type { Actor } from '../../shared/types.ts'
import { allMigrations, migrate } from '../db.ts'
import { type TaskEvent, onTaskEvent } from '../hooks.ts'
import { type Scope, addComment, changeStatus, createTask, deleteTask, updateTask } from '../service.ts'
import { type Directory, deliver, excerptOf, listInbox, markRead, markUnread, mentionedIn, recipientKey, setMuted } from './store.ts'

const dir: Directory = {
  agents: async () => [
    { id: 'agent_qa', name: 'Ace (QA)' },
    { id: 'agent_ace', name: 'Ace' },
    { id: 'agent_bob', name: 'Bob' },
  ],
  people: async () => [
    { id: 'u_ada', name: 'Ada Lovelace' },
    { id: 'u_grace', name: 'Grace Hopper' },
    { id: 'u_alan1', name: 'Alan' },
    { id: 'u_alan2', name: 'alan' },
  ],
}

const NOW = '2026-09-26T09:00:00.000Z'
const ADA: Actor = { kind: 'person', name: 'Ada Lovelace' }

function makeScope(actor: Actor = ADA): Scope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, allMigrations())
  return { db, instanceId: 'inst-1', projectKey: 'TASK', inv: { ctx: {} as never, actor }, notify: () => {}, ...dir }
}

const as = (scope: Scope, actor: Actor): Scope => ({ ...scope, inv: { ...scope.inv, actor } })

let off: Array<() => void> = []
afterEach(() => {
  for (const fn of off) {
    fn()
  }
  off = []
})

test('a recipient is keyed by id; a name resolves only when exactly one has it', async () => {
  assert.equal(await recipientKey(dir, { kind: 'agent', id: 'agent_x', name: 'Renamed' }), 'agent:agent_x')
  assert.equal(await recipientKey(dir, { kind: 'agent', name: 'ace (qa)' }), 'agent:agent_qa')
  assert.equal(await recipientKey(dir, { kind: 'person', name: 'Grace Hopper' }), 'person:u_grace')
  assert.equal(await recipientKey(dir, { kind: 'person', name: 'Alan' }), null, 'two people named Alan')
  assert.equal(await recipientKey(dir, { kind: 'person', name: 'Someone Else' }), null, 'free text has no inbox')
})

test('mentions: full names longest first, a first name only one has, never an e-mail address', async () => {
  const names = async (body: string) => (await mentionedIn(body, dir)).map((p) => p.name)
  assert.deepEqual(await names('@Ace (QA) please check, and @ace too'), ['Ace (QA)', 'Ace'])
  assert.deepEqual(await names('thanks @Ada! cc @grace hopper.'), ['Ada Lovelace', 'Grace Hopper'])
  assert.deepEqual(await names('@Alan is ambiguous; mail ada@example.com; @Boba is nobody'), [])
  assert.deepEqual(await names('@Bob, @Bob'), ['Bob'])
})

test('delivery skips the actor, resolves roles, and lists newest first with the unread total', async () => {
  const s = makeScope()
  await createTask(as(s, { kind: 'agent', name: 'Bob' }), { summary: 'Fix login', type: 'bug' })
  await createTask(s, { summary: 'Other' })
  const draft = { kind: 'status_changed' as const, taskNumber: 1, recipients: ['reporter' as const, 'assignee' as const] }
  // Reporter Bob (agent); no assignee yet.
  assert.deepEqual(await deliver(s.db, dir, { ...draft, actor: { kind: 'person', name: 'Ada Lovelace' } }, NOW), ['agent:agent_bob'])
  // Bob moving their own task is not news to them.
  assert.deepEqual(await deliver(s.db, dir, { ...draft, actor: { kind: 'agent', name: 'Bob' } }, NOW), [])
  await deliver(
    s.db,
    dir,
    {
      kind: 'mentioned',
      taskNumber: 2,
      recipients: [{ kind: 'agent', id: 'agent_bob', name: 'Bob' }],
      actor: ADA,
      excerpt: 'look',
    },
    NOW,
  )
  const page = listInbox(s.db, 'TASK', 'agent:agent_bob')
  assert.equal(page.unread, 2)
  assert.equal(page.nextBefore, null)
  assert.deepEqual(
    page.items.map((n) => [n.kind, n.task.key, n.task.type, n.actor?.name, n.read, n.excerpt]),
    [
      ['mentioned', 'TASK-2', 'task', 'Ada Lovelace', false, 'look'],
      ['status_changed', 'TASK-1', 'bug', 'Ada Lovelace', false, undefined],
    ],
  )
  assert.deepEqual(listInbox(s.db, 'TASK', 'person:u_ada').items, [], 'another inbox is separate')
})

test('filter, paging, mark read: ids of someone else are ignored; a deleted task takes its notifications', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'A' })
  await createTask(s, { summary: 'B' })
  const bob = { kind: 'agent' as const, id: 'agent_bob', name: 'Bob' }
  for (const kind of ['assigned', 'mentioned', 'step_open', 'status_changed', 'workflow_finished'] as const) {
    await deliver(s.db, dir, { kind, taskNumber: kind === 'assigned' ? 2 : 1, recipients: [bob], actor: null }, NOW)
  }
  await deliver(s.db, dir, { kind: 'assigned', taskNumber: 1, recipients: [{ kind: 'person', id: 'u_grace', name: 'Grace' }], actor: null }, NOW)

  const kinds = (filter: Parameters<typeof listInbox>[3]) => listInbox(s.db, 'TASK', 'agent:agent_bob', filter).items.map((n) => n.kind)
  assert.deepEqual(kinds({ filter: 'workflows' }), ['workflow_finished', 'step_open'])
  assert.deepEqual(kinds({ filter: 'mentions' }), ['mentioned'])
  assert.throws(() => kinds({ filter: 'bogus' as never }), /Filters: all, assigned, mentions, workflows, status/)

  const first = listInbox(s.db, 'TASK', 'agent:agent_bob', { limit: 2 })
  assert.deepEqual(first.items.map((n) => n.kind), ['workflow_finished', 'status_changed'])
  const second = listInbox(s.db, 'TASK', 'agent:agent_bob', { limit: 2, before: first.nextBefore! })
  assert.deepEqual(second.items.map((n) => n.kind), ['step_open', 'mentioned'])
  const last = listInbox(s.db, 'TASK', 'agent:agent_bob', { limit: 2, before: second.nextBefore! })
  assert.deepEqual([last.items.map((n) => n.kind), last.nextBefore], [['assigned'], null])

  const graces = listInbox(s.db, 'TASK', 'person:u_grace').items.map((n) => n.id)
  assert.deepEqual(markRead(s.db, 'agent:agent_bob', { ids: [first.items[0]!.id, ...graces] }, NOW), { unread: 4 })
  assert.equal(listInbox(s.db, 'TASK', 'person:u_grace').unread, 1, "Grace's stays unread")
  assert.equal(listInbox(s.db, 'TASK', 'agent:agent_bob').items[0]?.read, true)
  assert.throws(() => markRead(s.db, 'agent:agent_bob', { ids: [] }, NOW), /ids \(from inbox_list\)|all: true/)
  assert.deepEqual(markRead(s.db, 'agent:agent_bob', { all: true }, NOW), { unread: 0 })

  deleteTask(s, { key: 'TASK-1' })
  assert.deepEqual(listInbox(s.db, 'TASK', 'agent:agent_bob').items.map((n) => n.task.key), ['TASK-2'])
})

test('mark unread: only your own; a muted task sends you nothing new until unmuted', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'A' })
  const bob = { kind: 'agent' as const, id: 'agent_bob', name: 'Bob' }
  const grace = { kind: 'person' as const, id: 'u_grace', name: 'Grace' }
  await deliver(s.db, dir, { kind: 'mentioned', taskNumber: 1, recipients: [bob, grace], actor: null }, NOW)
  const [mine] = listInbox(s.db, 'TASK', 'agent:agent_bob').items
  const [hers] = listInbox(s.db, 'TASK', 'person:u_grace').items
  markRead(s.db, 'agent:agent_bob', { all: true }, NOW)
  markRead(s.db, 'person:u_grace', { all: true }, NOW)
  assert.deepEqual(markUnread(s.db, 'agent:agent_bob', { ids: [mine!.id, hers!.id] }), { unread: 1 })
  assert.equal(listInbox(s.db, 'TASK', 'person:u_grace').unread, 0, "Grace's stays read")
  assert.throws(() => markUnread(s.db, 'agent:agent_bob', { ids: [] }), /ids/)

  assert.deepEqual(setMuted(s.db, 'TASK', 'agent:agent_bob', { task: 'task-1', muted: true }, NOW), { task: 'TASK-1', muted: true })
  // Muting twice is the same as once.
  setMuted(s.db, 'TASK', 'agent:agent_bob', { task: 'TASK-1', muted: true }, NOW)
  assert.equal(listInbox(s.db, 'TASK', 'agent:agent_bob').items[0]?.muted, true)
  assert.equal(listInbox(s.db, 'TASK', 'person:u_grace').items[0]?.muted, undefined, 'a mute is per recipient')
  assert.deepEqual(await deliver(s.db, dir, { kind: 'status_changed', taskNumber: 1, recipients: [bob, grace], actor: null }, NOW), ['person:u_grace'])

  setMuted(s.db, 'TASK', 'agent:agent_bob', { task: 'TASK-1', muted: false }, NOW)
  assert.deepEqual(await deliver(s.db, dir, { kind: 'status_changed', taskNumber: 1, recipients: [bob], actor: null }, NOW), ['agent:agent_bob'])
  assert.throws(() => setMuted(s.db, 'TASK', 'agent:agent_bob', { task: 'TASK-9', muted: true }, NOW), /No task "TASK-9"/)
  assert.throws(() => setMuted(s.db, 'TASK', 'agent:agent_bob', { task: 'TASK-1', muted: 'yes' as never }, NOW), /muted: true/)
})

test('read notifications older than 90 days go when the recipient gets a new one', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'A' })
  const bob = { kind: 'agent' as const, id: 'agent_bob', name: 'Bob' }
  await deliver(s.db, dir, { kind: 'assigned', taskNumber: 1, recipients: [bob], actor: null }, '2026-01-01T00:00:00.000Z')
  await deliver(s.db, dir, { kind: 'mentioned', taskNumber: 1, recipients: [bob], actor: null }, '2026-01-02T00:00:00.000Z')
  markRead(s.db, 'agent:agent_bob', { ids: [listInbox(s.db, 'TASK', 'agent:agent_bob').items.at(-1)!.id] }, NOW)
  await deliver(s.db, dir, { kind: 'step_open', taskNumber: 1, recipients: [bob], actor: null }, NOW)
  assert.deepEqual(
    listInbox(s.db, 'TASK', 'agent:agent_bob').items.map((n) => n.kind),
    ['step_open', 'mentioned'],
    'the old read one went; the old unread one stays',
  )
})

test('excerpts are one line, cut at a word', () => {
  assert.equal(excerptOf('  line one\n\nline two  '), 'line one line two')
  const long = excerptOf(`${'word '.repeat(100)}`)
  assert.ok(long.length <= 281 && long.endsWith('word…'), long)
})

test('the task model announces assignments and comments once committed', async () => {
  const events: TaskEvent[] = []
  off.push(onTaskEvent((event) => void events.push(event)))
  const s = makeScope()
  await createTask(s, { summary: 'A', assignee: 'Bob' })
  await createTask(s, { summary: 'B' })
  await updateTask(s, { key: 'TASK-2', assignee: 'Grace Hopper' })
  await updateTask(s, { key: 'TASK-2', assignee: 'Grace Hopper', summary: 'B2' })
  await addComment(s, { key: 'TASK-1', body: 'hi @Bob' })
  await changeStatus(s, { key: 'TASK-1', status: 'Done', comment: 'shipped' })
  await changeStatus(s, { key: 'TASK-1', status: 'To Do' })
  assert.deepEqual(
    events.map((e) => [e.kind, e.task.key, e.kind === 'assigned' ? e.assignee.name : e.comment.body, e.actor.name]),
    [
      ['assigned', 'TASK-1', 'Bob', 'Ada Lovelace'],
      ['assigned', 'TASK-2', 'Grace Hopper', 'Ada Lovelace'],
      ['commented', 'TASK-1', 'hi @Bob', 'Ada Lovelace'],
      ['commented', 'TASK-1', 'shipped', 'Ada Lovelace'],
    ],
    'an unchanged assignee and a status change without a comment announce nothing',
  )
})
