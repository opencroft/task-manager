import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { withDetail } from '../compact.ts'
import { migrate } from '../db.ts'
import { deliver } from '../inbox/store.ts'
import { type Viewer, mergeMyWork, myWork } from '../my-work/store.ts'
import { type Scope, createTask, listTasks, updateTask } from '../service.ts'
import { type ProjectInstance, acrossProjects, scoped } from './across.ts'
import { acrossListInput, mergeTaskLists } from './task-list.ts'

const ADA: Viewer = { kind: 'person', id: 'u-ada', name: 'Ada Lovelace' }
const NOW = new Date('2026-09-26T10:00:00Z')

function makeScope(projectKey: string): Scope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return {
    db,
    instanceId: `inst-${projectKey}`,
    projectKey,
    inv: { ctx: {} as never, actor: { kind: 'person', name: 'Ada Lovelace' } },
    notify: () => {},
    agents: async () => [],
    people: async () => [{ id: 'u-ada', name: 'Ada Lovelace' }],
  }
}

function instance(key: string, slug = key.toLowerCase()): ProjectInstance {
  return { instanceId: `inst-${key}`, spaceSlug: 'work', name: `${key} project`, slug, params: { id: key }, dataDir: '/nowhere' }
}

const ref = (key: string) => ({ key, name: `${key} project`, app: `work.${key.toLowerCase()}` })

test('every project is read in order, a failing one is reported and the rest still answer', async () => {
  const across = await acrossProjects([instance('ONE'), instance('TWO'), instance('THREE')], (i) => {
    if (i.params.id === 'TWO') {
      throw new Error('database is locked')
    }
    return i.params.id
  })
  assert.deepEqual(across.parts, [
    { project: ref('ONE'), value: 'ONE' },
    { project: ref('THREE'), value: 'THREE' },
  ])
  assert.deepEqual(across.projects, { read: 3, total: 3, unavailable: [{ ...ref('TWO'), error: 'database is locked' }] })
})

test('past the cap no project is read, and the answer says how many there were', async () => {
  const instances = Array.from({ length: 5 }, (_, n) => instance(`P${n}`))
  const reads: string[] = []
  const across = await acrossProjects(instances, (i) => reads.push(i.params.id ?? ''), 3)
  assert.deepEqual(reads, ['P0', 'P1', 'P2'])
  assert.deepEqual(across.projects, { read: 3, total: 5 })
})

test('no project at all is an empty answer that says so, not a failure', async () => {
  const across = await acrossProjects([], () => 'never')
  assert.deepEqual(across, { parts: [], projects: { read: 0, total: 0 } })
})

test('across projects, filters of one project are refused by name and the page is bounded', () => {
  assert.throws(() => acrossListInput({ status: ['Done'], parent: 'none' }), /"status", "parent" cannot be used: they name something of one project/)
  assert.throws(() => acrossListInput({ limit: 201 }), /limit is 1–200 with scope "all"/)
  assert.deepEqual(acrossListInput({ query: 'x', statusCategory: ['todo'], scope: 'all' }), {
    perProject: { query: 'x', statusCategory: ['todo'], limit: 50 },
    limit: 50,
  })
})

test('a search across projects puts the exact key first, then the latest change, each row with its project', async () => {
  const demo = makeScope('DEMO')
  const perf = makeScope('PERF')
  await createTask(demo, { summary: 'Login form' })
  await createTask(perf, { summary: 'Login latency' })
  await createTask(perf, { summary: 'Unrelated' })
  // DEMO-1 changes last, so it leads the text matches.
  await updateTask(demo, { key: 'DEMO-1', priority: 'high' })
  perf.db.prepare("UPDATE task SET updated_at = '2026-09-26T09:00:00.000Z'").run()
  demo.db.prepare("UPDATE task SET updated_at = '2026-09-26T09:30:00.000Z' WHERE number = 1").run()

  const { perProject, limit } = acrossListInput({ query: 'login' })
  const byText = mergeTaskLists('login', limit, [
    { project: ref('DEMO'), value: listTasks(demo, perProject) },
    { project: ref('PERF'), value: listTasks(perf, perProject) },
  ])
  assert.deepEqual(
    byText.tasks.map((t) => [t.key, t.project?.app]),
    [
      ['DEMO-1', 'work.demo'],
      ['PERF-1', 'work.perf'],
    ],
  )
  assert.equal(byText.total, 2)

  // A key matches in its own project only, and leads even when older.
  const key = acrossListInput({ query: 'PERF-2' })
  const byKey = mergeTaskLists('PERF-2', key.limit, [
    { project: ref('DEMO'), value: listTasks(demo, key.perProject) },
    { project: ref('PERF'), value: listTasks(perf, key.perProject) },
  ])
  assert.deepEqual(
    byKey.tasks.map((t) => t.key),
    ['PERF-2'],
  )
})

