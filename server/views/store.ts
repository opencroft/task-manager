// Saved views: their storage and rules, with no host in sight, so the whole
// module runs under `node --test` against an in-memory database. Every
// function acts for one owner, the caller: they see their own views and the
// shared ones, change only their own, and keep a default per page.

import { randomUUID } from 'node:crypto'

import {
  DEFAULT_TASK_COLUMNS,
  REQUIRED_TASK_COLUMNS,
  type SavedView,
  TASK_COLUMNS,
  type TaskColumn,
  VIEW_PAGES,
  type ViewDeleteInput,
  type ViewFilter,
  type ViewGrouping,
  type ViewListInput,
  type ViewPage,
  type ViewSaveInput,
  type ViewSetDefaultInput,
} from '../../shared/views.ts'
import { VIEW_FIELD_FILTER_KEYS, compactFieldFilter, compactFilter } from '../../shared/filters.ts'
import type { StatusRef } from '../../shared/types.ts'
import { didYouMean } from '../closest-names.ts'
import { type Db, transaction } from '../db.ts'
import { TaskError, checkedFieldFilter, resolveStatus } from '../service.ts'

/** Who a call acts for: a stable key and the name shown on what they save. */
export interface ViewOwner {
  key: string
  name: string
}

interface ViewRow {
  id: string
  page: ViewPage
  name: string
  filter: string
  grouping: ViewGrouping
  /** JSON array of the tasks table's columns; null for the default set, and on the board. */
  columns: string | null
  shared: number
  owner_key: string
  owner_name: string
}

const NAME_MAX = 80
const FILTER_KEYS: ReadonlyArray<keyof ViewFilter> = ['query', 'status', 'assignee', 'type', 'priority', 'label', 'version', 'parent', 'sort']

function toView(row: ViewRow, owner: ViewOwner, defaultId: string | undefined): SavedView {
  return {
    id: row.id,
    name: row.name,
    page: row.page,
    filter: JSON.parse(row.filter) as ViewFilter,
    group: row.grouping,
    columns: row.page !== 'tasks' ? null : row.columns ? (JSON.parse(row.columns) as TaskColumn[]) : [...DEFAULT_TASK_COLUMNS],
    shared: row.shared === 1,
    owner: row.owner_name,
    isDefault: row.id === defaultId,
    editable: row.owner_key === owner.key,
  }
}

function defaults(db: Db, owner: ViewOwner): Map<ViewPage, string> {
  const rows = db.prepare('SELECT page, view_id FROM saved_view_default WHERE owner_key = ?').all(owner.key) as Array<{
    page: ViewPage
    view_id: string
  }>
  return new Map(rows.map((row) => [row.page, row.view_id]))
}

