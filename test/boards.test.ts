import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type BoardSetupColumn, moveBoardStatus } from '../src/components/ui/tasks/board-setup-editor'
import { shownSections } from '../src/pages/board-sections'

const COLUMNS: BoardSetupColumn[] = [
  { key: 'a', name: null, statusIds: [1] },
  { key: 'b', name: 'Doing', statusIds: [2, 3, 4] },
]

const ids = (columns: BoardSetupColumn[]) => columns.map((column) => column.statusIds)

test('a status moves within its column, to another column, and off the board', () => {
  assert.deepEqual(ids(moveBoardStatus(COLUMNS, 2, { column: 'b', index: 1 })), [[1], [3, 2, 4]], 'down one')
  assert.deepEqual(ids(moveBoardStatus(COLUMNS, 4, { column: 'b', index: 0 })), [[1], [4, 2, 3]], 'to the top')
  assert.deepEqual(
    ids(moveBoardStatus(COLUMNS, 3, { column: 'a', index: 0 })),
    [
      [3, 1],
      [2, 4],
    ],
    'into another column',
  )
  assert.deepEqual(
    ids(moveBoardStatus(COLUMNS, 1, { column: null, index: 0 })),
    [[], [2, 3, 4]],
    'off the board; its column stays',
  )
  assert.deepEqual(
    ids(moveBoardStatus(COLUMNS, 5, { column: 'a', index: 1 })),
    [
      [1, 5],
      [2, 3, 4],
    ],
    'onto the board from off it',
  )
  assert.deepEqual(ids(COLUMNS), [[1], [2, 3, 4]], 'the columns given are not changed')
})

test('a column shows its sections with cards at rest, and every status while a card is dragged, the empty ones last', () => {
  const statuses = ['To Do', 'Blocked', 'Doing', 'Waiting']
  const withCards = new Set(['Doing', 'To Do'])
  const shown = (dragging: boolean) => shownSections(statuses, (status) => withCards.has(status), dragging)
  assert.deepEqual(shown(false), [
    { status: 'To Do', labelled: true },
    { status: 'Doing', labelled: true },
  ])
  assert.deepEqual(
    shown(true).map((section) => section.status),
    ['To Do', 'Doing', 'Blocked', 'Waiting'],
  )
  assert.deepEqual(
    shownSections(['Done'], () => false, false),
    [],
    'an empty column at rest has no sections',
  )
  assert.deepEqual(
    shownSections(['Done'], () => false, true),
    [{ status: 'Done', labelled: false }],
    'a column of one status is unlabelled',
  )
})
