import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TaskColumn } from '../shared/views'
import { columnsOfParam, columnsParam, isDefaultColumns } from '../src/pages/task-columns'

const DEFAULT = ['type', 'key', 'summary', 'priority', 'status', 'assignee', 'reporter', 'created', 'updated']
/** A saved view's columns: the default set without Reporter. */
const VIEW: TaskColumn[] = ['type', 'key', 'summary', 'priority', 'status', 'assignee', 'created', 'updated']

test('with no view, no cols value shows the default set, and the default set writes no value', () => {
  assert.deepEqual(columnsOfParam(null), DEFAULT)
  assert.equal(columnsParam(columnsOfParam(null)), null)
})

test("a view's link without cols shows the view's columns", () => {
  assert.deepEqual(columnsOfParam(null, VIEW), VIEW)
})

test("columns equal to the view's write no value; the default set on a view is written out", () => {
  assert.equal(columnsParam(VIEW, VIEW), null)
  assert.equal(columnsParam(columnsOfParam(null), VIEW), DEFAULT.join(','))
  assert.deepEqual(columnsOfParam(DEFAULT.join(','), VIEW), DEFAULT)
})

test('cols keeps the columns it names in its own order', () => {
  assert.deepEqual(columnsOfParam('summary,key,labels'), ['summary', 'key', 'labels'])
  assert.equal(columnsParam(['summary', 'key', 'labels']), 'summary,key,labels')
})

test('unknown and repeated names are dropped', () => {
  assert.deepEqual(columnsOfParam('key,bogus,summary,key'), ['key', 'summary'])
})

test('a list without key or summary falls back to the baseline', () => {
  assert.deepEqual(columnsOfParam('summary,status'), DEFAULT)
  assert.deepEqual(columnsOfParam('key,status', VIEW), VIEW)
  assert.deepEqual(columnsOfParam('', VIEW), VIEW)
})

test('only the default set in its own order counts as the default', () => {
  assert.equal(isDefaultColumns(DEFAULT as TaskColumn[]), true)
  assert.equal(isDefaultColumns(VIEW), false)
  assert.equal(isDefaultColumns([...DEFAULT].reverse() as TaskColumn[]), false)
})
