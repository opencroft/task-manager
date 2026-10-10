// Writing an OpenProject import into the project's database, in one
// transaction: statuses the mapping creates, then every work package as a
// task (created, or brought up to date where OpenProject changed it since the
// last run), then the hierarchy, the backlog order, and the comments not
// imported yet. Assignees are not notified and workflows do not start: the
// tasks arrive as records of work already done elsewhere.
//
// What was edited here stays. Each imported task remembers the values the
// import last wrote to it: a field still holding them takes OpenProject's new
// value, a field edited here since keeps the edit. Where OpenProject changed
// that same field too, the task is a conflict: listed in the result, and
// given OpenProject's values only when the caller names it in `overwrite`.

import type {
  OpenProjectConflict,
  OpenProjectField,
  OpenProjectImportResult,
  OpenProjectMapping,
  OpenProjectSkipped,
} from '../../shared/openproject.ts'
import type { Actor, Assignee } from '../../shared/types.ts'
import { transaction } from '../db.ts'
import { evenRanks } from '../rank.ts'
import { keyOf, listStatuses, record, type Scope, TaskError } from '../service.ts'
import type { SourceComment, SourceProject } from './api.ts'
import {
  isAutomaticNote,
  mapDates,
  mapMarkdown,
  mapPriority,
  mapSummary,
  type SourceData,
  sourceLabel,
  sourceNumber,
} from './mapping.ts'
import { sourceOf } from './store.ts'

export interface ImportInput {
  base: string
  project: SourceProject
  source: SourceData
  /** Each work package's comments, by work package id; one left out adds none. */
  comments: Map<number, SourceComment[]>
  /** Attachments imported before, OpenProject id to ours: images embedding them show the copy. */
  copies?: ReadonlyMap<string, string>
  mapping: OpenProjectMapping
  keepNumbers: boolean
  /** Keys of tasks whose conflicts take OpenProject's values; any other conflict keeps the edits made here. */
  overwrite?: readonly string[]
  /** Work everything out and write nothing: what a preview reports. */
  dryRun?: boolean
}

/** A task's fields that a work package sets, as the import last wrote them (`task_source.imported`). */
interface Imported {
  summary: string
  description: string
  status: number
  type: string
  priority: string
  assignee: { kind: string; id: string | null; name: string } | null
  start: string | null
  end: string | null
  parent: number | null
}

type TaskField = Exclude<OpenProjectField, 'parent'>

/** Each field as one comparable value. */
const COMPARED: Record<TaskField, (value: Imported) => unknown> = {
  summary: (value) => value.summary,
  description: (value) => value.description,
  status: (value) => value.status,
  type: (value) => value.type,
  priority: (value) => value.priority,
  assignee: (value) =>
    value.assignee ? `${value.assignee.kind}:${value.assignee.id ?? ''}:${value.assignee.name}` : null,
  dates: (value) => `${value.start}|${value.end}`,
}
const TASK_FIELDS = Object.keys(COMPARED) as TaskField[]

const same = (field: TaskField, a: Imported, b: Imported) => COMPARED[field](a) === COMPARED[field](b)

/**
 * Per field, from what was imported last (`base`), what the task holds now
 * (`here`) and what OpenProject has now (`theirs`): the fields to take from
 * OpenProject, and those both sides changed differently. A field only edited
 * here is in neither.
 */
function mergeFields(base: Imported, here: Imported, theirs: Imported): { take: TaskField[]; clash: TaskField[] } {
  const take: TaskField[] = []
  const clash: TaskField[] = []
  for (const field of TASK_FIELDS) {
    if (same(field, base, theirs) || same(field, here, theirs)) {
      continue
    }
    ;(same(field, base, here) ? take : clash).push(field)
  }
  return { take, clash }
}

interface ExistingRow {
  id: number
  number: number
  source_id: string
  source_updated_at: string
  imported: string | null
  summary: string
  description: string
  status_id: number
  type: string
  priority: string
  assignee_kind: string | null
  assignee_id: string | null
  assignee_name: string | null
  parent_id: number | null
  start_date: string | null
  end_date: string | null
}

function currentOf(row: ExistingRow): Imported {
  return {
    summary: row.summary,
    description: row.description,
    status: row.status_id,
    type: row.type,
    priority: row.priority,
    assignee:
      row.assignee_name === null
        ? null
        : { kind: row.assignee_kind ?? 'person', id: row.assignee_id, name: row.assignee_name },
    start: row.start_date,
    end: row.end_date,
    parent: row.parent_id,
  }
}

/** Thrown to roll a dry run back, carrying what it would have done. */
class DryRunResult extends Error {
  readonly result: OpenProjectImportResult

