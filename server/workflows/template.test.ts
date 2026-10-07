import assert from 'node:assert/strict'
import { test } from 'node:test'

import { placeholderProblem, placeholders, renderTemplate, stepSlug } from './template.ts'

const ctx = {
  task: { key: 'TASK-7', summary: 'Fix login', description: 'It 500s', url: '/tasks/TASK-7' },
  step: { name: 'Review' },
  workflow: { name: 'Standard' },
  steps: { development: { summary: 'Patched the handler', outcome: 'Review' } },
}

test('fills task, step, workflow and earlier-step placeholders, tolerating inner spaces', () => {
  const out = renderTemplate(
    '{{task.key}} {{ task.summary }} — {{ step.name }} in {{workflow.name}}: {{ steps.development.summary }}',
    ctx,
  )
  assert.equal(out, 'TASK-7 Fix login — Review in Standard: Patched the handler')
})

test('a known field with no value renders empty; an unknown placeholder stays as written', () => {
  assert.equal(renderTemplate('[{{ task.assignee }}]', ctx), '[]')
  assert.equal(renderTemplate('[{{ steps.qa.summary }}]', ctx), '[]')
  assert.equal(renderTemplate('[{{ task.nope }}] [{{ other }}]', ctx), '[{{ task.nope }}] [{{ other }}]')
})

test('slugs collapse anything but letters and digits', () => {
  assert.equal(stepSlug('  Code Review (2nd pass) '), 'code-review-2nd-pass')
  assert.equal(stepSlug('QA'), 'qa')
  assert.equal(stepSlug('—'), '')
})

test('placeholders are listed with their offsets', () => {
  assert.deepEqual(placeholders('a {{ x.y }} b {{z}}'), [
    { path: 'x.y', index: 2 },
    { path: 'z', index: 14 },
  ])
})

test('placeholder checks name the fix', () => {
  const earlier = new Set(['development'])
  assert.equal(placeholderProblem('task.summary', earlier), null)
  assert.equal(placeholderProblem('steps.development.outcome', earlier), null)
  assert.match(placeholderProblem('task.title', earlier) ?? '', /task\.summary/)
  assert.match(placeholderProblem('steps.review.summary', earlier) ?? '', /no earlier step; earlier steps: development/)
  assert.match(placeholderProblem('steps.development', earlier) ?? '', /steps\.<step>\.<field>/)
  assert.match(placeholderProblem('user.name', earlier) ?? '', /unknown/)
})
