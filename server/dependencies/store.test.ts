import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { TasksEvent } from '../../shared/types.ts'
import { allMigrations, migrate } from '../db.ts'
import { type Scope, changeStatus, createTask, deleteTask, getTask, listTasks, moveTask } from '../service.ts'
import { linkTasks, unlinkTasks } from './store.ts'

interface TestScope extends Scope {
  events: Array<{ keys: string[]; kind: TasksEvent['kind'] }>
}

function makeScope(): TestScope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const events: TestScope['events'] = []
  return {
    db,
    instanceId: 'inst-1',
    projectKey: 'TASK',
    inv: { ctx: {} as never, actor: { kind: 'agent', name: 'Bob' } },
    notify: (keys, kind) => events.push({ keys, kind }),
    agents: async () => [],
    people: async () => [],
    events,
  }
}

async function tasks(scope: Scope, count: number): Promise<string[]> {
  const keys: string[] = []
  for (let i = 1; i <= count; i++) {
    keys.push((await createTask(scope, { summary: `Task ${i}` })).result.key)
  }
  return keys
}

test('a link shows on both tasks, in task_get and in every summary', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { from: a, to: b })

  const blocked = getTask(scope, b)
  assert.deepEqual(blocked.blockedBy.map((t) => t.key), [a])
  assert.deepEqual(blocked.blocks, [])
  assert.deepEqual(blocked.blockers, [{ key: a, open: true }])
  assert.deepEqual(getTask(scope, a).blocks.map((t) => t.key), [b])

  const listed = listTasks(scope).tasks
  assert.deepEqual(listed.find((t) => t.key === b)?.blockers, [{ key: a, open: true }])
  assert.deepEqual(listed.find((t) => t.key === a)?.blockers, [])
  assert.deepEqual(moveTask(scope, { key: b, before: a }).result.blockers, [{ key: a, open: true }])
})

test('a blocker whose status is done no longer counts as open', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { from: a, to: b })
  await changeStatus(scope, { key: a, status: 'Done' })
  assert.deepEqual(getTask(scope, b).blockers, [{ key: a, open: false }])
})

test('linking records history on both tasks and announces both', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  scope.events.length = 0
  linkTasks(scope, { from: a, to: b })
  assert.deepEqual(scope.events, [{ keys: [a, b], kind: 'task' }])
  const last = (key: string) => getTask(scope, key).activity.at(-1)
  assert.deepEqual([last(b)?.field, last(b)?.from, last(b)?.to], ['blocked by', null, a])
  assert.deepEqual([last(a)?.field, last(a)?.from, last(a)?.to], ['blocks', null, b])
})

test('linking a pair twice changes nothing the second time', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { from: a, to: b })
  const before = getTask(scope, b).activity.length
  scope.events.length = 0
  linkTasks(scope, { from: a, to: b })
  assert.equal(getTask(scope, b).activity.length, before)
  assert.deepEqual(scope.events, [])
  assert.equal(getTask(scope, b).blockedBy.length, 1)
})

test('a task cannot block itself', async () => {
  const scope = makeScope()
  const [a] = await tasks(scope, 1)
  assert.throws(() => linkTasks(scope, { from: a, to: a }), /TASK-1 cannot block itself/)
})

test('a link that would close a loop is refused, naming the loop', async () => {
  const scope = makeScope()
  const [a, b, c] = await tasks(scope, 3)
  linkTasks(scope, { from: a, to: b })
  linkTasks(scope, { from: b, to: c })
  assert.throws(
    () => linkTasks(scope, { from: c, to: a }),
    /TASK-3 cannot block TASK-1: that would make a loop \(TASK-1 → TASK-2 → TASK-3 → TASK-1\)/,
  )
  assert.throws(() => linkTasks(scope, { from: b, to: a }), /would make a loop \(TASK-1 → TASK-2 → TASK-1\)/)
  // A second path that is not a loop is fine.
  linkTasks(scope, { from: a, to: c })
  assert.deepEqual(getTask(scope, c).blockedBy.map((t) => t.key), [a, b])
})

test('unlinking removes the link and records it; a missing link is refused', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { from: a, to: b })
  unlinkTasks(scope, { from: a, to: b })
  assert.deepEqual(getTask(scope, b).blockers, [])
  const last = getTask(scope, b).activity.at(-1)
  assert.deepEqual([last?.field, last?.from, last?.to], ['blocked by', a, null])
  assert.throws(() => unlinkTasks(scope, { from: a, to: b }), /TASK-1 blocks TASK-2 is not recorded/)
})

