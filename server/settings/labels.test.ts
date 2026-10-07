import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeScope } from '../attachments/testing.ts'
import { saveBoard } from '../boards/store.ts'
import { createTask, getTask } from '../service.ts'
import { saveView } from '../views/store.ts'
import { colorLabel, deleteLabel, labelOverview, mergeLabel, renameLabel } from './labels.ts'

async function setup() {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  const a = (await createTask(scope, { summary: 'A', labels: ['ui', 'backend'] })).result.key
  const b = (await createTask(scope, { summary: 'B', labels: ['ui', 'frontend'] })).result.key
  const c = (await createTask(scope, { summary: 'C', labels: ['frontend'] })).result.key
  scope.events.length = 0
  return { scope, a, b, c }
}

const labelsOf = (scope: ReturnType<typeof makeScope>, key: string) => getTask(scope, key).labels
const lastLabelEntry = (scope: ReturnType<typeof makeScope>, key: string) =>
  getTask(scope, key).activity.filter((entry) => entry.field === 'labels').at(-1)

test('the overview counts each label and carries its colour', async () => {
  const { scope } = await setup()
  colorLabel(scope, { label: 'frontend', color: 'blue' })
  assert.deepEqual(labelOverview(scope), [
    { name: 'backend', count: 1, color: null },
    { name: 'frontend', count: 2, color: 'blue' },
    { name: 'ui', count: 2, color: null },
  ])
})

test('rename rewrites every task, leaves a history entry on each, and takes the colour along', async () => {
  const { scope, a, b } = await setup()
  colorLabel(scope, { label: 'ui', color: 'pink' })
  const { result } = renameLabel(scope, { label: 'UI', to: '  design   system ' })
  assert.deepEqual(result, { label: { name: 'design system', count: 2, color: 'pink' }, tasks: 2 })
  assert.deepEqual(labelsOf(scope, a), ['backend', 'design system'])
  assert.deepEqual(labelsOf(scope, b), ['design system', 'frontend'])
  assert.deepEqual(
    { from: lastLabelEntry(scope, a)?.from, to: lastLabelEntry(scope, a)?.to, actor: lastLabelEntry(scope, a)?.actor.name },
    { from: 'backend, ui', to: 'backend, design system', actor: 'Alice' },
  )
  assert.deepEqual(scope.events.at(-1), { keys: [a, b], kind: 'task' })
})

test('rename onto another label is refused, whatever its case; a case-only rename of itself is not', async () => {
  const { scope, a } = await setup()
  assert.throws(() => renameLabel(scope, { label: 'ui', to: 'Frontend' }), /"frontend" already exists; merge "ui" into it instead/)
  assert.deepEqual(labelsOf(scope, a), ['backend', 'ui'])
  renameLabel(scope, { label: 'ui', to: 'UI' })
  assert.deepEqual(labelsOf(scope, a), ['backend', 'UI'])
})

test('merge moves the tasks over once, drops the merged label and its colour', async () => {
  const { scope, a, b, c } = await setup()
  colorLabel(scope, { label: 'ui', color: 'red' })
  colorLabel(scope, { label: 'frontend', color: 'green' })
  const { result } = mergeLabel(scope, { label: 'ui', into: 'frontend' })
  assert.deepEqual(result, { label: { name: 'frontend', count: 3, color: 'green' }, tasks: 2 })
  assert.deepEqual(labelsOf(scope, a), ['backend', 'frontend'])
  assert.deepEqual(labelsOf(scope, b), ['frontend'])
  assert.deepEqual(labelsOf(scope, c), ['frontend'])
  // A label born again later starts without the merged one's colour.
  await createTask(scope, { summary: 'D', labels: ['ui'] })
  assert.equal(labelOverview(scope).find((label) => label.name === 'ui')?.color, null)
  assert.throws(() => mergeLabel(scope, { label: 'frontend', into: 'FRONTEND' }), /cannot be merged into itself/)
})

test('delete removes the label from its tasks and nothing else', async () => {
  const { scope, a, b, c } = await setup()
  const { result } = deleteLabel(scope, { label: 'ui' })
  assert.deepEqual(result, { label: null, tasks: 2 })
  assert.deepEqual(labelsOf(scope, a), ['backend'])
  assert.deepEqual(labelsOf(scope, b), ['frontend'])
  assert.deepEqual(labelsOf(scope, c), ['frontend'])
  assert.equal(lastLabelEntry(scope, b)?.to, 'frontend')
  assert.deepEqual(
    labelOverview(scope).map((label) => label.name),
    ['backend', 'frontend'],
  )
})

test('saved views and board filters that include or exclude a label follow a rename, a merge and a delete', async () => {
  const { scope } = await setup()
  const owner = { key: 'person:m', name: 'Alice' }
  const at = '2026-09-26T16:00:00.000Z'
  const one = saveView(scope.db, owner, { page: 'tasks', name: 'UI work', filter: { label: ['ui', 'frontend'], query: 'x' } }, at)
  const two = saveView(scope.db, owner, { page: 'board', name: 'Backend', filter: { label: { exclude: ['backend'] } } }, at)
  const board = saveBoard(scope, { name: 'Not backend', filter: { label: { include: ['ui'], exclude: ['backend'] } } }, at)
  const filterOf = (table: 'saved_view' | 'board', id: string) =>
    JSON.parse((scope.db.prepare(`SELECT filter FROM ${table} WHERE id = ?`).get(id) as { filter: string }).filter)

  renameLabel(scope, { label: 'backend', to: 'server' })
  assert.deepEqual(filterOf('saved_view', two.id), { label: { exclude: ['server'] } })
  assert.deepEqual(filterOf('board', board.id), { label: { include: ['ui'], exclude: ['server'] } })
  mergeLabel(scope, { label: 'ui', into: 'frontend' })
  assert.deepEqual(filterOf('saved_view', one.id), { label: { include: ['frontend'] }, query: 'x' })
  assert.deepEqual(filterOf('board', board.id), { label: { include: ['frontend'], exclude: ['server'] } })
  deleteLabel(scope, { label: 'server' })
  assert.deepEqual(filterOf('saved_view', two.id), {})
  assert.deepEqual(filterOf('board', board.id), { label: { include: ['frontend'] } })
})

test('a colour is a palette name or null, and a missing label is named with the close ones', async () => {
  const { scope } = await setup()
  assert.throws(() => colorLabel(scope, { label: 'ui', color: '#ff0000' }), /color must be one of: gray, red/)
  colorLabel(scope, { label: 'ui', color: 'teal' })
  assert.deepEqual(scope.events.at(-1), { keys: [], kind: 'label' })
  colorLabel(scope, { label: 'ui', color: null })
  assert.equal(labelOverview(scope).find((label) => label.name === 'ui')?.color, null)
  assert.throws(() => deleteLabel(scope, { label: 'fronted' }), /No label "fronted" on any task\. Did you mean "frontend"/)
  assert.throws(() => renameLabel(scope, { label: 'ui', to: 'x'.repeat(51) }), /longer than 50 characters/)
})
