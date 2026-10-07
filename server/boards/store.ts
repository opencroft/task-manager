// Boards: their storage and rules. A board belongs to the project, so anyone
// who can open the project can set one up, change it or delete it.

import { randomUUID } from 'node:crypto'

import {
  BOARD_FILTER_KEYS,
  type Board,
  type BoardColumn,
  type BoardColumnInput,
  type BoardDetail,
  type BoardFilter,
  type BoardRefInput,
  type BoardRestriction,
  type BoardSaveInput,
  boardStatusIds,
  workflowFit,
} from '../../shared/boards.ts'
import { didYouMean } from '../closest-names.ts'
import { transaction } from '../db.ts'
import { type Scope, TaskError, listStatuses, listTasks, resolveStatus } from '../service.ts'
import { checkFilter } from '../views/store.ts'
import { listWorkflows } from '../workflows/store.ts'

interface BoardRow {
  id: string
  name: string
  filter: string
  created_at: string
  updated_at: string
}

interface ColumnRow {
  position: number
  name: string | null
}

interface StatusPlacementRow {
  column_position: number
  status_id: number
  status_name: string
}

const NAME_MAX = 80

function columnsOf(scope: Scope, boardId: string): BoardColumn[] {
  const columns = scope.db
    .prepare('SELECT position, name FROM board_column WHERE board_id = ? ORDER BY position')
    .all(boardId) as unknown as ColumnRow[]
  const placements = scope.db
    .prepare(
      `SELECT b.column_position, b.status_id, s.name AS status_name FROM board_status b JOIN status s ON s.id = b.status_id
       WHERE b.board_id = ? ORDER BY b.column_position, b.position`,
    )
    .all(boardId) as unknown as StatusPlacementRow[]
  return columns.map((column) => ({
    name: column.name,
    statuses: placements
      .filter((placement) => placement.column_position === column.position)
      .map((placement) => ({ id: placement.status_id, name: placement.status_name })),
  }))
}

function toBoard(scope: Scope, row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    columns: columnsOf(scope, row.id),
    filter: JSON.parse(row.filter) as BoardFilter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function boardRows(scope: Scope): BoardRow[] {
  return scope.db.prepare('SELECT * FROM board ORDER BY name COLLATE NOCASE').all() as unknown as BoardRow[]
}

/** The board `ref` names: an id, or a name in any case. */
function resolveBoard(scope: Scope, ref: unknown): BoardRow {
  const wanted = typeof ref === 'string' ? ref.trim() : ''
  if (!wanted) {
    throw new TaskError('Name a board by its id or name (board_list gives them)')
  }
  const rows = boardRows(scope)
  const found = rows.find((row) => row.id === wanted) ?? rows.find((row) => row.name.toLowerCase() === wanted.toLowerCase())
  if (!found) {
    const names = rows.map((row) => row.name)
    throw new TaskError(`No board "${wanted}".${didYouMean(wanted, names)} Boards: ${names.join(', ') || 'none yet'}`)
  }
  return found
}

function checkName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > NAME_MAX) {
    throw new TaskError(`A board needs a name of 1–${NAME_MAX} characters`)
  }
  return trimmed
}

function checkColumnName(name: unknown, index: number): string | null {
  if (name === undefined || name === null) {
    return null
  }
  if (typeof name !== 'string' || name.trim().length > NAME_MAX) {
    throw new TaskError(`Column ${index + 1}: a column name is text of at most ${NAME_MAX} characters, or null for its first status's`)
  }
  return name.trim() || null
}

/** The columns as they will be stored: names cleaned, statuses resolved to ids, each status in one column only. */
function checkColumns(scope: Scope, columns: unknown): Array<{ name: string | null; statusIds: number[] }> {
  if (!Array.isArray(columns)) {
    throw new TaskError('columns must be a list of {name?, statuses}')
  }
  const placed = new Map<number, number>()
  return columns.map((column: BoardColumnInput, index) => {
    if (column === null || typeof column !== 'object' || !Array.isArray(column.statuses)) {
      throw new TaskError(`Column ${index + 1} needs statuses: a list of status names or ids`)
    }
    // A column is its statuses: one with none would hold no task. (A status deleted later can still empty one.)
    if (column.statuses.length === 0) {
      throw new TaskError(`Column ${index + 1} has no statuses: give it at least one, or leave it out`)
    }
    const statusIds = column.statuses.map((ref) => {
      const status = resolveStatus(scope, ref)
      const other = placed.get(status.id)
      if (other !== undefined) {
        throw new TaskError(`"${status.name}" is in column ${other + 1} and column ${index + 1}; a status sits in one column of a board`)
      }
      placed.set(status.id, index)
      return status.id
    })
    return { name: checkColumnName(column.name, index), statusIds }
  })
}