test('each relation type shows on both tasks under its own name, and only blocks holds a task back', async () => {
  const scope = makeScope()
  const [a, b, c, d] = await tasks(scope, 4)
  linkTasks(scope, { type: 'follows', from: b, to: a })
  linkTasks(scope, { type: 'duplicates', from: c, to: a })
  linkTasks(scope, { type: 'relates', from: d, to: a })

  const first = getTask(scope, a)
  assert.deepEqual(
    [first.precedes, first.duplicatedBy, first.relatesTo, first.follows, first.duplicates, first.blockedBy].map((list) => list.map((t) => t.key)),
    [[b], [c], [d], [], [], []],
  )
  assert.deepEqual(getTask(scope, b).follows.map((t) => t.key), [a])
  assert.deepEqual(getTask(scope, c).duplicates.map((t) => t.key), [a])
  // Relates runs both ways: stored once, listed on both ends.
  assert.deepEqual(getTask(scope, d).relatesTo.map((t) => t.key), [a])
  assert.equal((scope.db.prepare("SELECT count(*) AS n FROM task_relation WHERE type = 'relates'").get() as { n: number }).n, 1)
  // None of them blocks: no blockers, in task_get or in a list.
  assert.deepEqual(first.blockers, [])
  assert.ok(listTasks(scope).tasks.every((task) => task.blockers.length === 0))

  const history = (key: string) => getTask(scope, key).activity.filter((entry) => entry.kind === 'field').map((entry) => [entry.field, entry.to])
  assert.deepEqual(history(a), [
    ['precedes', b],
    ['duplicated by', c],
    ['relates to', d],
  ])
  assert.deepEqual(history(b), [['follows', a]])
})

test('an inverse name reads from the other end, relates either way round is one relation, and unlinking needs the same relation', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { type: 'precedes', from: a, to: b })
  assert.deepEqual(getTask(scope, b).follows.map((t) => t.key), [a])
  linkTasks(scope, { type: 'blocked_by', from: b, to: a })
  assert.deepEqual(getTask(scope, b).blockers, [{ key: a, open: true }])

  linkTasks(scope, { type: 'relates', from: b, to: a })
  scope.events.length = 0
  linkTasks(scope, { type: 'relates', from: a, to: b })
  assert.deepEqual(scope.events, [], 'the same pair the other way round is already there')
  unlinkTasks(scope, { type: 'relates', from: a, to: b })
  assert.deepEqual(getTask(scope, a).relatesTo, [])

  assert.throws(() => unlinkTasks(scope, { type: 'duplicates', from: a, to: b }), /TASK-1 duplicates TASK-2 is not recorded/)
  unlinkTasks(scope, { type: 'follows', from: b, to: a })
  assert.deepEqual(getTask(scope, a).precedes, [])
  // Blocks is untouched by the others coming and going.
  assert.deepEqual(getTask(scope, b).blockers, [{ key: a, open: true }])
})

test('an unknown relation type and a task related to itself are refused; only blocks refuses a loop', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  assert.throws(() => linkTasks(scope, { type: 'parent' as never, from: a, to: b }), /"parent" is not a relation type; use one of: blocks, relates, duplicates, follows, blocked_by/)
  assert.throws(() => linkTasks(scope, { type: 'relates', from: a, to: a }), /TASK-1 cannot relate to itself/)
  assert.throws(() => linkTasks(scope, { type: 'follows', from: a, to: a }), /TASK-1 cannot follow itself/)
  linkTasks(scope, { type: 'duplicates', from: a, to: b })
  linkTasks(scope, { type: 'duplicates', from: b, to: a })
  assert.deepEqual(getTask(scope, a).duplicates.map((t) => t.key), [b])
  assert.deepEqual(getTask(scope, a).duplicatedBy.map((t) => t.key), [b])
})

test('the migration moves every blocks link over and drops the old table', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // The schema as it stood before this migration: everything listed ahead of it.
  const all = allMigrations()
  migrate(db, all.slice(0, all.findIndex((migration) => migration.id === 'dependencies-0002-relation-types')))
  const status = (db.prepare('SELECT id FROM status ORDER BY id LIMIT 1').get() as { id: number }).id
  const insert = db.prepare(
    "INSERT INTO task (number, summary, description, status_id, type, priority, reporter_kind, reporter_name, rank, created_at, updated_at) VALUES (?, 'x', '', ?, 'task', 'medium', 'person', 'p', ?, 't', 't')",
  )
  for (const n of [1, 2, 3]) insert.run(n, status, `r${n}`)
  db.exec("INSERT INTO task_link (blocker_id, blocked_id, created_at) VALUES (1, 2, 'then'), (2, 3, 'later')")

  migrate(db)
  assert.deepEqual(db.prepare('SELECT from_id, to_id, type, created_at FROM task_relation ORDER BY from_id').all().map((row) => ({ ...row })), [
    { from_id: 1, to_id: 2, type: 'blocks', created_at: 'then' },
    { from_id: 2, to_id: 3, type: 'blocks', created_at: 'later' },
  ])
  assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'task_link'").get() as { n: number }).n, 0)
})

test('deleting a task removes its links', async () => {
  const scope = makeScope()
  const [a, b] = await tasks(scope, 2)
  linkTasks(scope, { from: a, to: b })
  deleteTask(scope, { key: a })
  assert.deepEqual(getTask(scope, b).blockedBy, [])
  assert.deepEqual(getTask(scope, b).blockers, [])
})

test('keys from another project and unknown tasks are refused', async () => {
  const scope = makeScope()
  const [a] = await tasks(scope, 1)
  assert.throws(() => linkTasks(scope, { from: a, to: 'OTHER-2' }), /belongs to project OTHER/)
  assert.throws(() => linkTasks(scope, { from: a, to: 'TASK-9' }), /No task TASK-9/)
})
