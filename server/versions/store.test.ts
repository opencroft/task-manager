import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareVersionNames } from '../../shared/versions.ts'
import { makeScope } from '../attachments/testing.ts'
import { saveBoard } from '../boards/store.ts'
import { taskRow, versionRow } from '../compact.ts'
import { createTask, getTask, listTasks, updateTask } from '../service.ts'
import { saveView } from '../views/store.ts'
import { createVersion, listVersions, releaseVersion, updateVersion } from './store.ts'

test('names must be semver, unique, and sort by precedence', () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  assert.throws(() => createVersion(scope, { name: '1.4' }), /not a semantic version/)
  assert.throws(() => createVersion(scope, { name: '01.0.0' }), /not a semantic version/)
  createVersion(scope, { name: 'v1.10.0' })
  createVersion(scope, { name: '1.2.0' })
  createVersion(scope, { name: '1.10.0-rc.1' })
  assert.throws(() => createVersion(scope, { name: '1.2.0' }), /already exists/)
  assert.deepEqual(
    listVersions(scope).versions.map((version) => version.name),
    ['1.2.0', '1.10.0-rc.1', '1.10.0'],
  )
  assert.equal(compareVersionNames('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersionNames('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  assert.equal(compareVersionNames('1.0.0-rc.1', '1.0.0'), -1)
})

test('a task takes one version through update, with a history entry, and task_list filters by it', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createVersion(scope, { name: '1.0.0' })
  const a = (await createTask(scope, { summary: 'A', version: '1.0.0' })).result.key
  const b = (await createTask(scope, { summary: 'B' })).result.key
  assert.deepEqual(getTask(scope, a).version, { name: '1.0.0', state: 'planned' })
  await updateTask(scope, { key: b, version: 'v1.0.0' })
  await updateTask(scope, { key: a, version: null })
  const entry = getTask(scope, a)
    .activity.filter((item) => item.field === 'version')
    .at(-1)
  assert.deepEqual({ from: entry?.from, to: entry?.to }, { from: '1.0.0', to: null })
  assert.deepEqual(
    listTasks(scope, { version: ['1.0.0'] }).tasks.map((task) => task.key),
    [b],
  )
  assert.deepEqual(
    listTasks(scope, { version: ['none'] }).tasks.map((task) => task.key),
    [a],
  )
  assert.throws(() => listTasks(scope, { version: ['9.9.9'] }), /No version "9.9.9"/)
})

test('release dates the version, moves open tasks when asked, and returns notes by type', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createVersion(scope, { name: '1.0.0', description: 'First cut' })
  createVersion(scope, { name: '1.1.0' })
  const story = (await createTask(scope, { summary: 'Login', type: 'story', status: 'Done', version: '1.0.0' })).result
    .key
  const bug = (await createTask(scope, { summary: 'Crash on save', type: 'bug', status: 'Done', version: '1.0.0' }))
    .result.key
  const open = (await createTask(scope, { summary: 'Later', version: '1.0.0' })).result.key
  const { result } = releaseVersion(scope, { version: '1.0.0', date: '2026-09-26', moveOpenTo: '1.1.0' })
  assert.equal(result.version.state, 'released')
  assert.equal(result.version.releasedAt, '2026-09-26')
  assert.deepEqual(result.moved, { keys: [open], to: '1.1.0' })
  assert.deepEqual(getTask(scope, open).version, { name: '1.1.0', state: 'planned' })
  assert.equal(
    result.notes,
    [
      '## 1.0.0 (2026-09-26)',
      '',
      'First cut',
      '',
      '### Stories',
      `- ${story} Login`,
      '',
      '### Bugs',
      `- ${bug} Crash on save`,
    ].join('\n'),
  )
  assert.throws(() => releaseVersion(scope, { version: '1.0.0' }), /already released on 2026-09-26/)
})

test('compact rows: a task names its version, a version row drops what is empty', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  const created = createVersion(scope, { name: '3.0.0', targetDate: '2026-10-01' }).result
  const task = (await createTask(scope, { summary: 'T', version: '3.0.0' })).result
  assert.equal(taskRow(task).version, '3.0.0')
  assert.deepEqual(versionRow(listVersions(scope).versions[0] ?? created), {
    name: '3.0.0',
    state: 'planned',
    targetDate: '2026-10-01',
    open: 1,
  })
})

test('an archived version takes no more tasks; a rename follows into saved views and board filters', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createVersion(scope, { name: '2.0.0' })
  const owner = { key: 'person:Alice', name: 'Alice' }
  const view = saveView(
    scope.db,
    owner,
    { name: 'Two', page: 'tasks', filter: { version: ['2.0.0'] } },
    new Date().toISOString(),
  )
  const board = saveBoard(
    scope,
    { name: 'Not two', filter: { version: { exclude: ['2.0.0'] } } },
    new Date().toISOString(),
  )
  updateVersion(scope, { version: '2.0.0', name: '2.1.0' })
  const task = (await createTask(scope, { summary: 'X' })).result.key
  const saved = scope.db.prepare('SELECT filter FROM saved_view WHERE id = ?').get(view.id) as { filter: string }
  assert.deepEqual(JSON.parse(saved.filter), { version: { include: ['2.1.0'] } })
  const preset = scope.db.prepare('SELECT filter FROM board WHERE id = ?').get(board.id) as { filter: string }
  assert.deepEqual(JSON.parse(preset.filter), { version: { exclude: ['2.1.0'] } })
  updateVersion(scope, { version: '2.1.0', state: 'archived' })
  await assert.rejects(updateTask(scope, { key: task, version: '2.1.0' }), /archived/)
})
