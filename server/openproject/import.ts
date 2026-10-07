// The OpenProject import from connection to result: which connection a call
// may use, the token for it, reading the project, and then the preview or the
// import. Kept apart from the action seam in ./index.ts so it runs without the
// host: the tests pass their own secrets and fetch.
//
// The token is looked up in the Secrets Store by the key name saved with the
// connection, used for the requests and dropped. Only a signed-in person sets
// the address and key name: any other caller can only use what a person saved,
// so no call can send a stored secret to an address of the caller's choosing.
// And the key must be an OpenProject one, so a person cannot send another
// stored secret (a password, another service's token) there either.

import type {
  OpenProjectConnection,
  OpenProjectImportInput,
  OpenProjectImportResult,
  OpenProjectPreview,
  OpenProjectRelationsResult,
} from '../../shared/openproject.ts'
import { OPENPROJECT_SECRET_PREFIX } from '../../shared/openproject.ts'
import { type Scope, TaskError, listStatuses } from '../service.ts'
import { type Fetch, type OpenProjectClient, type SourceComment, mapLimit, normalizeBaseUrl, openProjectClient } from './api.ts'
import { type SourceData, peopleCounts, resolveMapping, sourceLabel, statusCounts, suggestMapping, typeCounts } from './mapping.ts'
import { applyImport, peopleOf } from './apply.ts'
import { copiesOf, dropFetched, fetchFiles, planAttachments, readAttachmentLists, writeAttachments } from './attachments.ts'
import { applyRelations, countNewRelations } from './relations.ts'
import { countImported, importedVersions, readConnection, readSavedMapping, readState, saveConnection, saveLastResult } from './store.ts'

/** What an import needs from outside the database; the tests pass their own. */
export interface ImportDeps {
  /** True only when a signed-in person called from the App: the one caller that may set the address or the key name. */
  byPerson: boolean
  resolveSecret(key: string): Promise<string | null>
  fetch?: Fetch
  signal?: AbortSignal
}

// Comments are one request per work package; a few at a time keeps the
// import quick without hammering the server.
const COMMENT_REQUESTS_AT_ONCE = 6

/** A Secrets Store key name the import may read: one set aside for OpenProject. */
export function cleanSecretKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key.toUpperCase().startsWith(OPENPROJECT_SECRET_PREFIX) || key.length > 200) {
    throw new TaskError(
      `The Secrets Store key must start with ${OPENPROJECT_SECRET_PREFIX} (e.g. ${OPENPROJECT_SECRET_PREFIX}API_TOKEN), so no other stored secret is ever sent to OpenProject.`,
    )
  }
  return key
}

function connectionFor(scope: Scope, input: OpenProjectImportInput, byPerson: boolean): OpenProjectConnection {
  const saved = readConnection(scope)
  const url = input.url === undefined ? saved?.url : normalizeBaseUrl(input.url)
  const secretKey = input.secretKey === undefined ? saved?.secretKey : cleanSecretKey(input.secretKey)
  if (!byPerson && ((url !== undefined && url !== saved?.url) || (secretKey !== undefined && secretKey !== saved?.secretKey))) {
    throw new TaskError(
      'Only a person sets the OpenProject address and the Secrets Store key, in Settings → Import. Call without url and secretKey to use the saved ones.',
    )
  }
  if (!url || !secretKey) {
    throw new TaskError(
      byPerson
        ? 'Give the OpenProject address (url) and the name of the Secrets Store key that holds the API token (secretKey).'
        : 'No OpenProject connection is saved yet: a person connects one in Settings → Import first.',
    )
  }
  const project = String(input.project ?? saved?.project ?? '').trim()
  if (!project) {
    throw new TaskError('Name the OpenProject project (project): its identifier, as in its address, or its id.')
  }
  return { url, secretKey, project }
}

async function clientFor(connection: OpenProjectConnection, deps: ImportDeps): Promise<OpenProjectClient> {
  // A saved key is checked again here rather than trusted, so one that breaks the prefix rule is never read.
  const token = await deps.resolveSecret(cleanSecretKey(connection.secretKey))
  if (!token) {
    throw new TaskError(`The Secrets Store has no key "${connection.secretKey}": store the OpenProject API token under it, or give the key it is under.`)
  }
  return openProjectClient({ url: connection.url, token, secretKey: connection.secretKey, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.signal ? { signal: deps.signal } : {}) })
}

async function readSource(client: OpenProjectClient, projectId: number): Promise<SourceData> {
  const [workPackages, statuses, types] = await Promise.all([client.workPackages(projectId), client.statuses(), client.types(projectId)])
  const people = new Map<string, string>()
  for (const wp of workPackages) {
    if (wp.assigneeId && wp.assigneeName) people.set(wp.assigneeId, wp.assigneeName)
    if (wp.authorId && wp.authorName) people.set(wp.authorId, wp.authorName)
  }
  return { workPackages, statuses, types, people }
}

/**
 * The comments of each work package new or changed since it was imported, and
 * the names of commenters not met on a work package. A comment in OpenProject
 * changes its work package's `updatedAt`, so the others have none unread.
 */
async function readComments(client: OpenProjectClient, source: SourceData, imported: Map<string, string>): Promise<Map<number, SourceComment[]>> {
  const changed = source.workPackages.filter((wp) => imported.get(String(wp.id)) !== wp.updatedAt)
  const lists = await mapLimit(changed, COMMENT_REQUESTS_AT_ONCE, (wp) => client.comments(wp.id))
  const comments = new Map(changed.map((wp, index) => [wp.id, lists[index] ?? []]))
  const unknown = [...new Set(lists.flat().map((comment) => comment.userId))].filter((id): id is string => id !== null && !source.people.has(id))
  const names = await mapLimit(unknown, COMMENT_REQUESTS_AT_ONCE, (id) => client.userName(id))
  unknown.forEach((id, index) => source.people.set(id, names[index] ?? `OpenProject user ${id}`))
  return comments
}