test('a search across projects puts the named task first when its key was copied with punctuation', async () => {
  const demo = makeScope('DEMO')
  const perf = makeScope('PERF')
  await createTask(perf, { summary: 'Login latency' })
  await createTask(perf, { summary: 'Cache warmup' })
  // A newer task whose summary quotes the key leads by recency alone.
  await createTask(demo, { summary: 'Follow up on PERF-2 numbers' })
  perf.db.prepare("UPDATE task SET updated_at = '2026-09-26T09:00:00.000Z'").run()
  demo.db.prepare("UPDATE task SET updated_at = '2026-09-26T09:30:00.000Z'").run()

  const query = 'PERF\u{2011}2:' // a non-breaking hyphen
  const { perProject, limit } = acrossListInput({ query })
  const merged = mergeTaskLists(query, limit, [
    { project: ref('DEMO'), value: listTasks(demo, perProject) },
    { project: ref('PERF'), value: listTasks(perf, perProject) },
  ])
  assert.deepEqual(
    merged.tasks.map((t) => t.key),
    ['PERF-2', 'DEMO-1'],
  )
})

test('My work across projects merges each section in its own order, tagged, with recent limited overall', async () => {
  const demo = makeScope('DEMO')
  const perf = makeScope('PERF')
  const me = { kind: 'person' as const, id: 'u-ada', name: 'Ada Lovelace' }
  await createTask(demo, { summary: 'Undated', assignee: me })
  await createTask(demo, { summary: 'Late', assignee: me, startDate: '2026-09-28', endDate: '2026-10-20' })
  await createTask(perf, { summary: 'Soon', assignee: me, startDate: '2026-09-27', endDate: '2026-09-30' })
  await createTask(perf, { summary: 'Someone else’s' })
  const assignedTo = (taskNumber: number) => ({ kind: 'assigned' as const, taskNumber, recipients: [me], actor: null })
  await deliver(demo.db, demo, assignedTo(1), '2026-09-26T09:00:00.000Z')
  await deliver(perf.db, perf, assignedTo(1), '2026-09-26T09:30:00.000Z')
  await deliver(demo.db, demo, assignedTo(2), '2026-09-26T09:10:00.000Z')

  const input = { today: '2026-09-26', recentLimit: 1 }
  const merged = mergeMyWork(
    ADA,
    input,
    [
      { project: ref('DEMO'), value: myWork(demo, ADA, input, NOW) },
      { project: ref('PERF'), value: myWork(perf, ADA, input, NOW) },
    ],
    NOW,
  )
  assert.deepEqual(
    merged.assigned.map((t) => [t.key, t.project?.key]),
    [
      ['PERF-1', 'PERF'],
      ['DEMO-2', 'DEMO'],
      ['DEMO-1', 'DEMO'],
    ],
  )
  assert.deepEqual(
    merged.startingSoon.map((t) => t.key),
    ['PERF-1', 'DEMO-2'],
  )
  assert.equal(merged.today, '2026-09-26')
  assert.deepEqual(merged.viewer, { kind: 'person', id: 'u-ada', name: 'Ada Lovelace' })
  // Three notifications in two projects; the newest one overall is kept.
  assert.deepEqual(
    merged.recent.map((n) => [n.task.key, n.project?.key]),
    [['PERF-1', 'PERF']],
  )
})

test('scope "this" or none runs the action as it was, "all" runs across, neither sees the parameter, and any other scope is refused', async () => {
  const seen: unknown[] = []
  const own = (_ctx: unknown, params: Record<string, unknown>) => {
    seen.push(params)
    return 'own'
  }
  const across = (_ctx: unknown, params: Record<string, unknown>) => {
    seen.push(params)
    return 'across'
  }
  const taskList = scoped(own, across)
  assert.equal(await taskList({} as never, { query: 'x' }), 'own')
  assert.equal(await taskList({} as never, { query: 'x', scope: 'this' }), 'own')
  assert.equal(await taskList({} as never, { query: 'x', scope: 'all' }), 'across')
  assert.deepEqual(seen, [{ query: 'x' }, { query: 'x' }, { query: 'x' }])
  assert.throws(() => taskList({} as never, { scope: 'everywhere' }), /scope is "this" \(the default: this project\) or "all"/)
})

test('compact rows across projects carry the App address instead of the project object', async () => {
  const project = ref('PERF')
  const actions = withDetail({
    task_list: () => ({
      tasks: [
        {
          key: 'PERF-1',
          number: 1,
          summary: 'Soon',
          status: { id: 1, name: 'To Do', category: 'todo', color: null, position: 0 },
          type: 'task',
          priority: 'medium',
          assignee: null,
          reporter: { kind: 'person', name: 'alice' },
          parentKey: null,
          childCount: 0,
          childDoneCount: 0,
          labels: [],
          version: null,
          startDate: null,
          endDate: null,
          rank: 'a',
          createdAt: '',
          updatedAt: '',
          blockers: [],
          prs: { open: 0, merged: 0, closed: 0 },
          project,
        },
      ],
      total: 1,
      projects: { read: 2, total: 2 },
    }),
  })
  const taskList = actions.task_list
  assert.ok(taskList)
  const compact = await taskList({} as never, {})
  assert.deepEqual(compact, {
    tasks: [{ key: 'PERF-1', summary: 'Soon', status: 'To Do', type: 'task', priority: 'medium', app: 'work.perf' }],
    total: 1,
    projects: { read: 2, total: 2 },
  })
})