function assertNameFree(scope: Scope, name: string, except: string | null): void {
  const clash = scope.db.prepare('SELECT id FROM board WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(name, except)
  if (clash) {
    throw new TaskError(`There is already a board called "${name}"`)
  }
}

function writeColumns(scope: Scope, boardId: string, columns: Array<{ name: string | null; statusIds: number[] }>): void {
  // Replacing the columns takes their statuses with them.
  scope.db.prepare('DELETE FROM board_column WHERE board_id = ?').run(boardId)
  const insertColumn = scope.db.prepare('INSERT INTO board_column (board_id, position, name) VALUES (?, ?, ?)')
  const insertStatus = scope.db.prepare('INSERT INTO board_status (board_id, column_position, position, status_id) VALUES (?, ?, ?, ?)')
  columns.forEach((column, position) => {
    insertColumn.run(boardId, position, column.name)
    column.statusIds.forEach((statusId, order) => {
      insertStatus.run(boardId, position, order, statusId)
    })
  })
}

export function listBoards(scope: Scope): Board[] {
  return boardRows(scope).map((row) => toBoard(scope, row))
}

export function getBoard(scope: Scope, input: BoardRefInput): BoardDetail {
  const board = toBoard(scope, resolveBoard(scope, input.board))
  return { ...board, workflowFit: workflowFit(boardStatusIds(board.columns), listWorkflows(scope.db), listStatuses(scope)) }
}

export function saveBoard(scope: Scope, input: BoardSaveInput, now: string): Board {
  const saved = transaction(scope.db, () => {
    const filter = (value: unknown) => {
      const checked = checkFilter(scope.db, value, BOARD_FILTER_KEYS)
      // Running it once refuses a value task_list would refuse (an unknown version or parent) now, not on every load.
      listTasks(scope, { ...checked, limit: 1 })
      return JSON.stringify(checked)
    }
    if (input.id !== undefined) {
      const row = resolveBoard(scope, input.id)
      const name = input.name === undefined ? row.name : checkName(input.name)
      assertNameFree(scope, name, row.id)
      scope.db
        .prepare('UPDATE board SET name = ?, filter = ?, updated_at = ? WHERE id = ?')
        .run(name, input.filter === undefined ? row.filter : filter(input.filter), now, row.id)
      if (input.columns !== undefined) {
        writeColumns(scope, row.id, checkColumns(scope, input.columns))
      }
      return row.id
    }
    if (input.name === undefined) {
      throw new TaskError('A new board needs a name; pass id to change an existing one')
    }
    const name = checkName(input.name)
    assertNameFree(scope, name, null)
    const columns = checkColumns(scope, input.columns ?? [])
    const id = randomUUID()
    scope.db
      .prepare('INSERT INTO board (id, name, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, filter(input.filter ?? {}), now, now)
    writeColumns(scope, id, columns)
    return id
  })
  scope.notify([], 'board')
  return toBoard(scope, scope.db.prepare('SELECT * FROM board WHERE id = ?').get(saved) as unknown as BoardRow)
}

export function deleteBoard(scope: Scope, input: BoardRefInput): { deleted: string } {
  const row = resolveBoard(scope, input.board)
  scope.db.prepare('DELETE FROM board WHERE id = ?').run(row.id)
  scope.notify([], 'board')
  return { deleted: row.id }
}

/** What `task_list` with `board` narrows to: the board's statuses, and its filter. */
export function boardRestriction(scope: Scope, ref: unknown): BoardRestriction {
  const row = resolveBoard(scope, ref)
  const statusIds = (
    scope.db.prepare('SELECT status_id FROM board_status WHERE board_id = ?').all(row.id) as Array<{ status_id: number }>
  ).map((placement) => placement.status_id)
  return { statusIds, filter: JSON.parse(row.filter) as BoardFilter }
}