export async function importOpenProject(
  scope: Scope,
  input: OpenProjectImportInput,
  deps: ImportDeps,
): Promise<OpenProjectPreview | OpenProjectImportResult | OpenProjectRelationsResult> {
  const connection = connectionFor(scope, input, deps.byPerson)
  const client = await clientFor(connection, deps)
  if (input.relations === true) {
    // Only what links the tasks imported before; their work packages are not read again.
    return applyRelations(scope, client.base, await client.relations(), input.confirm === true)
  }
  const project = await client.project(connection.project)
  const source = await readSource(client, project.id)
  if (deps.byPerson) {
    saveConnection(scope, connection)
  }
  const saved = readSavedMapping(scope)
  const keepNumbers = typeof input.keepNumbers === 'boolean' ? input.keepNumbers : saved.keepNumbers
  const [agents, people] = await Promise.all([scope.agents(), scope.people()])
  const ours = listStatuses(scope)
  const overwrite = cleanOverwrite(input.overwrite)

  const labelOf = (id: number) => {
    const wp = source.workPackages.find((candidate) => candidate.id === id)
    return wp ? sourceLabel(wp) : `#${id}`
  }

  if (input.confirm !== true) {
    const mapping = resolveMapping(suggestMapping(source, ours, agents, people), [saved.mapping, input.mapping], ours, agents, people)
    // The import itself, rolled back: its counts and conflicts are what confirming would do.
    const planned = applyImport(scope, { base: client.base, project, source, comments: new Map(), mapping, keepNumbers, overwrite, dryRun: true })
    const landing = landingWorkPackages(source, mapping)
    const [attachments, relations] = await Promise.all([readAttachmentLists(scope, client, landing), client.relations()])
    return {
      connection,
      project,
      workPackages: source.workPackages.length,
      alreadyImported: countImported(scope, client.base, source.workPackages.map((wp) => wp.id)),
      plan: { create: planned.created, update: planned.updated, unchanged: planned.unchanged },
      conflicts: planned.conflicts,
      attachments: planAttachments(attachments, labelOf),
      relations: countNewRelations(scope, client.base, relations, new Set(landing.map((wp) => wp.id))),
      byType: typeCounts(source),
      byStatus: statusCounts(source),
      people: peopleCounts(source),
      mapping,
      keepNumbers,
    }
  }

  // Everything is read before anything is written, so a failed read changes nothing.
  const comments = await readComments(client, source, importedVersions(scope, client.base))
  // Suggested after the comments are read, so their authors are mapped too.
  const suggested = suggestMapping(source, ours, agents, people)
  const mapping = resolveMapping(suggested, [saved.mapping, input.mapping], ours, agents, people)
  const landing = landingWorkPackages(source, mapping)
  const [attachments, relations] = await Promise.all([readAttachmentLists(scope, client, landing), client.relations()])
  const { files, failed } = await fetchFiles(client, requireDataDir(scope), attachments.wanted)
  try {
    const result = applyImport(scope, { base: client.base, project, source, comments, copies: copiesOf(scope, client.base), mapping, keepNumbers, overwrite })
    const linked = applyRelations(scope, client.base, relations, true)
    const attached = writeAttachments(scope, {
      base: client.base,
      workPackages: landing,
      read: attachments,
      files,
      failed,
      uploader: peopleOf(source, mapping).actor,
    })
    const { imported: _imported, skipped: relationSkips, ...relationCounts } = linked
    const { skipped: attachmentSkips, ...attachmentCounts } = attached
    const outcome: OpenProjectImportResult = {
      ...result,
      relations: relationCounts,
      attachments: attachmentCounts,
      skipped: [...result.skipped, ...relationSkips, ...attachmentSkips],
    }
    saveLastResult(scope, outcome)
    return outcome
  } finally {
    // Files that became attachments were moved away; any left were not used.
    dropFetched(files)
  }
}

/** The work packages an import brings with this mapping: those of a type not left out. */
function landingWorkPackages(source: SourceData, mapping: { types: Record<string, string> }) {
  return source.workPackages.filter((wp) => {
    const type = mapping.types[wp.typeId]
    return type !== undefined && type !== 'skip'
  })
}

function requireDataDir(scope: Scope): string {
  if (!scope.dataDir) {
    throw new Error(`Instance ${scope.instanceId} has no data directory for attachment files`)
  }
  return scope.dataDir
}

function cleanOverwrite(value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || !value.every((key) => typeof key === 'string')) {
    throw new TaskError('overwrite is a list of task keys, e.g. ["TASK-12"].')
  }
  return value
}

/**
 * The scheduled import: the saved connection and mapping, confirmed, keeping
 * every edit made here. Like any confirmed import, it brings new relations
 * and attachments too. It runs only after a first import, so what it maps
 * with is a mapping someone has seen.
 */
export async function syncOpenProject(scope: Scope, deps: Omit<ImportDeps, 'byPerson'>): Promise<OpenProjectImportResult | null> {
  if (!readState(scope).lastImport) {
    return null
  }
  return (await importOpenProject(scope, { confirm: true }, { ...deps, byPerson: false })) as OpenProjectImportResult
}
