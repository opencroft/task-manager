import assert from 'node:assert/strict'
import { test } from 'node:test'

import { projectOfKey, taskKeyPattern } from '../shared/references.ts'
import type { TaskSummary } from '../shared/types.ts'
import type { ProjectInstance } from './projects/across.ts'
import { referenceProjects, resolveReferences } from './references.ts'

const instance = (instanceId: string, key: string, app: string): ProjectInstance => ({
  instanceId,
  spaceSlug: app.split('.')[0],
  slug: app.split('.')[1],
  name: key,
  params: { id: key },
  dataDir: `/tmp/${instanceId}`,
})

const INSTANCES = [instance('i1', 'DEMO', 'one.tasks'), instance('i2', 'WEB', 'two.board'), instance('i3', '', 'x.y')]

const summary = (key: string, summaryText: string): TaskSummary =>
  ({
    key,
    summary: summaryText,
    type: 'bug',
    status: { id: 1, name: 'In Progress', category: 'in_progress', color: null, position: 1 },
  }) as TaskSummary

test('projects are listed with their key, address and instance; one without a key is left out', () => {
  assert.deepEqual(referenceProjects(INSTANCES), [
    { key: 'DEMO', app: 'one.tasks', instanceId: 'i1' },
    { key: 'WEB', app: 'two.board', instanceId: 'i2' },
  ])
})

test('the key pattern names only the listed projects', () => {
  const pattern = new RegExp(taskKeyPattern(referenceProjects(INSTANCES)) as string, 'g')
  assert.deepEqual('DEMO-1, WEB-22, UTF-8, GPT-4, XDEMO-3, DEMO-0'.match(pattern), ['DEMO-1', 'WEB-22'])
  assert.equal(taskKeyPattern([]), null)
})

test('keys are resolved with one read per project that owns any, and unknown ones answer null', async () => {
  const reads: Array<[string, number[]]> = []
  const answer = await resolveReferences(INSTANCES, ['DEMO-1', 'WEB-5', 'DEMO-2', 'NOPE-1', 'not a key', 'DEMO-1'], (inst, numbers) => {
    reads.push([inst.instanceId, numbers])
    return inst.instanceId === 'i1' ? [summary('DEMO-1', 'Fix login')] : []
  })
  assert.deepEqual(reads, [
    ['i1', [1, 2]],
    ['i2', [5]],
  ])
  assert.deepEqual(answer, {
    'DEMO-1': {
      key: 'DEMO-1',
      summary: 'Fix login',
      type: 'bug',
      status: { name: 'In Progress', category: 'in_progress', color: null },
      app: 'one.tasks',
    },
    'WEB-5': null,
    'DEMO-2': null,
    'NOPE-1': null,
    'not a key': null,
  })
})

test('a project that cannot be read fails the answer rather than reporting its tasks missing', async () => {
  await assert.rejects(
    resolveReferences(INSTANCES, ['DEMO-1'], () => {
      throw new Error('locked')
    }),
    /locked/,
  )
})

test('keys must be a list of strings', async () => {
  await assert.rejects(resolveReferences(INSTANCES, 'DEMO-1', () => []), /list of task keys/)
  assert.equal(projectOfKey('DEMO-12')?.number, 12)
  assert.equal(projectOfKey('demo-12'), null)
})
