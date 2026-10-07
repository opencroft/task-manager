// Files attached to tasks: their metadata in the instance's database, their
// bytes in one file each (files.ts), attributed to whoever called, and
// recorded in the task's history.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  ATTACHMENT_MAX_BYTES,
  type TaskAttachInput,
  type TaskAttachment,
  type TaskAttachmentRenameInput,
} from '../../shared/attachments.ts'
import { transaction } from '../db.ts'
import { type Scope, TaskError, keyOf, record, requireRow, touch } from '../service.ts'
import { decideType } from './content-type.ts'
import { attachmentFile, attachmentsDir, incomingDir, removeGoneFiles } from './files.ts'

interface AttachmentRow {
  id: string
  task_id: number
  name: string
  size: number
  content_type: string
  previewable: number
  uploader_kind: 'agent' | 'person'
  uploader_name: string
  created_at: string
}

const NAME_MAX_LENGTH = 200

function toAttachment(row: AttachmentRow): TaskAttachment {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    previewable: row.previewable === 1,
    createdAt: row.created_at,
    uploader: { kind: row.uploader_kind, name: row.uploader_name },
  }
}

// Rounded up, so a file just over the limit never reads as equal to it.
const megabytes = (bytes: number) => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`

/** A file name as stored: its last path segment, without control characters, at most 200 characters with its extension kept. */
export function cleanName(name: unknown): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const clean = (base ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!clean || clean === '.' || clean === '..') {
    throw new TaskError('"name" must be a file name, e.g. "screenshot.png"')
  }
  if (clean.length <= NAME_MAX_LENGTH) {
    return clean
  }
  const dot = clean.lastIndexOf('.')
  const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
  return clean.slice(0, NAME_MAX_LENGTH - extension.length) + extension
}

/** The bytes of `contentBase64`, refused when it is not base64 or decodes past the limit. */
export function decodeContent(name: string, contentBase64: unknown): Buffer {
  const text = String(contentBase64 ?? '')
    .replace(/^data:[^,]*;base64,/, '')
    .replace(/\s+/g, '')
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new TaskError('"contentBase64" must be the file\'s bytes in base64 (a data: URL prefix is fine)')
  }
  const size = (text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0)
  if (size > ATTACHMENT_MAX_BYTES) {
    throw tooLarge(name, size)
  }
  return Buffer.from(text, 'base64')
}

function requireAttachment(scope: Scope, id: unknown): AttachmentRow {
  const row = scope.db.prepare('SELECT * FROM task_attachment WHERE id = ?').get(String(id ?? '')) as unknown as
    | AttachmentRow
    | undefined
  if (!row) {
    throw new TaskError(`No attachment "${id}" in project ${scope.projectKey}; task_attachments { key } lists a task's`)
  }
  return row
}

function taskKeyOf(scope: Scope, taskId: number): string {
  const row = scope.db.prepare('SELECT number FROM task WHERE id = ?').get(taskId) as { number: number }
  return keyOf(scope, row.number)
}

function requireDataDir(scope: Scope): string {
  if (!scope.dataDir) {
    throw new Error(`Instance ${scope.instanceId} has no data directory for attachment files`)
  }
  return scope.dataDir
}

/**
 * The refusal for a file over the limit, the same wherever the file arrives.
 * Without a size (an upload cut off as it streamed, so its full size is never
 * known) it says only that the file is over the limit.
 */
export function tooLarge(name: string, size?: number): TaskError {
  const limit = megabytes(ATTACHMENT_MAX_BYTES)
  return new TaskError(`${name} is ${size === undefined ? `over ${limit}` : megabytes(size)}; the limit per file is ${limit}`)
}

/**
 * Record a file whose bytes are already on disk at `file` (written by the
 * caller, outside `attachments/`): it moves into place as the new
 * attachment's file, and the row and the task's history follow in one
 * transaction. If recording fails, the file is removed.
 */
function recordFile(
  scope: Scope,
  task: { id: number; number: number },
  name: string,
  file: string,
  size: number,
  head: Uint8Array,
): TaskAttachment {
  let attachment: TaskAttachment | undefined
  let target: string | undefined
  try {
    transaction(scope.db, () => {
      ;({ attachment, file: target } = placeFile(scope, task.id, { name, file, size, head, uploader: scope.inv.actor, createdAt: new Date().toISOString() }))
    })
  } catch (error) {
    if (target) {
      fs.rmSync(target, { force: true })
    }
    throw error
  }
  scope.notify([keyOf(scope, task.number)], 'task')
  return attachment as TaskAttachment
}

/** A file on its way in: its bytes at `file` (outside `attachments/`), who uploaded it and when. */
export interface IncomingFile {
  name: string
  file: string
  size: number
  head: Uint8Array
  uploader: TaskAttachment['uploader']
  createdAt: string
}

/**
 * Move `incoming.file` into place as a new attachment of task `taskId`, and
 * write its row and the task's history. The caller holds the transaction;
 * if it rolls back, the caller removes the returned `file`.
 */
