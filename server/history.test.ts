import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { type TestContext, test } from 'node:test'

import type { Actor } from '../shared/types.ts'
import { compactTask } from './compact.ts'
import { migrate } from './db.ts'
import {
  activityTexts,
  addComment,
  changeStatus,
  createTask,
  getTask,
  HISTORY_MERGE_WINDOW_MS,
  moveTask,
  type Scope,
  updateTask,
} from './service.ts'

const START = Date.parse('2026-03-02T09:00:00.000Z')
const MINUTE = 60_000

const BOB: Actor = { kind: 'agent', name: 'Bob' }
const ALICE: Actor = { kind: 'agent', name: 'Alice' }
const BOB_PERSON: Actor = { kind: 'person', name: 'Bob' }

/** One project's database, written by whichever actor `as` returns a scope for. */
function project(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const as = (actor: Actor): Scope => ({
    db,
    instanceId: 'inst-1',
    projectKey: 'TASK',
    inv: { ctx: {} as never, actor },
    notify: () => {},
    agents: async () => [
      { id: 'agent_1', name: 'Bob' },
      { id: 'agent_2', name: 'Alice' },
    ],
    people: async () => [{ id: 'user_bob', name: 'Bob' }],
  })
  const fieldEntries = (field: string) =>
    getTask(as(BOB), 'TASK-1')
      .activity.filter((entry) => entry.kind === 'field' && entry.field === field)
      .map((entry) => ({ actor: entry.actor.name, from: entry.from, to: entry.to, at: entry.at }))
  const descriptionTexts = () =>
    activityTexts(as(BOB), { key: 'TASK-1' }).entries.map((entry) => [entry.from, entry.to])
  return { as, fieldEntries, descriptionTexts, tick: (ms: number) => t.mock.timers.tick(ms) }
}

const at = (ms: number) => new Date(START + ms).toISOString()

test('status changes within the window fold into one entry from the first value to the last', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Fold' })
  await changeStatus(bob, { key: 'TASK-1', status: 'In Progress' })
  tick(MINUTE)
  await changeStatus(bob, { key: 'TASK-1', status: 'In Review' })
  tick(MINUTE)
  await changeStatus(bob, { key: 'TASK-1', status: 'Done' })
  assert.deepEqual(fieldEntries('status'), [{ actor: 'Bob', from: 'To Do', to: 'Done', at: at(2 * MINUTE) }])
})

test('a field brought back to where it started within the window leaves no entry', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Back' })
  await changeStatus(bob, { key: 'TASK-1', status: 'In Progress' })
  tick(MINUTE)
  await changeStatus(bob, { key: 'TASK-1', status: 'To Do' })
  assert.deepEqual(fieldEntries('status'), [])
  // The next change starts a fresh entry.
  await changeStatus(bob, { key: 'TASK-1', status: 'Done' })
  assert.deepEqual(fieldEntries('status'), [{ actor: 'Bob', from: 'To Do', to: 'Done', at: at(MINUTE) }])
})

test('repeated date moves keep one dates entry, removed when the dates return', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Drag', startDate: '2026-03-02', endDate: '2026-03-06' })
  await updateTask(bob, { key: 'TASK-1', startDate: '2026-03-03', endDate: '2026-03-07' })
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', startDate: '2026-03-04', endDate: '2026-03-08' })
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', endDate: '2026-03-10' })
  const [entry] = fieldEntries('dates')
  assert.equal(fieldEntries('dates').length, 1)
  assert.equal(entry.at, at(2 * MINUTE))
  const original = entry.from
  assert.notEqual(original, entry.to)
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', startDate: '2026-03-02', endDate: '2026-03-06' })
  assert.deepEqual(fieldEntries('dates'), [])
})

test('the window runs from the entry’s last update; a change at the window’s end starts a new entry', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Window' })
  await updateTask(bob, { key: 'TASK-1', priority: 'high' })
  tick(4 * MINUTE)
  await updateTask(bob, { key: 'TASK-1', priority: 'highest' })
  tick(4 * MINUTE)
  // Eight minutes after the entry was made, four after its last update: still the same entry.
  await updateTask(bob, { key: 'TASK-1', priority: 'low' })
  assert.deepEqual(fieldEntries('priority'), [{ actor: 'Bob', from: 'medium', to: 'low', at: at(8 * MINUTE) }])
  tick(HISTORY_MERGE_WINDOW_MS)
  await updateTask(bob, { key: 'TASK-1', priority: 'medium' })
  assert.deepEqual(fieldEntries('priority'), [
    { actor: 'Bob', from: 'medium', to: 'low', at: at(8 * MINUTE) },
    { actor: 'Bob', from: 'low', to: 'medium', at: at(8 * MINUTE + HISTORY_MERGE_WINDOW_MS) },
  ])
})

