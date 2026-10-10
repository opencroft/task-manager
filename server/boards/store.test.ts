import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeScope } from '../attachments/testing.ts'
import { createTask, deleteStatus, listTasks } from '../service.ts'
import { normalizeDraft } from '../workflows/definition.ts'
import { saveWorkflow } from '../workflows/store.ts'
import { boardRestriction, deleteBoard, getBoard, listBoards, saveBoard } from './store.ts'

const NOW = '2026-09-28T10:00:00.000Z'
let minted = 0
const mintId = () => `id-${++minted}`

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
const names = (board: { columns: Array<{ name: string | null; statuses: Array<{ name: string }> }> }) =>
  board.columns.map((column) => [column.name, column.statuses.map((status) => status.name)])

test('a project has no board until one is made', () => {
  assert.deepEqual(listBoards(makeScope()), [])
})

test('a board keeps its columns and their statuses in order, by name or id, and a column name is optional', () => {
  const scope = makeScope()
  const board = saveBoard(
    scope,
    {
      name: 'Delivery',
      columns: [
        { statuses: ['to do'] },
        { name: 'Doing', statuses: [2, 'In Review'] },
        { name: '  ', statuses: ['Done'] },
      ],
    },
    NOW,
  )
  assert.deepEqual(names(board), [
    [null, ['To Do']],
    ['Doing', ['In Progress', 'In Review']],
    [null, ['Done']],
  ])
  assert.deepEqual(board.filter, {})
  assert.deepEqual(scope.events.at(-1), { keys: [], kind: 'board' })

  const renamed = saveBoard(scope, { id: 'delivery', name: 'Flow' }, NOW)
  assert.deepEqual(names(renamed), names(board), 'columns left out keep their values')
  const rearranged = saveBoard(scope, { id: board.id, columns: [{ statuses: ['In Review', 'In Progress'] }] }, NOW)
  assert.deepEqual(names(rearranged), [[null, ['In Review', 'In Progress']]], 'columns replace every column')
  assert.equal(rearranged.name, 'Flow')
})

test('a board is refused a taken name, a status in two columns, an unknown status, a column with no statuses, a filter field it does not take and a filter value task_list refuses', () => {
  const scope = makeScope()
  saveBoard(scope, { name: 'Delivery' }, NOW)
  assert.throws(() => saveBoard(scope, { name: 'delivery' }, NOW), /already a board called "delivery"/)
  assert.throws(
    () => saveBoard(scope, { name: 'Two', columns: [{ statuses: ['Done'] }, { statuses: [4] }] }, NOW),
    /"Done" is in column 1 and column 2/,
  )
  assert.throws(() => saveBoard(scope, { name: 'Two', columns: [{ statuses: ['Dnoe'] }] }, NOW), /No status "Dnoe"/)
  assert.throws(
    () => saveBoard(scope, { name: 'Two', filter: { status: [1] } as never }, NOW),
    /filter has no field "status"/,
  )
  assert.throws(
    () => saveBoard(scope, { name: 'Two', filter: { sort: { field: 'rank', dir: 'asc' } } as never }, NOW),
    /filter has no field "sort"/,
  )
  assert.throws(() => saveBoard(scope, { name: 'Two', filter: { version: ['9.9.9'] } }, NOW), /No version "9.9.9"/)
  assert.throws(() => saveBoard(scope, { id: 'Delivery', filter: { parent: 'TASK-404' } }, NOW), /TASK-404/)
  assert.throws(
    () => saveBoard(scope, { name: 'Two', columns: [{ statuses: ['Done'] }, { name: 'Later', statuses: [] }] }, NOW),
    /Column 2 has no statuses/,
  )
  assert.throws(() => saveBoard(scope, { columns: [] }, NOW), /A new board needs a name/)
  assert.throws(() => getBoard(scope, { board: 'Delivry' }), /No board "Delivry"/)
  assert.deepEqual(
    listBoards(scope).map((board) => board.name),
    ['Delivery'],
    'nothing refused was saved',
  )
})

test('task_list on a board shows its statuses matching its filter, and the call’s own filters narrow it', async () => {
  const scope = makeScope({ kind: 'person', name: 'Ada' })
  const task = async (summary: string, status: string, type: 'task' | 'bug') =>
    (await createTask(scope, { summary, status, type })).result.key
  const openBug = await task('Crash on save', 'To Do', 'bug')
  const doingBug = await task('Crash on load', 'In Progress', 'bug')
  await task('Write docs', 'In Progress', 'task')
  await task('Old crash', 'Done', 'bug')
  const board = saveBoard(
    scope,
    { name: 'Bugs', columns: [{ statuses: ['To Do', 'In Progress'] }], filter: { type: ['bug'] } },
    NOW,
  )

  const keys = (input = {}, ref = board.id) =>
    listTasks(scope, input, boardRestriction(scope, ref)).tasks.map((row) => row.key)
  assert.deepEqual(keys(), [openBug, doingBug])
  assert.deepEqual(keys({ query: 'load' }), [doingBug])
  assert.deepEqual(keys({ type: ['task'] }), [], 'the call’s filter and the board’s both apply')
  assert.equal(listTasks(scope, {}, boardRestriction(scope, 'bugs')).total, 2)

  saveBoard(scope, { name: 'Empty' }, NOW)
  assert.deepEqual(keys({}, 'Empty'), [], 'a board with no statuses shows no tasks')
})

test('a deleted status leaves every board, and a column it emptied stays', async () => {
  const scope = makeScope()
  const board = saveBoard(
    scope,
    { name: 'Flow', columns: [{ statuses: ['To Do'] }, { name: 'Review', statuses: ['In Review'] }] },
    NOW,
  )
  await deleteStatus(scope, { status: 'In Review', moveTo: 'In Progress' })
  assert.deepEqual(names(getBoard(scope, { board: board.id })), [
    [null, ['To Do']],
    ['Review', []],
  ])
  assert.deepEqual(deleteBoard(scope, { board: 'flow' }), { deleted: board.id })
  assert.deepEqual(listBoards(scope), [])
  assert.equal(scope.db.prepare('SELECT count(*) AS n FROM board_status').get()?.n, 0, 'its placements went with it')
})

test('board_get names, per workflow, the statuses its steps start on or finish into that the board leaves out', () => {
  const scope = makeScope()
  saveWorkflow(
    scope.db,
    normalizeDraft(
      {
        name: 'Review flow',
        steps: [
          {
            name: 'Development',
            triggerStatus: 2,
            worker: { kind: 'assignee' },
            instructions: 'Build',
            transitions: [3],
          },
          {
            name: 'Review',
            triggerStatus: 3,
            worker: { kind: 'assignee' },
            instructions: 'Review',
            transitions: [4, 2],
          },
        ],
      },
      mintId,
      [],
    ),
    NOW,
  )
  const partial = saveBoard(scope, { name: 'Partial', columns: [{ statuses: ['To Do', 'In Progress'] }] }, NOW)
  assert.deepEqual(
    getBoard(scope, { board: partial.id }).workflowFit.map((fit) => [
      fit.workflow,
      fit.missing.map((status) => status.name),
    ]),
    [['Review flow', ['In Review', 'Done']]],
  )
  const whole = saveBoard(
    scope,
    { name: 'Whole', columns: [{ statuses: ['In Progress'] }, { statuses: ['In Review', 'Done'] }] },
    NOW,
  )
  assert.deepEqual(
    getBoard(scope, { board: whole.id }).workflowFit.map((fit) => fit.missing),
    [[]],
  )
})
