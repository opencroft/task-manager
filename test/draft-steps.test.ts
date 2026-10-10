import assert from 'node:assert/strict'
import { test } from 'node:test'

import { copySteps, type DraftStep, duplicateStep, noApproval } from '../src/workflows/draft-steps'

function step(id: string, name: string, triggerStatus: number, transitions: DraftStep['transitions']): DraftStep {
  return {
    id,
    key: `k-${id}`,
    name,
    kind: 'agent',
    approval: noApproval(),
    triggerStatus,
    worker: { kind: 'assignee' },
    instructions: '',
    transitions,
    folder: '',
    sessionOptions: {},
  }
}

const steps = (): DraftStep[] => [
  step('dev', 'Development', 2, [
    { key: 't1', id: 'edge-1', label: 'Ready for review', toStep: 'review', status: 3, gate: null },
  ]),
  step('review', 'Review', 3, [
    { key: 't2', id: 'edge-2', label: 'Approved', toStep: null, status: 4, gate: null },
    { key: 't3', id: 'edge-3', label: 'Changes requested', toStep: 'dev', status: 2, gate: 'fail' },
  ]),
]

test('a duplicated step keeps its trigger status, and is inserted after the original under a new id', () => {
  const out = duplicateStep(steps(), 0)
  assert.deepEqual(
    out.map((s) => [s.name, s.triggerStatus]),
    [
      ['Development', 2],
      ['Development copy', 2],
      ['Review', 3],
    ],
  )
  const copy = out[1]
  assert.notEqual(copy.id, 'dev')
  assert.notEqual(copy.key, 'k-dev')
})

test("a duplicated step's transitions lead where the original's do, as new transitions", () => {
  const copy = duplicateStep(steps(), 1)[2]
  assert.deepEqual(
    copy.transitions.map(({ key: _key, ...t }) => t),
    [
      { label: 'Approved', toStep: null, status: 4, gate: null },
      { label: 'Changes requested', toStep: 'dev', status: 2, gate: 'fail' },
    ],
  )
})

test('copied steps lead to each other under their new ids', () => {
  const [dev, review] = copySteps(steps())
  assert.equal(dev?.transitions[0]?.toStep, review?.id)
  assert.equal(review?.transitions[1]?.toStep, dev?.id)
  assert.ok(dev && dev.id !== 'dev')
})
