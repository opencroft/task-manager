// Importing OpenProject's attachments onto the tasks their work packages
// became, through the task manager's own attachment store, and pointing the
// images embedded in imported text at those copies. Each attachment is
// imported once, by its id there: a re-run adds new ones, and never one
// removed here since.
//
// Everything is read before anything is written: the lists, then the files
// into `incoming/` (see ../attachments/files.ts), so a failed read leaves the
// project as it was. A work package's list is read again only when it has
// changed since its last read, which adding an attachment in OpenProject does.

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { ATTACHMENT_MAX_BYTES } from '../../shared/attachments.ts'
import type { OpenProjectAttachmentPlan, OpenProjectAttachmentsResult, OpenProjectSkipped } from '../../shared/openproject.ts'
import type { Actor } from '../../shared/types.ts'
import { incomingDir } from '../attachments/files.ts'
import { TYPE_HEAD_BYTES, cleanName, placeFile } from '../attachments/store.ts'
import { transaction } from '../db.ts'
import { type Scope, TaskError, keyOf } from '../service.ts'
import { type OpenProjectClient, type SourceAttachment, type SourceWorkPackage, mapLimit } from './api.ts'
import { pointAtCopies, sourceLabel } from './mapping.ts'
import { sourceOf } from './store.ts'

// One request per work package, and then one per file: a few at a time.
const REQUESTS_AT_ONCE = 6

