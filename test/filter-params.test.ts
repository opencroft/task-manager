import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clearedParams, fieldInput, selectionOfQuery, selectionParams } from '../src/lib/filter-params'

test('a field keeps its included values in <field> and its excluded ones in not.<field>', () => {
  const params = selectionParams('label', { include: ['ui', 'api'], exclude: ['wontfix'] })
  assert.deepEqual(params, { label: 'ui,api', 'not.label': 'wontfix' })
  const query = new URLSearchParams(params as Record<string, string>)
  assert.deepEqual(selectionOfQuery(query, 'label'), { include: ['ui', 'api'], exclude: ['wontfix'] })
})

test('an empty list removes its parameter, and clearing removes both of every field', () => {
  assert.deepEqual(selectionParams('type', { include: [], exclude: ['bug'] }), { type: null, 'not.type': 'bug' })
  assert.deepEqual(selectionParams('type', undefined), { type: null, 'not.type': null })
  assert.deepEqual(clearedParams(['type', 'label']), { type: null, 'not.type': null, label: null, 'not.label': null })
})

test('a link with only included values reads as what it includes', () => {
  const query = new URLSearchParams('status=3,4&parent=TASK-2')
  assert.deepEqual(selectionOfQuery(query, 'status'), { include: ['3', '4'], exclude: [] })
  assert.deepEqual(fieldInput(selectionOfQuery(query, 'status'), Number), { include: [3, 4] })
  assert.deepEqual(fieldInput(selectionOfQuery(query, 'parent')), { include: ['TASK-2'] })
})

test('a field that filters nothing gives task_list nothing', () => {
  assert.equal(fieldInput({ include: [], exclude: [] }), undefined)
  assert.deepEqual(fieldInput({ include: [], exclude: ['done'] }), { exclude: ['done'] })
})