  constructor(result: OpenProjectImportResult) {
    super('dry run')
    this.result = result
  }
}

const now = () => new Date().toISOString()

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const clip = (text: string, length = 80) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/**
 * OpenProject users as the mapping has them: `person` as an assignee (null
 * when mapped to nobody), `actor` as the author of something, by name where
 * the mapping has no entry.
 */
export function peopleOf(source: SourceData, mapping: OpenProjectMapping) {
  const person = (id: string | null, fallback: string | null): Assignee | null => {
    if (!id) {
      return null
    }
    const target = mapping.people[id]
    return target === undefined
      ? { kind: 'person', name: source.people.get(id) ?? fallback ?? `OpenProject user ${id}` }
      : target
  }
  const actor = (id: string | null, fallback: string | null): Actor => {
    const mapped = person(id, fallback)
    const name = mapped?.name ?? (id ? source.people.get(id) : null) ?? fallback ?? 'OpenProject'
    return { kind: mapped?.kind ?? 'person', name }
  }
  return { person, actor }
}

export function applyImport(scope: Scope, input: ImportInput): OpenProjectImportResult {
  try {
    const result = transaction(scope.db, () => {
      const outcome = writeImport(scope, input)
      if (input.dryRun) {
        throw new DryRunResult(outcome)
      }
      return outcome
    })
    if (result.created + result.updated + result.comments > 0 || result.statusesCreated.length > 0) {
      scope.notify([], 'task')
    }
    if (result.statusesCreated.length > 0) {
      scope.notify([], 'status')
    }
    return result
  } catch (error) {
    if (error instanceof DryRunResult) {
      return error.result
    }
    throw error
  }
}

