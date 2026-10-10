// Importing a project from OpenProject: the saved connection, the preview with
// its mappings, and the summary an import returns. One action does both steps
// (a preview until `confirm` is true), for the Settings dialog and for agents
// alike. The API token never appears here: only the name of the Secrets Store
// key it is kept under, resolved on the server.

import type { ActionInputs } from './action-inputs.ts'
import type { RelationType } from './dependencies.ts'
import type { Assignee, StatusCategory, TaskType } from './types.ts'

/**
 * Every Secrets Store key the import reads starts with this, so the import
 * can never be pointed at another stored secret.
 */
export const OPENPROJECT_SECRET_PREFIX = 'OPENPROJECT_'

/** The key name the dialog offers first. */
export const OPENPROJECT_DEFAULT_SECRET_KEY = 'OPENPROJECT_API_TOKEN'

/** Where the project comes from. `secretKey` is a Secrets Store key name, never a token. */
export interface OpenProjectConnection {
  /** The OpenProject address, e.g. `https://openproject.example.com`. */
  url: string
  /** The project's identifier (`my-project`) or numeric id. */
  project: string
  secretKey: string
}

/** What an OpenProject status becomes: one of ours (by id), or a new status created by the import. */
export type OpenProjectStatusTarget =
  | { status: number }
  | { create: { name: string; category: StatusCategory; color: string | null } }

/** What an OpenProject type becomes: one of our types, or `skip` to leave its work packages out. */
export type OpenProjectTypeTarget = TaskType | 'skip'

/**
 * How the source's statuses, types and people land here, each keyed by the
 * OpenProject id as a string. A person with no entry, or null, is kept by
 * name only: unassigned for an assignee, a plain name for an author.
 */
export interface OpenProjectMapping {
  statuses: Record<string, OpenProjectStatusTarget>
  types: Record<string, OpenProjectTypeTarget>
  people: Record<string, Assignee | null>
}

export interface OpenProjectCount {
  /** The OpenProject id. */
  id: string
  name: string
  count: number
}

export interface OpenProjectStatusCount extends OpenProjectCount {
  /** OpenProject marks it closed: a done status. */
  isClosed: boolean
  color: string | null
}

/** How often the import may run on its own, in minutes. */
export const OPENPROJECT_SYNC_MINUTES = [5, 15, 60] as const

/** Whether `minutes` is one of `OPENPROJECT_SYNC_MINUTES`, the only intervals `import_openproject_sync` takes. */
export function isSyncMinutes(minutes: number): minutes is (typeof OPENPROJECT_SYNC_MINUTES)[number] {
  return (OPENPROJECT_SYNC_MINUTES as readonly number[]).includes(minutes)
}

/** The fields a re-run carries over from OpenProject, and compares with what was edited here. */
export type OpenProjectField =
  | 'summary'
  | 'description'
  | 'status'
  | 'type'
  | 'priority'
  | 'assignee'
  | 'dates'
  | 'parent'

/**
 * A task edited here and changed in OpenProject since the last import, in the
 * same fields. The edits made here are kept unless the import is asked to
 * overwrite the task.
 */
export interface OpenProjectConflict {
  key: string
  summary: string
  /** Each field changed on both sides, as each side shows it now. */
  fields: Array<{ field: OpenProjectField; here: string | null; openProject: string | null }>
  /** True: OpenProject's values replace the edits here; false: the edits here stay. */
  overwritten: boolean
}

/** What an import would do with the mapping shown: tasks it creates, updates, and leaves as they are. */
export interface OpenProjectPlan {
  create: number
  update: number
  unchanged: number
}

/** The attachments an import would bring: files not imported before, their total size, and those over the limit. */
export interface OpenProjectAttachmentPlan {
  count: number
  /** Bytes, as OpenProject reports them. */
  bytes: number
  /** Over the per-file limit, so left out, with their work package and size. */
  skipped: OpenProjectSkipped[]
}

/** What an import did with attachments. Anything left out is in the result's `skipped`. */
export interface OpenProjectAttachmentsResult {
  added: number
  bytes: number
  /**
   * All the attachments earlier runs imported, still recorded as such, so
   * never added again: those still here and those removed here since. The
   * whole count, not only those on work packages read again in this run.
   */
  importedBefore: number
  /** Tasks whose description or comments now show an embedded image from the copy here. */
  rewritten: number
}

