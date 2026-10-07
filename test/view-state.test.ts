import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TaskType } from '../shared/types'
import type { SavedView } from '../shared/views'
import { emptyState, queryOfState, queryOfView, sameViewState, stateOfView, viewOfQuery } from '../src/pages/view-state'

const VIEW: SavedView = {
  id: 'view-1',
  name: 'Open bugs',
  page: 'tasks',
  filter: { query: 'login', type: { include: ['bug'] }, label: { exclude: ['wontfix'] }, sort: { field: 'priority', dir: 'desc' } },
  group: null,
  columns: ['key', 'summary', 'status'],
  shared: false,
  owner: 'alice',
  isDefault: false,
  editable: true,
}
const BASE = stateOfView(VIEW)
const read = (search: string, base = BASE) => viewOfQuery(new URLSearchParams(search), 'tasks', base)

test("a view's bare link shows its filters, search, sort and columns, unmodified", () => {
  const shown = read('view=view-1')
  assert.deepEqual(shown.filter.type, { include: ['bug'] })
  assert.deepEqual(shown.filter.label, { exclude: ['wontfix'] })
  assert.equal(shown.filter.query, 'login')
  assert.deepEqual(shown.filter.sort, { field: 'priority', dir: 'desc' })
  assert.deepEqual(shown.columns, ['key', 'summary', 'status'])
  assert.equal(sameViewState(shown, BASE), true)
})

test('showing a view writes its id and nothing it already holds', () => {
  assert.equal(queryOfView(VIEW).toString(), 'view=view-1')
})

test('a change from the view is the only thing written, and reads back over the rest of the view', () => {
  const changed = { ...BASE, filter: { ...BASE.filter, type: { include: ['bug', 'story'] as TaskType[] } } }
  const query = queryOfState(changed, BASE)
  assert.equal(query.toString(), 'type=bug%2Cstory')
  const back = read(query.toString())
  assert.deepEqual(back.filter.type, { include: ['bug', 'story'] })
  assert.deepEqual(back.filter.label, { exclude: ['wontfix'] }, 'the fields left out are still the view’s')
  assert.equal(sameViewState(back, BASE), false)
})

test("clearing what the view filters by is written as empty, and reads back as nothing", () => {
  const cleared = { ...BASE, filter: { ...BASE.filter, label: undefined, query: undefined, sort: undefined } }
  const query = queryOfState(cleared, BASE)
  assert.deepEqual(Object.fromEntries(query), { q: '', label: '', sort: '' })
  const back = read(query.toString())
  assert.equal(back.filter.label, undefined)
  assert.equal(back.filter.query, undefined)
  assert.equal(back.filter.sort, undefined)
  assert.equal(sameViewState(back, cleared), true)
})

test('with no view shown, the URL is the whole state, and an empty one shows nothing', () => {
  const none = emptyState('tasks')
  assert.equal(sameViewState(read('', none), none), true)
  assert.deepEqual(read('status=3&not.label=ui', none).filter.status, { include: [3] })
  assert.deepEqual(read('status=3&not.label=ui', none).filter.label, { exclude: ['ui'] })
})

test("writing a view's state against no view spells all of it out", () => {
  const query = queryOfState(BASE, emptyState('tasks'))
  assert.equal(sameViewState(viewOfQuery(query, 'tasks'), BASE), true)
  assert.equal(query.get('view'), null)
})
