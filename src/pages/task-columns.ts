// The Tasks table's columns as the URL carries them: `cols`, the column ids
// left to right. A URL without `cols` shows the baseline: the active saved
// view's columns, or the default set when no view is shown. So a view's link
// shows its columns, and a change from them is always written out.

import { DEFAULT_TASK_COLUMNS, REQUIRED_TASK_COLUMNS, TASK_COLUMNS, type TaskColumn } from '../../shared/views'

const sameColumns = (a: readonly TaskColumn[], b: readonly TaskColumn[]) => a.join(',') === b.join(',')

/** Whether `columns` are the default set, in its order. */
export function isDefaultColumns(columns: readonly TaskColumn[]): boolean {
  return sameColumns(columns, DEFAULT_TASK_COLUMNS)
}

/**
 * The columns a `cols` value names, in order. Unknown and repeated names are
 * dropped; the baseline stands in for no value, and for a list without the
 * required columns.
 */
export function columnsOfParam(cols: string | null, baseline: readonly TaskColumn[] = DEFAULT_TASK_COLUMNS): TaskColumn[] {
  const named = [...new Set((cols ?? '').split(',').filter(Boolean))].filter((column): column is TaskColumn =>
    TASK_COLUMNS.includes(column as TaskColumn),
  )
  return cols !== null && REQUIRED_TASK_COLUMNS.every((column) => named.includes(column)) ? named : [...baseline]
}

/** The `cols` value for `columns`: none when they are the baseline, so a plain link stays plain. */
export function columnsParam(columns: readonly TaskColumn[], baseline: readonly TaskColumn[] = DEFAULT_TASK_COLUMNS): string | null {
  return sameColumns(columns, baseline) ? null : columns.join(',')
}
