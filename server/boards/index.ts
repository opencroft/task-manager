// Seam owned by boards. The server entry spreads `boardActions` into the
// `tasks` App's actions: list, read (with how the board serves each
// workflow), create or change, and delete.

import type { AppActionHandler } from '@opencroft/server'

import type { BoardActionId } from '../../shared/boards.ts'
import { scopeFor } from '../actions.ts'
import type { Scope } from '../service.ts'
import { deleteBoard, getBoard, listBoards, saveBoard } from './store.ts'

// biome-ignore lint/suspicious/noExplicitAny: inputs are validated by the store
const handlers: Record<BoardActionId, (scope: Scope, params: any) => unknown> = {
  board_list: (s) => listBoards(s),
  board_get: (s, params) => getBoard(s, params),
  board_save: (s, params) => saveBoard(s, params, new Date().toISOString()),
  board_delete: (s, params) => deleteBoard(s, params),
}

export const boardActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx, params) => handler(scopeFor(ctx), params ?? {})]),
)
