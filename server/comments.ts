// A task's comments a page at a time, for agents: `task_get` holds only the
// latest few, and `task_comments` reads the rest, newest first.

import type { ActionInputs } from '../shared/action-inputs.ts'
import { COMMENTS_MAX, COMMENTS_PAGE } from '../shared/compact.ts'
import type { TaskCommentsResult } from '../shared/types.ts'
import { commentRow } from './compact.ts'
import { type CommentRow, commentOf, keyOf, limitParam, requireRow, type Scope, TaskError } from './service.ts'

// A page ends at a comment, and the next one starts just past it in
// (created_at, id) order: a cursor that stays right when comments are added
// or deleted between pages, which an offset would not.
function cursorOf(c: CommentRow): string {
  return Buffer.from(JSON.stringify([c.created_at, c.id])).toString('base64url')
}

function fromCursor(before: string): [string, number] {
  try {
    const value = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && typeof value[0] === 'string' && Number.isInteger(value[1])) {
      return [value[0], value[1] as number]
    }
  } catch {
    // Refused below, as any other value that is not a cursor.
  }
  throw new TaskError(
    `"before" is not a cursor from task_comments: pass the "next" of the page before, or leave it out for the newest`,
  )
}

/** One page of a task's comments, newest first, and where the older ones start. */
export function listComments(scope: Scope, input: ActionInputs['task_comments']): TaskCommentsResult {
  const row = requireRow(scope, input.key)
  const limit = limitParam('limit', input.limit, COMMENTS_PAGE, COMMENTS_MAX)
  const older = input.before === undefined ? null : fromCursor(input.before)
  // One past the page says whether there is another.
  const rows = (
    older
      ? scope.db
          .prepare(
            'SELECT * FROM comment WHERE task_id = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',
          )
          .all(row.id, older[0], older[1], limit + 1)
      : scope.db
          .prepare('SELECT * FROM comment WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(row.id, limit + 1)
  ) as CommentRow[]
  const page = rows.slice(0, limit)
  const { total } = scope.db.prepare('SELECT count(*) AS total FROM comment WHERE task_id = ?').get(row.id) as {
    total: number
  }
  const last = page.at(-1)
  return {
    key: keyOf(scope, row.number),
    comments: page.map((c) => commentRow(commentOf(scope, c))),
    total,
    ...(rows.length > limit && last ? { next: cursorOf(last) } : {}),
  }
}