/** Step one: what the import would bring, and the mapping it would use. Nothing is written. */
export interface OpenProjectPreview {
  connection: OpenProjectConnection
  project: { id: number; identifier: string; name: string }
  workPackages: number
  /** Work packages imported before, by their OpenProject id: a re-run updates these instead of adding them again. */
  alreadyImported: number
  plan: OpenProjectPlan
  /** Tasks edited here that OpenProject also changed, and in which fields. */
  conflicts: OpenProjectConflict[]
  /** Files not imported yet, on the work packages changed since their attachments were last read. */
  attachments: OpenProjectAttachmentPlan
  /** OpenProject relations not imported yet between work packages that are or would be imported (a loop is still refused on import). */
  relations: number
  byType: OpenProjectCount[]
  byStatus: OpenProjectStatusCount[]
  /** Everyone who is an assignee or an author, with how many work packages they are on. */
  people: OpenProjectCount[]
  /** The saved mapping where there is one, else the suggested one: by name, and a new status for each unmatched one. */
  mapping: OpenProjectMapping
  /** Whether task numbers follow OpenProject's (`PROJ-12` becomes `<key>-12`) where they are still free. */
  keepNumbers: boolean
}

/** Something the import left out, and why. */
export interface OpenProjectSkipped {
  /** The work package, as OpenProject shows it (`PROJ-12`), or `#<id>`. */
  source: string
  summary: string
  reason: string
}

/** Step two: what the import did. */
export interface OpenProjectImportResult {
  created: number
  /** Imported before, with a field OpenProject changed since: brought up to date. */
  updated: number
  /** Imported before with nothing to take from OpenProject, so left as they are here. */
  unchanged: number
  /** Tasks edited here that OpenProject also changed, and what became of each. */
  conflicts: OpenProjectConflict[]
  /** Comments added; one imported before is never added twice. */
  comments: number
  /** Relations between the imported tasks. Absent from results saved before relations came with every import. */
  relations?: Omit<OpenProjectRelationsResult, 'imported' | 'skipped'>
  /** Files attached to the imported tasks. Absent from results saved before attachments were imported. */
  attachments?: OpenProjectAttachmentsResult
  statusesCreated: string[]
  skipped: OpenProjectSkipped[]
  /** Things adjusted on the way in that are not a skip, e.g. a parent outside the project. */
  notes: string[]
}

/** The scheduled import: every `minutes` while set, off while null. */
export interface OpenProjectSync {
  minutes: number | null
  /** The last scheduled run's failure, with when it was tried; null once one succeeds. */
  error: { at: string; message: string } | null
}

/** The saved connection, the last import and the schedule, for the dialog to start from. */
export interface OpenProjectImportState {
  connection: OpenProjectConnection | null
  lastImport: { at: string; by: string; result: OpenProjectImportResult } | null
  sync: OpenProjectSync
}

export interface OpenProjectImportInput {
  /** Only a person can set or change these; an agent uses the saved connection. */
  url?: string
  secretKey?: string
  /** Defaults to the saved project. */
  project?: string
  mapping?: Partial<OpenProjectMapping>
  keepNumbers?: boolean
  /** Keys of tasks whose edits here give way to OpenProject's values; every other conflict keeps the edits. */
  overwrite?: string[]
  /** True: import only the relations between tasks imported before, and nothing else. Every other import brings relations too. */
  relations?: boolean
  /** False (the default): return the preview. True: import. */
  confirm?: boolean
}

/**
 * A relations-only import, previewed (`imported: false`, nothing written) or
 * done. Each OpenProject relation is imported once: one removed here since is
 * not added back.
 */
export interface OpenProjectRelationsResult {
  imported: boolean
  /** Relations OpenProject has where both work packages were imported here. */
  found: number
  /** Added (or, in a preview, to add), by our relation type. */
  added: Record<RelationType, number>
  /** Imported by an earlier run, so left as they are here. */
  importedBefore: number
  /** Recorded here already, e.g. by hand, so nothing to add. */
  alreadyHere: number
  skipped: OpenProjectSkipped[]
}

export interface OpenProjectActionMap {
  import_openproject: {
    input: OpenProjectImportInput
    output: OpenProjectPreview | OpenProjectImportResult | OpenProjectRelationsResult
  }
  import_openproject_state: { input: ActionInputs['import_openproject_state']; output: OpenProjectImportState }
  import_openproject_sync: { input: ActionInputs['import_openproject_sync']; output: OpenProjectImportState }
}

export type OpenProjectActionId = keyof OpenProjectActionMap

type ImportAnswer = OpenProjectActionMap['import_openproject']['output']

/** An import result, told apart from a preview and a relations import. */
export function isImportResult(value: ImportAnswer): value is OpenProjectImportResult {
  return 'created' in value
}

/** A preview, told apart from the results. */
export function isPreview(value: ImportAnswer): value is OpenProjectPreview {
  return 'mapping' in value
}
