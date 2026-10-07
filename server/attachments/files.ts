// Where attachment bytes live: one file per attachment, named by its id, in
// `attachments/` of the instance's data directory, beside the database and
// backed up with it. The database holds only the metadata.
//
// A row can go without its file being touched: deleting a task deletes its
// attachments by cascade, inside SQL. So every deleted attachment's id is
// queued by a trigger (`task_attachment_gone`, see migrations.ts), and
// `removeGoneFiles` deletes the files of queued ids once the deletion has
// committed. A file whose removal did not happen (a crash in between) stays
// queued and goes on the instance's next load.

import fs from 'node:fs'
import path from 'node:path'

import type { Db } from '../db.ts'

// Ids are the server's own UUIDs; anything else never becomes a path.
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** How long an unfinished upload's file may sit in `incoming/` before a load removes it. */
const INCOMING_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function attachmentsDir(dataDir: string): string {
  return path.join(dataDir, 'attachments')
}

/** Uploads in progress, written here and moved into place once complete. */
export function incomingDir(dataDir: string): string {
  return path.join(attachmentsDir(dataDir), 'incoming')
}

/** The file holding one attachment's bytes. */
export function attachmentFile(dataDir: string, id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Not an attachment id: ${JSON.stringify(id)}`)
  }
  return path.join(attachmentsDir(dataDir), id)
}

/** Delete the files of attachments whose rows are gone, and empty the queue of them. */
export function removeGoneFiles(db: Db, dataDir: string): void {
  const gone = db.prepare('SELECT id FROM task_attachment_gone').all() as Array<{ id: string }>
  const removed = db.prepare('DELETE FROM task_attachment_gone WHERE id = ?')
  for (const { id } of gone) {
    if (ID_PATTERN.test(id)) {
      fs.rmSync(attachmentFile(dataDir, id), { force: true })
    }
    removed.run(id)
  }
}

/** On load: finish any removal a crash interrupted, and drop uploads that never completed. */
export function sweepAttachmentFiles(db: Db, dataDir: string, now = Date.now()): void {
  removeGoneFiles(db, dataDir)
  let names: string[]
  try {
    names = fs.readdirSync(incomingDir(dataDir))
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(incomingDir(dataDir), name)
    if (now - fs.statSync(file).mtimeMs > INCOMING_MAX_AGE_MS) {
      fs.rmSync(file, { force: true })
    }
  }
}