test('another actor’s change to the field starts a new entry, and the first actor’s next change does too', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  await createTask(as(BOB), { summary: 'Turns' })
  await updateTask(as(BOB), { key: 'TASK-1', priority: 'high' })
  tick(MINUTE)
  await updateTask(as(ALICE), { key: 'TASK-1', priority: 'low' })
  tick(MINUTE)
  await updateTask(as(BOB), { key: 'TASK-1', priority: 'high' })
  tick(MINUTE)
  // A person who shares an agent's name is another actor.
  await updateTask(as(BOB_PERSON), { key: 'TASK-1', priority: 'lowest' })
  assert.deepEqual(
    fieldEntries('priority').map((entry) => [entry.actor, entry.from, entry.to]),
    [
      ['Bob', 'medium', 'high'],
      ['Alice', 'high', 'low'],
      ['Bob', 'low', 'high'],
      ['Bob', 'high', 'lowest'],
    ],
  )
})

test('each field folds on its own, and comments and subtask events are always added', async (t) => {
  const { as, fieldEntries, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Fields' })
  await createTask(bob, { summary: 'Child' })
  await changeStatus(bob, { key: 'TASK-1', status: 'In Progress' })
  await updateTask(bob, { key: 'TASK-1', priority: 'high' })
  await addComment(bob, { key: 'TASK-1', body: 'first' })
  tick(MINUTE)
  await changeStatus(bob, { key: 'TASK-1', status: 'Done' })
  await updateTask(bob, { key: 'TASK-1', priority: 'highest' })
  await addComment(bob, { key: 'TASK-1', body: 'second' })
  moveTask(bob, { key: 'TASK-2', parent: 'TASK-1' })
  moveTask(bob, { key: 'TASK-2', parent: null })
  moveTask(bob, { key: 'TASK-2', parent: 'TASK-1' })
  assert.deepEqual(
    fieldEntries('status').map((entry) => [entry.from, entry.to]),
    [['To Do', 'Done']],
  )
  assert.deepEqual(
    fieldEntries('priority').map((entry) => [entry.from, entry.to]),
    [['medium', 'highest']],
  )
  const task = getTask(bob, 'TASK-1')
  assert.deepEqual(
    task.comments.map((comment) => comment.body),
    ['first', 'second'],
  )
  assert.deepEqual(
    task.activity.filter((entry) => entry.kind !== 'field').map((entry) => [entry.kind, entry.from, entry.to]),
    [
      ['created', null, null],
      ['subtask_added', null, 'TASK-2'],
      ['subtask_removed', 'TASK-2', null],
      ['subtask_added', null, 'TASK-2'],
    ],
  )
})

test('description edits keep the previous and the new text, fold, and cancel out when the text returns', async (t) => {
  const { as, fieldEntries, descriptionTexts, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Text', description: 'one' })
  await updateTask(bob, { key: 'TASK-1', description: 'two' })
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', description: 'three\nlines' })
  assert.deepEqual(fieldEntries('description'), [{ actor: 'Bob', from: null, to: null, at: at(MINUTE) }])
  assert.deepEqual(descriptionTexts(), [['one', 'three\nlines']])
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', description: 'one' })
  assert.deepEqual(fieldEntries('description'), [])
  assert.deepEqual(descriptionTexts(), [])
})

test('a description first written on a task without one records the empty text as its start', async (t) => {
  const { as, descriptionTexts } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Blank' })
  await updateTask(bob, { key: 'TASK-1', description: 'Now it has one' })
  assert.deepEqual(descriptionTexts(), [['', 'Now it has one']])
})

test('a description entry stored without its texts stays as written when the next edit comes within the window', async (t) => {
  const { as, fieldEntries, descriptionTexts, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'Stored', description: 'one' })
  const taskId = (bob.db.prepare('SELECT id FROM task WHERE number = 1').get() as { id: number }).id
  bob.db
    .prepare(
      `INSERT INTO activity (task_id, actor_kind, actor_name, kind, field, from_value, to_value, at)
       VALUES (?, 'agent', 'Bob', 'field', 'description', NULL, NULL, ?)`,
    )
    .run(taskId, at(0))
  tick(MINUTE)
  await updateTask(bob, { key: 'TASK-1', description: 'two' })
  assert.deepEqual(
    fieldEntries('description').map((entry) => entry.at),
    [at(0), at(MINUTE)],
  )
  // Only the edit that kept its texts offers them.
  assert.deepEqual(
    getTask(bob, 'TASK-1')
      .activity.filter((entry) => entry.field === 'description')
      .map((entry) => entry.textsAvailable ?? false),
    [false, true],
  )
  assert.deepEqual(descriptionTexts(), [['one', 'two']])
})

/** A description far longer than any history entry's own fields: a few kilobytes of distinct lines. */
const longText = (label: string) =>
  Array.from({ length: 80 }, (_, line) => `${label} line ${line} of the description.`).join('\n')

test('a task read leaves every description text out of its history, compact and full, and marks the edits that have them', async (t) => {
  const { as, tick } = project(t)
  const bob = as(BOB)
  const texts = [longText('first'), longText('second'), longText('third'), longText('fourth')]
  await createTask(bob, { summary: 'Long', description: texts[0] })
  await changeStatus(bob, { key: 'TASK-1', status: 'In Progress' })
  // Three edit sessions: each starts after the window of the one before.
  for (const text of texts.slice(1)) {
    tick(HISTORY_MERGE_WINDOW_MS)
    await updateTask(bob, { key: 'TASK-1', description: text })
  }
  const full = getTask(bob, 'TASK-1')
  const answers = { full: full.activity, compact: compactTask(full, 5).activity ?? [] }
  for (const [shape, activity] of Object.entries(answers)) {
    const edits = activity.filter((entry) => entry.field === 'description')
    assert.equal(edits.length, 3, shape)
    for (const edit of edits) {
      assert.equal(edit.from, null, shape)
      assert.equal(edit.to, null, shape)
      assert.equal(edit.textsAvailable, true, shape)
      // An entry's size does not follow the description's: its id, actor, field, times and the flag.
      assert.ok(JSON.stringify(edit).length < 200, `${shape}: ${JSON.stringify(edit)}`)
    }
    const serialized = JSON.stringify(activity)
    for (const text of texts) {
      assert.ok(!serialized.includes(text.split('\n')[1]), `${shape} holds a description text`)
    }
    // Other fields keep their values, and carry no flag.
    const status = activity.find((entry) => entry.field === 'status')
    assert.deepEqual([status?.from, status?.to, status?.textsAvailable], ['To Do', 'In Progress', undefined], shape)
  }
  // The task a write returns is a task read too.
  tick(HISTORY_MERGE_WINDOW_MS)
  const written = await updateTask(bob, { key: 'TASK-1', description: texts[0] })
  assert.ok(!JSON.stringify(written.result.activity).includes(texts[3].split('\n')[1]))
  assert.deepEqual(
    activityTexts(bob, { key: 'TASK-1' }).entries.map((entry) => [entry.from, entry.to]),
    [
      [texts[0], texts[1]],
      [texts[1], texts[2]],
      [texts[2], texts[3]],
      [texts[3], texts[0]],
    ],
  )
})

test('activityTexts reads one description edit by its history id, and refuses an id that has no texts', async (t) => {
  const { as, tick } = project(t)
  const bob = as(BOB)
  await createTask(bob, { summary: 'One', description: 'one' })
  await updateTask(bob, { key: 'TASK-1', description: 'two' })
  tick(HISTORY_MERGE_WINDOW_MS)
  await updateTask(bob, { key: 'TASK-1', description: 'three' })
  await updateTask(bob, { key: 'TASK-1', priority: 'high' })
  const activity = getTask(bob, 'TASK-1').activity
  const second = activity.filter((entry) => entry.field === 'description')[1]
  assert.deepEqual(activityTexts(bob, { key: 'TASK-1', id: second.id }), {
    key: 'TASK-1',
    entries: [{ id: second.id, from: 'two', to: 'three' }],
  })
  const priority = activity.find((entry) => entry.field === 'priority')
  assert.throws(
    () => activityTexts(bob, { key: 'TASK-1', id: priority?.id as number }),
    /TASK-1 has no description edit \d+ with texts/,
  )
  assert.throws(() => activityTexts(bob, { key: 'TASK-1', id: 9999 }), /TASK-1 has no description edit 9999/)
  assert.throws(() => activityTexts(bob, { key: 'TASK-1', id: 1.5 }), /"id" must be a whole number/)
  // Another task's edit is not this task's.
  await createTask(bob, { summary: 'Other', description: 'x' })
  assert.throws(() => activityTexts(bob, { key: 'TASK-2', id: second.id }), /TASK-2 has no description edit/)
})