export function placeFile(scope: Scope, taskId: number, incoming: IncomingFile): { attachment: TaskAttachment; file: string } {
  const dataDir = requireDataDir(scope)
  const { contentType, previewable } = decideType(incoming.head, incoming.name)
  const row: AttachmentRow = {
    id: randomUUID(),
    task_id: taskId,
    name: incoming.name,
    size: incoming.size,
    content_type: contentType,
    previewable: previewable ? 1 : 0,
    uploader_kind: incoming.uploader.kind,
    uploader_name: incoming.uploader.name,
    created_at: incoming.createdAt,
  }
  scope.db
    .prepare(
      `INSERT INTO task_attachment (id, task_id, name, size, content_type, previewable, uploader_kind, uploader_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.task_id, row.name, row.size, row.content_type, row.previewable, row.uploader_kind, row.uploader_name, row.created_at)
  record(scope, taskId, 'attachment_added', null, null, incoming.name)
  touch(scope, taskId)
  const target = attachmentFile(dataDir, row.id)
  fs.mkdirSync(attachmentsDir(dataDir), { recursive: true })
  fs.renameSync(incoming.file, target)
  return { attachment: toAttachment(row), file: target }
}

/** Attach base64 bytes: how an agent attaches, through `task_attach`. */
export function attach(scope: Scope, input: TaskAttachInput): TaskAttachment {
  const task = requireRow(scope, input.key)
  const name = cleanName(input.name)
  const bytes = decodeContent(name, input.contentBase64)
  const incoming = incomingDir(requireDataDir(scope))
  fs.mkdirSync(incoming, { recursive: true })
  const file = path.join(incoming, randomUUID())
  fs.writeFileSync(file, bytes)
  try {
    return recordFile(scope, task, name, file, bytes.length, bytes.subarray(0, TYPE_HEAD_BYTES))
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** How many leading bytes `decideType` reads. */
export const TYPE_HEAD_BYTES = 16

/**
 * Attach a file already received into `incoming/` (see `incomingDir`): how a
 * person's upload arrives, streamed over the attachments route. `size` and
 * `head` are what the route counted and kept while writing it; the limit was
 * enforced there, before the file was complete.
 */
export function attachReceived(
  scope: Scope,
  input: { key: unknown; name: unknown; file: string; size: number; head: Uint8Array },
): TaskAttachment {
  const task = requireRow(scope, input.key)
  const name = cleanName(input.name)
  if (input.size > ATTACHMENT_MAX_BYTES) {
    throw tooLarge(name, input.size)
  }
  return recordFile(scope, task, name, input.file, input.size, input.head)
}

/** A task's attachments, oldest first. */
export function listAttachments(scope: Scope, key: unknown): TaskAttachment[] {
  const task = requireRow(scope, key)
  const rows = scope.db
    .prepare('SELECT * FROM task_attachment WHERE task_id = ? ORDER BY created_at, rowid')
    .all(task.id) as unknown as AttachmentRow[]
  return rows.map(toAttachment)
}

/** One attachment with its bytes in base64: how an agent reads a file, through `task_attachment_get`. */
export function readAttachment(scope: Scope, id: unknown): { attachment: TaskAttachment; contentBase64: string } {
  const { attachment, file } = attachmentWithFile(scope, id)
  return { attachment, contentBase64: fs.readFileSync(file).toString('base64') }
}

/** One attachment and the file holding its bytes, for the route to stream. */
export function attachmentWithFile(scope: Scope, id: unknown): { attachment: TaskAttachment; file: string } {
  const row = requireAttachment(scope, id)
  return { attachment: toAttachment(row), file: attachmentFile(requireDataDir(scope), row.id) }
}

export function renameAttachment(scope: Scope, input: TaskAttachmentRenameInput): TaskAttachment {
  const row = requireAttachment(scope, input.id)
  const name = cleanName(input.name)
  if (name === row.name) {
    return toAttachment(row)
  }
  transaction(scope.db, () => {
    scope.db.prepare('UPDATE task_attachment SET name = ? WHERE id = ?').run(name, row.id)
    record(scope, row.task_id, 'field', 'attachment', row.name, name)
    touch(scope, row.task_id)
  })
  scope.notify([taskKeyOf(scope, row.task_id)], 'task')
  return toAttachment({ ...row, name })
}

export function deleteAttachment(scope: Scope, id: unknown): { deleted: string } {
  const row = requireAttachment(scope, id)
  transaction(scope.db, () => {
    scope.db.prepare('DELETE FROM task_attachment WHERE id = ?').run(row.id)
    record(scope, row.task_id, 'attachment_removed', null, row.name, null)
    touch(scope, row.task_id)
  })
  removeGoneFiles(scope.db, requireDataDir(scope))
  scope.notify([taskKeyOf(scope, row.task_id)], 'task')
  return { deleted: row.id }
}