function writeImport(scope: Scope, input: ImportInput): OpenProjectImportResult {
  const { base, source, mapping } = input
  const origin = sourceOf(base)
  const skipped: OpenProjectSkipped[] = []
  const notes: string[] = []
  const statusesCreated: string[] = []
  let created = 0
  let matched = 0
  let comments = 0

  // Statuses first: every mapped source status as one of ours.
  const statusIdFor = new Map<string, number>()
  for (const [sourceId, target] of Object.entries(mapping.statuses)) {
    if ('status' in target) {
      statusIdFor.set(sourceId, target.status)
      continue
    }
    const sameName = listStatuses(scope).find(
      (status) => status.name.toLowerCase() === target.create.name.toLowerCase(),
    )
    if (sameName) {
      statusIdFor.set(sourceId, sameName.id)
      continue
    }
    const position = (
      scope.db.prepare('SELECT coalesce(max(position), -1) + 1 AS next FROM status').get() as { next: number }
    ).next
    const inserted = scope.db
      .prepare('INSERT INTO status (name, category, color, position) VALUES (?, ?, ?, ?)')
      .run(target.create.name, target.create.category, target.create.color, position)
    statusIdFor.set(sourceId, Number(inserted.lastInsertRowid))
    statusesCreated.push(target.create.name)
  }
  const statusNames = new Map(listStatuses(scope).map((status) => [status.id, status.name]))

  const existing = new Map(
    (
      scope.db
        .prepare(
          `SELECT t.*, ts.source_id, ts.source_updated_at, ts.imported
           FROM task_source ts JOIN task t ON t.id = ts.task_id
           WHERE ts.source = ?`,
        )
        .all(origin) as unknown as ExistingRow[]
    ).map((row) => [row.source_id, row]),
  )

  const { person, actor } = peopleOf(source, mapping)

  // Numbers: OpenProject's where asked and still free, at or past the
  // project's next number (numbers of deleted tasks are never reused).
  const meta = scope.db.prepare("SELECT value FROM project_meta WHERE key = 'next_number'").get() as { value: string }
  const firstFree = Number(meta.value)
  const used = new Set(
    (scope.db.prepare('SELECT number FROM task').all() as Array<{ number: number }>).map((row) => row.number),
  )
  const wanted = new Set(
    input.keepNumbers ? source.workPackages.filter((wp) => !existing.has(String(wp.id))).map(sourceNumber) : [],
  )
  let next = firstFree
  const allocate = (preferred: number | null): number => {
    if (preferred !== null && preferred >= firstFree && !used.has(preferred)) {
      used.add(preferred)
      return preferred
    }
    while (used.has(next) || wanted.has(next)) {
      next++
    }
    used.add(next)
    return next
  }

  const overwrite = new Set((input.overwrite ?? []).map((key) => key.trim().toUpperCase()))
  const overwritten = (number: number) => overwrite.has(keyOf(scope, number).toUpperCase())
  const describe = (
    field: OpenProjectField,
    value: Imported,
    keyOfTask: (id: number) => string | null,
  ): string | null => {
    switch (field) {
      case 'summary':
        return value.summary
      case 'description':
        return clip(value.description)
      case 'status':
        return statusNames.get(value.status) ?? null
      case 'type':
        return value.type
      case 'priority':
        return value.priority
      case 'assignee':
        return value.assignee?.name ?? null
      case 'dates':
        return value.start ? `${value.start} → ${value.end}` : null
      case 'parent':
        return value.parent === null ? null : keyOfTask(value.parent)
    }
  }
  const noKeys = () => null

  const insertTask = scope.db.prepare(
    `INSERT INTO task (number, summary, description, status_id, type, priority, assignee_kind, assignee_id, assignee_name,
       reporter_kind, reporter_name, rank, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updateTask = scope.db.prepare(
    `UPDATE task SET summary = ?, description = ?, status_id = ?, type = ?, priority = ?, assignee_kind = ?, assignee_id = ?,
       assignee_name = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`,
  )
  const insertSource = scope.db.prepare(
    'INSERT INTO task_source (task_id, source, source_id, source_updated_at) VALUES (?, ?, ?, ?)',
  )
  const taskIdOf = new Map<number, number>()
  const numberOf = new Map<number, number>()
  const placed: number[] = []
  const fresh: number[] = []
  const skippedIds = new Set<number>()
  const changedIds = new Set<number>()
  // For each task placed: what OpenProject has now (written back as the new
  // `imported` at the end), and for one imported before, what it had last time.
  const theirsOf = new Map<number, Imported>()
  const baseOf = new Map<number, Imported>()
  const clashes = new Map<number, { fields: OpenProjectConflict['fields']; overwritten: boolean }>()

  for (const wp of source.workPackages) {
    const type = mapping.types[wp.typeId]
    if (type === undefined || type === 'skip') {
      skippedIds.add(wp.id)
      skipped.push({ source: sourceLabel(wp), summary: wp.subject, reason: `Type "${wp.typeName}" is set to skip` })
      continue
    }
    const statusId = statusIdFor.get(wp.statusId)
    if (statusId === undefined) {
      throw new TaskError(`Status "${wp.statusName}" of ${sourceLabel(wp)} has no mapping`)
    }
    const assignee = person(wp.assigneeId, wp.assigneeName)
    const { start, end } = mapDates(wp)
    const theirs: Imported = {
      summary: mapSummary(wp.subject, wp.id),
      description: mapMarkdown(wp.description, base, input.copies),
      status: statusId,
      type,
      priority: mapPriority(wp.priorityName),
      assignee: assignee ? { kind: assignee.kind, id: assignee.id ?? null, name: assignee.name } : null,
      start,
      end,
      parent: null,
    }
    const before = existing.get(String(wp.id))

    if (before) {
      matched++
      taskIdOf.set(wp.id, before.id)
      numberOf.set(before.id, before.number)
      if (before.source_updated_at === wp.updatedAt) {
        continue
      }
      const here = currentOf(before)
      const last = before.imported ? (JSON.parse(before.imported) as Imported) : here
      const { take, clash } = mergeFields(last, here, theirs)
      const force = clash.length > 0 && overwritten(before.number)
      if (clash.length > 0) {
        clashes.set(before.id, {
          fields: clash.map((field) => ({
            field,
            here: describe(field, here, noKeys),
            openProject: describe(field, theirs, noKeys),
          })),
          overwritten: force,
        })
      }
      const next: Imported = { ...here }
      for (const field of force ? [...take, ...clash] : take) {
        if (field === 'dates') {
          next.start = theirs.start
          next.end = theirs.end
        } else {
          ;(next as unknown as Record<string, unknown>)[field] = theirs[field]
        }
      }
      const changed = TASK_FIELDS.filter((field) => !same(field, here, next))
      if (changed.length > 0) {
        updateTask.run(
          next.summary,
          next.description,
          next.status,
          next.type,
          next.priority,
          next.assignee?.kind ?? null,
          next.assignee?.id ?? null,
          next.assignee?.name ?? null,
          next.start,
          next.end,
          now(),
          before.id,
        )
        for (const field of changed) {
          const shown =
            field === 'description' ? [null, null] : [describe(field, here, noKeys), describe(field, next, noKeys)]
          record(scope, before.id, 'field', field, shown[0] ?? null, shown[1] ?? null)
        }
        changedIds.add(before.id)
      }
      scope.db.prepare('UPDATE task_source SET source_updated_at = ? WHERE task_id = ?').run(wp.updatedAt, before.id)
      baseOf.set(before.id, last)
      theirsOf.set(before.id, theirs)
      placed.push(wp.id)
      continue
    }

    const reporter = actor(wp.authorId, wp.authorName)
    const number = allocate(input.keepNumbers ? sourceNumber(wp) : null)
    const inserted = insertTask.run(
      number,
      theirs.summary,
      theirs.description,
      statusId,
      type,
      theirs.priority,
      assignee?.kind ?? null,
      assignee?.id ?? null,
      assignee?.name ?? null,
      reporter.kind,
      reporter.name,
      // Placeholder: every new task is ranked after the loop.
      'z',
      start,
      end,
      wp.createdAt || now(),
      now(),
    )
    const id = Number(inserted.lastInsertRowid)
    insertSource.run(id, origin, String(wp.id), wp.updatedAt)
    record(scope, id, 'created')
    taskIdOf.set(wp.id, id)
    numberOf.set(id, number)
    theirsOf.set(id, theirs)
    placed.push(wp.id)
    fresh.push(id)
    created++
  }

  // The hierarchy, for what was created or changed: each task under its
  // nearest imported ancestor, never under its own subtree. A parent chosen
  // here since the last import stays, like any other field edited here.
  const sourceById = new Map(source.workPackages.map((wp) => [wp.id, wp]))
  const parentOf = new Map(
    (scope.db.prepare('SELECT id, parent_id FROM task').all() as Array<{ id: number; parent_id: number | null }>).map(
      (row) => [row.id, row.parent_id],
    ),
  )
  const isAncestorOrSelf = (candidate: number, of: number) => {
    for (
      let at: number | null | undefined = of, steps = 0;
      at != null && steps < 10_000;
      at = parentOf.get(at), steps++
    ) {
      if (at === candidate) {
        return true
      }
    }
    return false
  }
  const keyOfTask = (id: number) => {
    const number =
      numberOf.get(id) ??
      (scope.db.prepare('SELECT number FROM task WHERE id = ?').get(id) as { number: number } | undefined)?.number
    return number === undefined ? null : keyOf(scope, number)
  }
  const setParent = scope.db.prepare('UPDATE task SET parent_id = ? WHERE id = ?')
  let outside = 0
  let refused = 0
  for (const wpId of placed) {
    const taskId = taskIdOf.get(wpId) as number
    let parentWp = sourceById.get(wpId)?.parentId ?? null
    const seen = new Set<number>()
    while (parentWp !== null && skippedIds.has(parentWp) && !seen.has(parentWp)) {
      seen.add(parentWp)
      parentWp = sourceById.get(parentWp)?.parentId ?? null
    }
    let parentTask: number | null = null
    if (parentWp !== null) {
      const found = taskIdOf.get(parentWp)
      if (found === undefined) {
        outside++
      } else {
        parentTask = found
      }
    }
    const theirs = theirsOf.get(taskId) as Imported
    theirs.parent = parentTask
    const current = parentOf.get(taskId) ?? null
    const last = baseOf.get(taskId)
    if (current === parentTask || (last && last.parent === parentTask)) {
      continue
    }
    if (last && last.parent !== current) {
      // Moved here and in OpenProject, to different parents.
      const force = overwritten(numberOf.get(taskId) as number)
      const clash = clashes.get(taskId) ?? { fields: [], overwritten: force }
      clash.fields.push({
        field: 'parent',
        here: describe('parent', { ...theirs, parent: current }, keyOfTask),
        openProject: describe('parent', theirs, keyOfTask),
      })
      clashes.set(taskId, clash)
      if (!force) {
        continue
      }
    }
    if (parentTask !== null && isAncestorOrSelf(taskId, parentTask)) {
      refused++
      continue
    }
    setParent.run(parentTask, taskId)
    parentOf.set(taskId, parentTask)
    if (last) {
      record(
        scope,
        taskId,
        'field',
        'parent',
        current === null ? null : keyOfTask(current),
        parentTask === null ? null : keyOfTask(parentTask),
      )
      changedIds.add(taskId)
    }
  }
  if (outside > 0) {
    notes.push(
      `${plural(outside, 'work package has its parent', 'work packages have their parent')} outside the project: imported as top-level tasks.`,
    )
  }
  if (refused > 0) {
    notes.push(
      `${plural(refused, 'task keeps its parent', 'tasks keep their parent')} here: OpenProject's would put a task under its own subtask.`,
    )
  }

  // What OpenProject had, as the next run's point of comparison.
  const setImported = scope.db.prepare('UPDATE task_source SET imported = ? WHERE task_id = ?')
  for (const [taskId, theirs] of theirsOf) {
    setImported.run(JSON.stringify(theirs), taskId)
  }

  // The backlog order: what was here stays first and in its order, the new
  // tasks follow in OpenProject's order. Respaced in one pass.
  if (fresh.length > 0) {
    const freshSet = new Set(fresh)
    const kept = (scope.db.prepare('SELECT id FROM task ORDER BY rank, id').all() as Array<{ id: number }>)
      .map((row) => row.id)
      .filter((id) => !freshSet.has(id))
    const order = [...kept, ...fresh]
    const ranks = evenRanks(order.length)
    const setRank = scope.db.prepare('UPDATE task SET rank = ? WHERE id = ?')
    for (const [index, id] of order.entries()) {
      setRank.run(ranks[index] as string, id)
    }
  }
  const highest = (scope.db.prepare('SELECT coalesce(max(number), 0) AS n FROM task').get() as { n: number }).n
  scope.db
    .prepare("UPDATE project_meta SET value = ? WHERE key = 'next_number'")
    .run(String(Math.max(firstFree, highest + 1)))

  // Comments not imported before, with their author and date.
  const knownComments = new Set(
    (
      scope.db.prepare('SELECT source_id FROM comment_source WHERE source = ?').all(origin) as Array<{
        source_id: string
      }>
    ).map((row) => row.source_id),
  )
  const insertComment = scope.db.prepare(
    'INSERT INTO comment (task_id, author_kind, author_name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertCommentSource = scope.db.prepare(
    'INSERT INTO comment_source (comment_id, source, source_id) VALUES (?, ?, ?)',
  )
  let internal = 0
  let automatic = 0
  for (const wp of source.workPackages) {
    const taskId = taskIdOf.get(wp.id)
    if (taskId === undefined) {
      continue
    }
    for (const comment of input.comments.get(wp.id) ?? []) {
      if (knownComments.has(String(comment.id))) {
        continue
      }
      if (comment.internal) {
        internal++
        continue
      }
      if (isAutomaticNote(comment.body)) {
        automatic++
        continue
      }
      const author = actor(comment.userId, null)
      const inserted = insertComment.run(
        taskId,
        author.kind,
        author.name,
        mapMarkdown(comment.body, base, input.copies),
        comment.createdAt || now(),
        comment.updatedAt || now(),
      )
      insertCommentSource.run(Number(inserted.lastInsertRowid), origin, String(comment.id))
      comments++
    }
  }
  if (internal > 0) {
    skipped.push({
      source: 'Comments',
      summary: plural(internal, 'internal comment', 'internal comments'),
      reason: 'Internal in OpenProject: only some members may read them there',
    })
  }
  if (automatic > 0) {
    notes.push(
      `${plural(automatic, 'automatic note', 'automatic notes')} ("Updated automatically by changing values within child work package") left out.`,
    )
  }

  const conflicts: OpenProjectConflict[] = [...clashes]
    .map(([taskId, clash]) => ({ taskId, number: numberOf.get(taskId) as number, ...clash }))
    .sort((a, b) => a.number - b.number)
    .map(({ taskId, number, fields, overwritten }) => ({
      key: keyOf(scope, number),
      summary: (scope.db.prepare('SELECT summary FROM task WHERE id = ?').get(taskId) as { summary: string }).summary,
      fields,
      overwritten,
    }))
  const conflictKeys = new Set(conflicts.map((conflict) => conflict.key.toUpperCase()))
  const strays = [...overwrite].filter((key) => !conflictKeys.has(key))
  if (strays.length > 0) {
    notes.push(
      `Nothing to overwrite on ${strays.join(', ')}: ${strays.length === 1 ? 'it has' : 'they have'} no conflict with OpenProject.`,
    )
  }
  const kept = conflicts.filter((conflict) => !conflict.overwritten).length
  if (kept > 0) {
    notes.push(
      `${plural(kept, 'task keeps', 'tasks keep')} the edits made here where OpenProject changed the same fields: see the conflicts.`,
    )
  }

  const outcome: OpenProjectImportResult = {
    created,
    updated: changedIds.size,
    unchanged: matched - changedIds.size,
    conflicts,
    comments,
    statusesCreated,
    skipped,
    notes,
  }
  scope.db
    .prepare(
      'UPDATE openproject_import SET mapping = ?, keep_numbers = ?, last_at = ?, last_by = ?, last_result = ? WHERE id = 1',
    )
    .run(JSON.stringify(mapping), input.keepNumbers ? 1 : 0, now(), scope.inv.actor.name, JSON.stringify(outcome))
  return outcome
}
