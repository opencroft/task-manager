import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { DEFAULT_TASK_COLUMNS } from '../../shared/views.ts'
import { parseParams } from '../action-params.ts'
import { allMigrations, migrate } from '../db.ts'
import { deleteView, listViews, saveView, setDefaultView, type ViewOwner } from './store.ts'

const NOW = '2026-09-26T10:00:00.000Z'
const ada: ViewOwner = { key: 'person:u-ada', name: 'Ada' }
const bot: ViewOwner = { key: 'agent:n-bot', name: 'Bot' }

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

test('a new view round-trips its filter and grouping, and its owner can edit it', () => {
  const db = makeDb()
  const view = saveView(
    db,
    ada,
    {
      name: 'My open bugs',
      page: 'board',
      filter: {
        type: { include: ['bug'] },
        assignee: { include: ['me'] },
        label: { exclude: ['wontfix'] },
        sort: { field: 'priority', dir: 'desc' },
      },
      group: 'assignee',
    },
    NOW,
  )
  assert.deepEqual(
    {
      name: view.name,
      page: view.page,
      filter: view.filter,
      group: view.group,
      shared: view.shared,
      owner: view.owner,
      editable: view.editable,
      isDefault: view.isDefault,
    },
    {
      name: 'My open bugs',
      page: 'board',
      filter: {
        type: { include: ['bug'] },
        assignee: { include: ['me'] },
        label: { exclude: ['wontfix'] },
        sort: { field: 'priority', dir: 'desc' },
      },
      group: 'assignee',
      shared: false,
      owner: 'Ada',
      editable: true,
      isDefault: false,
    },
  )
  const renamed = saveView(db, ada, { id: view.id, name: 'Bugs' }, NOW)
  assert.equal(renamed.name, 'Bugs')
  assert.deepEqual(renamed.filter, view.filter, 'fields left out keep their values')
})

test('a filter saved as plain lists is stored as what it includes, and a field that filters nothing is left out', () => {
  const db = makeDb()
  const view = saveView(
    db,
    ada,
    {
      name: 'Plain',
      page: 'tasks',
      filter: {
        status: [3, 3],
        label: [],
        parent: 'TASK-1',
        priority: { include: ['high'], exclude: ['high', 'low'] },
      },
    },
    NOW,
  )
  assert.deepEqual(view.filter, {
    status: { include: [3] },
    parent: { include: ['TASK-1'] },
    priority: { exclude: ['high', 'low'] },
  })
})

const statusId = (db: DatabaseSync, name: string) =>
  (db.prepare('SELECT id FROM status WHERE name = ?').get(name) as { id: number }).id

test('a status saved by name is stored as its id, and an unknown one is refused with the close names', () => {
  const db = makeDb()
  const view = saveView(
    db,
    ada,
    { name: 'Open', page: 'tasks', filter: { status: { include: ['in progress', '1'], exclude: ['Done'] } } },
    NOW,
  )
  assert.deepEqual(view.filter.status, { include: [statusId(db, 'In Progress'), 1], exclude: [statusId(db, 'Done')] })
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', filter: { status: ['Dnoe'] } }, NOW),
    /No status "Dnoe"\. Did you mean "Done"/,
  )
})

test('a view saved earlier with status names reads back with their ids, a name no status has dropped', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(
    db,
    allMigrations().filter((migration) => migration.id !== 'views-0004-status-ids'),
  )
  const old = { status: { include: ['To Do', 'gone'], exclude: ['done'] }, label: { include: ['ui'] } }
  db.prepare(
    `INSERT INTO saved_view (id, page, name, filter, grouping, shared, owner_key, owner_name, created_at, updated_at)
     VALUES ('view-1', 'tasks', 'By name', ?, NULL, 0, ?, ?, ?, ?)`,
  ).run(JSON.stringify(old), ada.key, ada.name, NOW, NOW)
  migrate(db)
  assert.deepEqual(listViews(db, ada)[0]?.filter, {
    status: { include: [statusId(db, 'To Do')], exclude: [statusId(db, 'Done')] },
    label: { include: ['ui'] },
  })
})