const megabytes = (bytes: number) => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`

/** What was read for one run: each work package's attachments, those still to import, and those too large. */
export interface AttachmentLists {
  /** By work package id, for every work package whose list was read. */
  lists: Map<number, SourceAttachment[]>
  /** Not imported before and within the limit. */
  wanted: SourceAttachment[]
  tooLarge: SourceAttachment[]
}

/** When each imported work package's attachments were last read, as its `updatedAt` then. */
function readMarks(scope: Scope, base: string): Map<string, string | null> {
  const rows = scope.db.prepare('SELECT source_id, attachments_read_at FROM task_source WHERE source = ?').all(sourceOf(base)) as Array<{
    source_id: string
    attachments_read_at: string | null
  }>
  return new Map(rows.map((row) => [row.source_id, row.attachments_read_at]))
}

/** OpenProject attachment ids imported before. */
function importedIds(scope: Scope, base: string): Set<string> {
  const rows = scope.db.prepare('SELECT source_id FROM attachment_source WHERE source = ?').all(sourceOf(base)) as Array<{ source_id: string }>
  return new Set(rows.map((row) => row.source_id))
}

/**
 * The attachment lists of `workPackages` changed since their attachments were
 * last read (all of them, the first time), and which files a run would bring.
 */
export async function readAttachmentLists(scope: Scope, client: OpenProjectClient, workPackages: SourceWorkPackage[]): Promise<AttachmentLists> {
  const marks = readMarks(scope, client.base)
  const unread = workPackages.filter((wp) => marks.get(String(wp.id)) !== wp.updatedAt)
  const read = await mapLimit(unread, REQUESTS_AT_ONCE, (wp) => client.attachments(wp.id))
  const lists = new Map(unread.map((wp, index) => [wp.id, read[index] ?? []]))
  const known = importedIds(scope, client.base)
  const fresh = [...lists.values()].flat().filter((attachment) => !known.has(String(attachment.id)))
  return {
    lists,
    wanted: fresh.filter((attachment) => attachment.fileSize <= ATTACHMENT_MAX_BYTES),
    tooLarge: fresh.filter((attachment) => attachment.fileSize > ATTACHMENT_MAX_BYTES),
  }
}

function tooLargeSkips(tooLarge: SourceAttachment[], labelOf: (workPackageId: number) => string): OpenProjectSkipped[] {
  return tooLarge.map((attachment) => ({
    source: labelOf(attachment.workPackageId),
    summary: `${attachment.fileName} (${megabytes(attachment.fileSize)})`,
    reason: `Over the ${megabytes(ATTACHMENT_MAX_BYTES)} limit per file`,
  }))
}

/** What a preview says about attachments: how many files, how many bytes, and which are too large. */
export function planAttachments(read: AttachmentLists, labelOf: (workPackageId: number) => string): OpenProjectAttachmentPlan {
  return {
    count: read.wanted.length,
    bytes: read.wanted.reduce((sum, attachment) => sum + attachment.fileSize, 0),
    skipped: tooLargeSkips(read.tooLarge, labelOf),
  }
}

/** A file read into `incoming/`, not yet an attachment. */
interface Fetched {
  file: string
  size: number
  head: Uint8Array
}

/** One attachment's bytes into a new file in `dir`: refused past the limit, or when they do not match OpenProject's checksum. */
async function fetchOne(client: OpenProjectClient, dir: string, attachment: SourceAttachment): Promise<Fetched> {
  const file = path.join(dir, randomUUID())
  const md5 = createHash('md5')
  let size = 0
  let head: Uint8Array = new Uint8Array(0)
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > ATTACHMENT_MAX_BYTES) {
        done(new TaskError(`Over the ${megabytes(ATTACHMENT_MAX_BYTES)} limit per file`))
        return
      }
      if (head.length < TYPE_HEAD_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, TYPE_HEAD_BYTES - head.length)])
      }
      md5.update(chunk)
      done(null, chunk)
    },
  })
  try {
    const body = await client.attachmentContent(attachment.id)
    await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), count, fs.createWriteStream(file))
    if (attachment.md5 && md5.digest('hex') !== attachment.md5.toLowerCase()) {
      throw new TaskError('The bytes read do not match OpenProject’s checksum for the file')
    }
    return { file, size, head }
  } catch (error) {
    fs.rmSync(file, { force: true })
    throw error
  }
}

/** Every wanted file into `incoming/`, a few at a time; a file that fails is reported, not fatal. */
export async function fetchFiles(
  client: OpenProjectClient,
  dataDir: string,
  wanted: SourceAttachment[],
): Promise<{ files: Map<number, Fetched>; failed: Map<number, string> }> {
  const dir = incomingDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const files = new Map<number, Fetched>()
  const failed = new Map<number, string>()
  await mapLimit(wanted, REQUESTS_AT_ONCE, async (attachment) => {
    try {
      files.set(attachment.id, await fetchOne(client, dir, attachment))
    } catch (error) {
      // A cancelled import stops; any other failure is this file's alone.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      failed.set(attachment.id, error instanceof Error ? error.message : String(error))
    }
  })
  return { files, failed }
}

/** Remove fetched files that did not become attachments. */
export function dropFetched(files: Map<number, Fetched>): void {
  for (const { file } of files.values()) {
    fs.rmSync(file, { force: true })
  }
}

export interface WriteAttachmentsInput {
  base: string
  workPackages: SourceWorkPackage[]
  read: AttachmentLists
  files: Map<number, Fetched>
  failed: Map<number, string>
  /** Who uploaded a file here: the uploader as the mapping has them, else by name. */
  uploader(authorId: string | null, authorName: string | null): Actor
}

/**
 * The fetched files as attachments of the tasks their work packages became,
 * one work package at a time, and each list marked read unless one of its
 * files failed (so the next run tries that one again). Then the images in
 * the imported descriptions and comments point at the copies.
 */
export function writeAttachments(scope: Scope, input: WriteAttachmentsInput): OpenProjectAttachmentsResult & { skipped: OpenProjectSkipped[] } {
  const origin = sourceOf(input.base)
  const tasks = new Map(
    (
      scope.db
        .prepare('SELECT ts.source_id, t.id, t.number FROM task_source ts JOIN task t ON t.id = ts.task_id WHERE ts.source = ?')
        .all(origin) as Array<{ source_id: string; id: number; number: number }>
    ).map((row) => [row.source_id, { id: row.id, number: row.number }]),
  )
  const byId = new Map(input.workPackages.map((wp) => [wp.id, wp]))
  const labelOf = (workPackageId: number) => {
    const wp = byId.get(workPackageId)
    return wp ? sourceLabel(wp) : `#${workPackageId}`
  }
  const known = importedIds(scope, input.base)
  const remember = scope.db.prepare('INSERT INTO attachment_source (source, source_id, task_id, attachment_id, imported_at) VALUES (?, ?, ?, ?, ?)')
  const mark = scope.db.prepare('UPDATE task_source SET attachments_read_at = ? WHERE task_id = ?')
  const now = new Date().toISOString()
  const touched = new Set<number>()
  const skipped: OpenProjectSkipped[] = tooLargeSkips(input.read.tooLarge, labelOf)
  let added = 0
  let bytes = 0

  for (const [workPackageId, list] of input.read.lists) {
    const wp = byId.get(workPackageId)
    const task = tasks.get(String(workPackageId))
    if (!wp || !task) {
      // Its type is left out, so there is no task to attach to.
      continue
    }
    const placed: string[] = []
    try {
      transaction(scope.db, () => {
        let complete = true
        for (const attachment of list) {
          if (known.has(String(attachment.id)) || attachment.fileSize > ATTACHMENT_MAX_BYTES) {
            continue
          }
          const fetched = input.files.get(attachment.id)
          if (!fetched) {
            complete = false
            skipped.push({
              source: labelOf(workPackageId),
              summary: attachment.fileName,
              reason: `Could not be read: ${input.failed.get(attachment.id) ?? 'not fetched'}. The next import tries again.`,
            })
            continue
          }
          const { attachment: stored, file } = placeFile(scope, task.id, {
            name: cleanName(attachment.fileName),
            file: fetched.file,
            size: fetched.size,
            head: fetched.head,
            uploader: input.uploader(attachment.authorId, attachment.authorName),
            createdAt: attachment.createdAt || now,
          })
          placed.push(file)
          remember.run(origin, String(attachment.id), task.id, stored.id, now)
          added++
          bytes += fetched.size
          touched.add(task.number)
        }
        if (complete) {
          mark.run(wp.updatedAt, task.id)
        }
      })
    } catch (error) {
      for (const file of placed) {
        fs.rmSync(file, { force: true })
      }
      throw error
    }
  }

  const rewritten = rewriteImportedTexts(scope, input.base)
  for (const number of rewritten) {
    touched.add(number)
  }
  if (touched.size > 0) {
    scope.notify(
      [...touched].map((number) => keyOf(scope, number)),
      'task',
    )
  }
  // Every one imported by an earlier run, whether or not its list was read again this time.
  return { added, bytes, importedBefore: known.size, rewritten: rewritten.size, skipped }
}