/** The views the owner can see: their own, then the shared ones, each by name. */
function visibleRows(db: Db, owner: ViewOwner, page?: ViewPage): ViewRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM saved_view WHERE (owner_key = ? OR shared = 1) AND (? IS NULL OR page = ?)
       ORDER BY owner_key <> ?, name COLLATE NOCASE`,
    )
    .all(owner.key, page ?? null, page ?? null, owner.key) as unknown as ViewRow[]
  return rows
}

function checkPage(page: unknown): ViewPage {
  if (!VIEW_PAGES.includes(page as ViewPage)) {
    throw new TaskError(`No page "${String(page)}"; a view belongs to one of: ${VIEW_PAGES.join(', ')}`)
  }
  return page as ViewPage
}

function checkName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > NAME_MAX) {
    throw new TaskError(`A view needs a name of 1–${NAME_MAX} characters`)
  }
  return trimmed
}

/**
 * A filter as `task_list` takes it, limited to `keys` (a board's filter
 * leaves out status and sort), in the stored form: a plain list is the values
 * to include, and a status named by name is stored as its id, which is how
 * the pages and their URLs hold it.
 */
export function checkFilter(db: Db, filter: unknown, keys: ReadonlyArray<keyof ViewFilter> = FILTER_KEYS): ViewFilter {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new TaskError('filter must be an object with the fields task_list takes')
  }
  const unknown = Object.keys(filter).filter((key) => !keys.includes(key as keyof ViewFilter))
  if (unknown.length) {
    throw new TaskError(`filter has no field ${unknown.map((key) => `"${key}"`).join(', ')}; it takes: ${keys.join(', ')}`)
  }
  for (const key of VIEW_FIELD_FILTER_KEYS) {
    checkedFieldFilter(key, (filter as Record<string, unknown>)[key])
  }
  const checked = compactFilter(filter as ViewFilter)
  if (checked.status) {
    const ids = (refs: StatusRef[] | undefined) => refs?.map((ref) => resolveStatus({ db }, ref).id)
    checked.status = compactFieldFilter({ include: ids(checked.status.include), exclude: ids(checked.status.exclude) })
  }
  return checked
}

/** The view `ref` (an id, or a name) names among those the owner can see; their own wins a name clash. */
function resolve(db: Db, owner: ViewOwner, ref: string, page?: ViewPage): ViewRow {
  const rows = visibleRows(db, owner, page)
  const byId = rows.find((row) => row.id === ref)
  if (byId) {
    return byId
  }
  const named = rows.filter((row) => row.name.toLowerCase() === ref.trim().toLowerCase())
  const own = named.filter((row) => row.owner_key === owner.key)
  if (own.length === 1 || named.length === 1) {
    return (own[0] ?? named[0]) as ViewRow
  }
  if (named.length > 1) {
    throw new TaskError(`More than one shared view is called "${ref}"; pass its id (view_list gives them)`)
  }
  throw new TaskError(`No view "${ref}".${didYouMean(ref, rows.map((row) => row.name))}`)
}

function viewById(db: Db, owner: ViewOwner, id: string): SavedView {
  const row = db.prepare('SELECT * FROM saved_view WHERE id = ?').get(id) as unknown as ViewRow
  return toView(row, owner, defaults(db, owner).get(row.page))
}

export function listViews(db: Db, owner: ViewOwner, input: ViewListInput = {}): SavedView[] {
  const page = input.page === undefined ? undefined : checkPage(input.page)
  const byPage = defaults(db, owner)
  return visibleRows(db, owner, page).map((row) => toView(row, owner, byPage.get(row.page)))
}

export function saveView(db: Db, owner: ViewOwner, input: ViewSaveInput, now: string): SavedView {
  return transaction(db, () => {
    if (input.id !== undefined) {
      const row = resolve(db, owner, input.id)
      if (row.owner_key !== owner.key) {
        throw new TaskError(`"${row.name}" is ${row.owner_name}'s view; save a copy under a new name instead`)
      }
      if (input.page !== undefined && checkPage(input.page) !== row.page) {
        throw new TaskError('A view keeps its page; save a new view for the other page')
      }
      const name = input.name === undefined ? row.name : checkName(input.name)
      const filter = input.filter === undefined ? row.filter : JSON.stringify(checkFilter(db, input.filter))
      const grouping = input.group === undefined ? row.grouping : groupingFor(row.page, input.group)
      const columns = input.columns === undefined ? row.columns : columnsFor(row.page, input.columns)
      const shared = input.shared === undefined ? row.shared : input.shared ? 1 : 0
      assertNameFree(db, owner, row.page, name, row.id)
      db.prepare('UPDATE saved_view SET name = ?, filter = ?, grouping = ?, columns = ?, shared = ?, updated_at = ? WHERE id = ?').run(
        name,
        filter,
        grouping,
        columns,
        shared,
        now,
        row.id,
      )
      if (!shared) {
        // A view taken back from the project is no longer anyone else's default.
        db.prepare('DELETE FROM saved_view_default WHERE view_id = ? AND owner_key <> ?').run(row.id, owner.key)
      }
      return viewById(db, owner, row.id)
    }
    if (input.page === undefined || input.name === undefined) {
      throw new TaskError('A new view needs a name and a page; pass id to change an existing one')
    }
    const page = checkPage(input.page)
    const name = checkName(input.name)
    assertNameFree(db, owner, page, name, null)
    const id = randomUUID()
    db.prepare(
      `INSERT INTO saved_view (id, page, name, filter, grouping, columns, shared, owner_key, owner_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      page,
      name,
      JSON.stringify(checkFilter(db, input.filter ?? {})),
      groupingFor(page, input.group ?? null),
      columnsFor(page, input.columns ?? null),
      input.shared ? 1 : 0,
      owner.key,
      owner.name,
      now,
      now,
    )
    return viewById(db, owner, id)
  })
}

function groupingFor(page: ViewPage, group: ViewGrouping): ViewGrouping {
  if (group !== null && group !== 'assignee') {
    throw new TaskError(`No grouping "${String(group)}"; the board groups by "assignee" or not at all (null)`)
  }
  if (group !== null && page !== 'board') {
    throw new TaskError('Only a board view has a grouping')
  }
  return group
}

/** A tasks view's columns as stored: a JSON array of known, distinct columns that includes the required ones; null for the default set. */
function columnsFor(page: ViewPage, columns: unknown): string | null {
  if (columns === null) {
    return null
  }
  if (page !== 'tasks') {
    throw new TaskError('Only a tasks view has columns')
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TaskError(`columns must be a non-empty list of: ${TASK_COLUMNS.join(', ')}`)
  }
  const unknown = columns.filter((column) => !TASK_COLUMNS.includes(column))
  if (unknown.length) {
    throw new TaskError(
      `No column ${unknown.map((column) => `"${String(column)}"`).join(', ')}; the columns are: ${TASK_COLUMNS.join(', ')}.${didYouMean(String(unknown[0]), TASK_COLUMNS)}`,
    )
  }
  if (new Set(columns).size !== columns.length) {
    throw new TaskError('columns lists a column more than once')
  }
  const missing = REQUIRED_TASK_COLUMNS.filter((column) => !columns.includes(column))
  if (missing.length) {
    throw new TaskError(`columns must include ${REQUIRED_TASK_COLUMNS.join(' and ')}, so a row says which task it is`)
  }
  return JSON.stringify(columns)
}

function assertNameFree(db: Db, owner: ViewOwner, page: ViewPage, name: string, except: string | null): void {
  const clash = db
    .prepare('SELECT id FROM saved_view WHERE owner_key = ? AND page = ? AND name = ? COLLATE NOCASE AND id IS NOT ?')
    .get(owner.key, page, name, except)
  if (clash) {
    throw new TaskError(`You already have a ${page} view called "${name}"`)
  }
}

export function deleteView(db: Db, owner: ViewOwner, input: ViewDeleteInput): { deleted: string } {
  const row = resolve(db, owner, input.view)
  if (row.owner_key !== owner.key) {
    throw new TaskError(`"${row.name}" is ${row.owner_name}'s view; only they can delete it`)
  }
  db.prepare('DELETE FROM saved_view WHERE id = ?').run(row.id)
  return { deleted: row.id }
}

export function setDefaultView(db: Db, owner: ViewOwner, input: ViewSetDefaultInput): SavedView | null {
  const page = checkPage(input.page)
  if (input.view === null) {
    db.prepare('DELETE FROM saved_view_default WHERE owner_key = ? AND page = ?').run(owner.key, page)
    return null
  }
  const row = resolve(db, owner, input.view, page)
  db.prepare(
    `INSERT INTO saved_view_default (owner_key, page, view_id) VALUES (?, ?, ?)
     ON CONFLICT (owner_key, page) DO UPDATE SET view_id = excluded.view_id`,
  ).run(owner.key, page, row.id)
  return viewById(db, owner, row.id)
}