test('refuses a filter field that is neither a list nor { include, exclude } of lists', () => {
  const db = makeDb()
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', filter: { label: { only: ['ui'] } as never } }, NOW),
    /label takes a list, or \{ include, exclude \}.*"only"/,
  )
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', filter: { label: { exclude: 'ui' } as never } }, NOW),
    /label\.exclude must be a list/,
  )
  assert.deepEqual(listViews(db, ada), [], 'nothing refused was saved')
})

test('a view saved before filters had excludes keeps what it showed, as includes', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(
    db,
    allMigrations().filter((migration) => migration.id !== 'views-0003-field-filters'),
  )
  const old = {
    query: 'login',
    status: [2],
    assignee: ['none', 'alice'],
    label: [],
    parent: 'TASK-4',
    sort: { field: 'key', dir: 'asc' },
  }
  db.prepare(
    `INSERT INTO saved_view (id, page, name, filter, grouping, shared, owner_key, owner_name, created_at, updated_at)
     VALUES ('view-1', 'tasks', 'Old', ?, NULL, 0, ?, ?, ?, ?)`,
  ).run(JSON.stringify(old), ada.key, ada.name, NOW, NOW)
  migrate(db)
  assert.deepEqual(listViews(db, ada)[0]?.filter, {
    query: 'login',
    status: { include: [2] },
    assignee: { include: ['none', 'alice'] },
    parent: { include: ['TASK-4'] },
    sort: { field: 'key', dir: 'asc' },
  })
})

test('a tasks view keeps its columns in order, a change to other fields keeps them, and null goes back to the default set', () => {
  const db = makeDb()
  const view = saveView(db, ada, { name: 'Lean', page: 'tasks', columns: ['summary', 'key', 'status'] }, NOW)
  assert.deepEqual(view.columns, ['summary', 'key', 'status'])

  const renamed = saveView(db, ada, { id: view.id, name: 'Leaner' }, NOW)
  assert.deepEqual(renamed.columns, ['summary', 'key', 'status'])
  assert.deepEqual(listViews(db, ada, { page: 'tasks' })[0]?.columns, ['summary', 'key', 'status'])

  const reset = saveView(db, ada, { id: view.id, columns: null }, NOW)
  assert.deepEqual(reset.columns, [...DEFAULT_TASK_COLUMNS])
})

test('a tasks view that names no columns shows the default set; a board view has none', () => {
  const db = makeDb()
  assert.deepEqual(saveView(db, ada, { name: 'Plain', page: 'tasks' }, NOW).columns, [
    'type',
    'key',
    'summary',
    'priority',
    'status',
    'assignee',
    'reporter',
    'created',
    'updated',
  ])
  assert.equal(saveView(db, ada, { name: 'Board', page: 'board' }, NOW).columns, null)
})

test('a tasks view saved before views had columns shows the default set', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(
    db,
    allMigrations().filter((migration) => migration.id !== 'views-0002-columns'),
  )
  db.prepare(
    `INSERT INTO saved_view (id, page, name, filter, grouping, shared, owner_key, owner_name, created_at, updated_at)
     VALUES ('view-1', 'tasks', 'Old', '{}', NULL, 0, ?, ?, ?, ?)`,
  ).run(ada.key, ada.name, NOW, NOW)
  migrate(db)
  assert.deepEqual(
    listViews(db, ada).map((view) => [view.name, view.columns]),
    [['Old', [...DEFAULT_TASK_COLUMNS]]],
  )
})

test('refuses columns that cannot be a tasks table, naming the fix', () => {
  const db = makeDb()
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'board', columns: ['key', 'summary'] }, NOW),
    /Only a tasks view has columns/,
  )
  assert.throws(() => saveView(db, ada, { name: 'x', page: 'tasks', columns: [] }, NOW), /non-empty list/)
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', columns: ['key', 'summary', 'stauts'] as never }, NOW),
    /No column "stauts".*Did you mean "status"\?/,
  )
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', columns: ['key', 'summary', 'key'] }, NOW),
    /more than once/,
  )
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', columns: ['summary', 'status'] }, NOW),
    /must include key and summary/,
  )
  assert.deepEqual(listViews(db, ada), [], 'nothing refused was saved')
})