/** Our copy of each OpenProject attachment imported here and still attached, by its OpenProject id. */
export function copiesOf(scope: Scope, base: string): Map<string, string> {
  const rows = scope.db
    .prepare('SELECT s.source_id, s.attachment_id FROM attachment_source s JOIN task_attachment a ON a.id = s.attachment_id WHERE s.source = ?')
    .all(sourceOf(base)) as Array<{ source_id: string; attachment_id: string }>
  return new Map(rows.map((row) => [row.source_id, row.attachment_id]))
}

/**
 * Point the images in imported tasks' descriptions and comments at the
 * copies, and the same in what the import last wrote (`task_source.imported`),
 * so the next run compares like with like. Text edited here is rewritten too:
 * only the image's address changes. Returns the numbers of the tasks changed.
 */
function rewriteImportedTexts(scope: Scope, base: string): Set<number> {
  const copies = copiesOf(scope, base)
  const changed = new Set<number>()
  if (copies.size === 0) {
    return changed
  }
  const origin = sourceOf(base)
  const pattern = '%attachments/%'
  const rewrite = (text: string) => pointAtCopies(text, base, copies)
  transaction(scope.db, () => {
    const tasks = scope.db
      .prepare(
        `SELECT t.id, t.number, t.description, ts.imported FROM task_source ts JOIN task t ON t.id = ts.task_id
         WHERE ts.source = ? AND (t.description LIKE ? OR ts.imported LIKE ?)`,
      )
      .all(origin, pattern, pattern) as Array<{ id: number; number: number; description: string; imported: string | null }>
    const setDescription = scope.db.prepare('UPDATE task SET description = ? WHERE id = ?')
    const setImported = scope.db.prepare('UPDATE task_source SET imported = ? WHERE task_id = ?')
    for (const task of tasks) {
      const description = rewrite(task.description)
      if (description !== task.description) {
        setDescription.run(description, task.id)
        changed.add(task.number)
      }
      if (task.imported) {
        const imported = JSON.parse(task.imported) as { description?: string }
        if (typeof imported.description === 'string') {
          const next = rewrite(imported.description)
          if (next !== imported.description) {
            setImported.run(JSON.stringify({ ...imported, description: next }), task.id)
          }
        }
      }
    }
    const comments = scope.db
      .prepare(
        `SELECT c.id, c.body, t.number FROM comment c JOIN task t ON t.id = c.task_id JOIN task_source ts ON ts.task_id = t.id
         WHERE ts.source = ? AND c.body LIKE ?`,
      )
      .all(origin, pattern) as Array<{ id: number; body: string; number: number }>
    const setBody = scope.db.prepare('UPDATE comment SET body = ? WHERE id = ?')
    for (const comment of comments) {
      const body = rewrite(comment.body)
      if (body !== comment.body) {
        setBody.run(body, comment.id)
        changed.add(comment.number)
      }
    }
  })
  return changed
}
