// Seam owned by boards. The server entry spreads `boardActions` into the
// `tasks` App's actions: list, read (with how the board serves each
// workflow), create or change, and delete.

import type { BoardActionId } from '../../shared/boards.ts'
import { scopedActions } from '../actions.ts'
import { deleteBoard, getBoard, listBoards, saveBoard } from './store.ts'

export const boardActions = scopedActions<BoardActionId>({
  board_list: (s) => listBoards(s),
  board_get: (s, input) => getBoard(s, input),
  board_save: (s, input) => saveBoard(s, input, new Date().toISOString()),
  board_delete: (s, input) => deleteBoard(s, input),
})