test('others see only shared views, and cannot change or delete them, but can make them their default', () => {
  const db = makeDb()
  const own = saveView(db, ada, { name: 'Private', page: 'tasks', filter: {} }, NOW)
  const shared = saveView(db, ada, { name: 'Sprint', page: 'tasks', filter: { label: ['sprint'] }, shared: true }, NOW)

  assert.deepEqual(
    listViews(db, bot).map((view) => [view.name, view.editable]),
    [['Sprint', false]],
  )
  assert.throws(() => saveView(db, bot, { id: shared.id, name: 'Mine now' }, NOW), /is Ada's view/)
  assert.throws(() => deleteView(db, bot, { view: 'Sprint' }), /only they can delete it/)
  assert.throws(() => deleteView(db, bot, { view: own.id }), /No view/)

  const chosen = setDefaultView(db, bot, { page: 'tasks', view: 'sprint' })
  assert.equal(chosen?.id, shared.id)
  assert.deepEqual(
    listViews(db, bot, { page: 'tasks' }).map((view) => view.isDefault),
    [true],
  )
  assert.deepEqual(
    listViews(db, ada, { page: 'tasks' }).map((view) => view.isDefault),
    [false, false],
    'a default is the caller’s own',
  )
})

test('taking a shared view back clears it as anyone else’s default; deleting a view clears its owner’s', () => {
  const db = makeDb()
  const view = saveView(db, ada, { name: 'Sprint', page: 'board', filter: {}, shared: true }, NOW)
  setDefaultView(db, bot, { page: 'board', view: view.id })
  setDefaultView(db, ada, { page: 'board', view: view.id })

  saveView(db, ada, { id: view.id, shared: false }, NOW)
  assert.deepEqual(listViews(db, bot), [])
  assert.equal(listViews(db, ada)[0]?.isDefault, true, 'the owner keeps it as a default')

  deleteView(db, ada, { view: 'Sprint' })
  assert.deepEqual(listViews(db, ada), [])
  const defaults = db.prepare('SELECT count(*) AS n FROM saved_view_default').get() as { n: number }
  assert.equal(defaults.n, 0)
})

test('refuses what cannot be a view, naming the fix', () => {
  const db = makeDb()
  assert.throws(() => saveView(db, ada, { name: 'x' }, NOW), /needs a name and a page/)
  assert.throws(() => saveView(db, ada, { name: ' ', page: 'tasks' }, NOW), /needs a name/)
  // A page outside the set is refused at the action boundary, before saveView runs.
  assert.throws(
    () => parseParams('view_save', { name: 'x', page: 'timeline' }),
    /"page" must be one of "tasks" or "board", not "timeline"/,
  )
  assert.throws(() => saveView(db, ada, { name: 'x', page: 'tasks', group: 'assignee' }, NOW), /Only a board view/)
  assert.throws(
    () => saveView(db, ada, { name: 'x', page: 'tasks', filter: { statuses: [1] } as never }, NOW),
    /no field "statuses"/,
  )
  saveView(db, ada, { name: 'Mine', page: 'tasks' }, NOW)
  assert.throws(
    () => saveView(db, ada, { name: 'mine', page: 'tasks' }, NOW),
    /already have a tasks view called "mine"/,
  )
  assert.doesNotThrow(() => saveView(db, ada, { name: 'Mine', page: 'board' }, NOW), 'names are per page')
  assert.throws(
    () => setDefaultView(db, ada, { page: 'tasks', view: 'Mnie' }),
    /No view "Mnie"\. Did you mean "Mine"\?/,
  )
  assert.equal(setDefaultView(db, ada, { page: 'tasks', view: null }), null)
})
