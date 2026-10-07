import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { allMigrations, migrate } from '../db.ts'
import { createTask, deleteTask, getTask } from '../service.ts'
import { decideType } from './content-type.ts'
import { attachmentFile, incomingDir, sweepAttachmentFiles } from './files.ts'
import {
  attach,
  attachReceived,
  cleanName,
  deleteAttachment,
  listAttachments,
  readAttachment,
  renameAttachment,
} from './store.ts'
import { PNG, makeScope, storedFiles, tempDataDir } from './testing.ts'

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64')

test('an attachment keeps its bytes, is attributed to the caller, and is recorded on the task', async () => {
  const scope = makeScope()
  const { key } = (await createTask(scope, { summary: 'Login fails' })).result
  const shot = attach(scope, { key, name: 'login-error.png', contentBase64: `data:image/png;base64,${b64(PNG)}` })
  assert.deepEqual(
    { ...shot, id: typeof shot.id, createdAt: typeof shot.createdAt },
    {
      id: 'string',
      name: 'login-error.png',
      size: PNG.length,
      contentType: 'image/png',
      previewable: true,
      createdAt: 'string',
      uploader: { kind: 'agent', name: 'Ace (QA)' },
    },
  )
  assert.deepEqual(readAttachment(scope, shot.id), { attachment: shot, contentBase64: b64(PNG) })
  assert.deepEqual(fs.readFileSync(attachmentFile(scope.dataDir, shot.id)), PNG, 'the bytes are a file named by the id')
  assert.deepEqual(fs.readdirSync(incomingDir(scope.dataDir)), [], 'nothing is left in incoming/')
  assert.deepEqual(listAttachments(scope, key), [shot])
  assert.deepEqual(
    getTask(scope, key).activity.filter((a) => a.kind === 'attachment_added').map((a) => [a.actor.name, a.to]),
    [['Ace (QA)', 'login-error.png']],
  )
  assert.deepEqual(scope.events.at(-1), { keys: [key], kind: 'task' })
})

test('the type comes from the bytes: only real raster images are previewable, and nothing renders as a page', () => {
  const gif = Buffer.from('GIF89a......')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
  const cases: Array<[Uint8Array, string, string, boolean]> = [
    [PNG, 'a.png', 'image/png', true],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'photo.JPG', 'image/jpeg', true],
    [gif, 'anim.gif', 'image/gif', true],
    [webp, 'x.webp', 'image/webp', true],
    // A name says nothing about the bytes: an HTML file called .png is not an image.
    [Buffer.from('<html><script>alert(1)</script>'), 'evil.png', 'application/octet-stream', false],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'application/octet-stream', false],
    [Buffer.from('<p>hi</p>'), 'page.html', 'application/octet-stream', false],
    [Buffer.from('%PDF-1.7'), 'spec.pdf', 'application/pdf', false],
    [Buffer.from('a,b'), 'data.CSV', 'text/csv', false],
    [Buffer.from('no extension'), 'README', 'application/octet-stream', false],
  ]
  for (const [bytes, name, contentType, previewable] of cases) {
    assert.deepEqual(decideType(bytes, name), { contentType, previewable }, name)
  }
})

test('refusals name the problem: the size limit, bad base64, an empty name, an unknown id', async () => {
  const scope = makeScope()
  const { key } = (await createTask(scope, { summary: 'Spec' })).result
  // Two bytes over the limit (25 MiB + 2 is a multiple of 3, so no padding), refused before decoding.
  const justOver = 'A'.repeat(((25 * 1024 * 1024 + 2) / 3) * 4)
  assert.throws(() => attach(scope, { key, name: 'video.mov', contentBase64: justOver }), {
    message: 'video.mov is 25.1 MB; the limit per file is 25 MB',
  })
  // 25 MiB is 3k + 1 bytes: 4k characters, then one byte as "AA==".
  const atLimit = 'A'.repeat(((25 * 1024 * 1024 - 1) / 3) * 4) + 'AA=='
  assert.equal(attach(scope, { key, name: 'max.bin', contentBase64: atLimit }).size, 25 * 1024 * 1024, 'exactly the limit is accepted')
  assert.throws(() => attach(scope, { key, name: 'x.txt', contentBase64: 'not base64!' }), { message: /must be the file's bytes in base64/ })
  assert.throws(() => attach(scope, { key, name: ' / ', contentBase64: b64('x') }), { message: /"name" must be a file name/ })
  assert.throws(() => readAttachment(scope, 'nope'), { message: 'No attachment "nope" in project TASK; task_attachments { key } lists a task\'s' })
  assert.deepEqual(
    listAttachments(scope, key).map((a) => a.name),
    ['max.bin'],
    'nothing was stored by a refused upload',
  )
})

test('names keep only the last path segment, lose control characters, and keep their extension when cut', () => {
  assert.equal(cleanName('C:\\Users\\me\\Desktop\\shot 1.png'), 'shot 1.png')
  assert.equal(cleanName('../../etc/passwd'), 'passwd')
  assert.equal(cleanName('a\u0000b\nc.txt'), 'ab c.txt')
  const long = cleanName(`${'x'.repeat(300)}.png`)
  assert.equal(long.length, 200)
  assert.ok(long.endsWith('.png'))
})

test('rename and delete are recorded; deleting a task removes its attachments and their bytes', async () => {
  const scope = makeScope()
  const { key } = (await createTask(scope, { summary: 'Spec' })).result
  const doc = attach(scope, { key, name: 'draft.md', contentBase64: b64('# Draft') })
  assert.equal(renameAttachment(scope, { id: doc.id, name: 'spec.md' }).name, 'spec.md')
  assert.equal(listAttachments(scope, key)[0]?.contentType, 'text/markdown', 'the type decided on upload stays')
  deleteAttachment(scope, doc.id)
  assert.deepEqual(
    getTask(scope, key)
      .activity.filter((a) => a.kind !== 'created')
      .map((a) => [a.kind, a.field, a.from, a.to]),
    [
      ['attachment_added', null, null, 'draft.md'],
      ['field', 'attachment', 'draft.md', 'spec.md'],
      ['attachment_removed', null, 'spec.md', null],
    ],
  )

  assert.deepEqual(storedFiles(scope.dataDir), [], 'a deleted attachment takes its file')

  const kept = attach(scope, { key, name: 'kept.txt', contentBase64: b64('bytes') })
  const { key: child } = (await createTask(scope, { summary: 'Screens', parent: key })).result
  attach(scope, { key: child, name: 'child.png', contentBase64: b64(PNG) })
  assert.equal(storedFiles(scope.dataDir).length, 2)
  deleteTask(scope, { key, withSubtasks: true })
  const count = (table: string) => (scope.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  assert.deepEqual(
    [count('task_attachment'), count('task_attachment_gone'), storedFiles(scope.dataDir)],
    [0, 0, []],
    `${kept.name} and the subtask's file went with their tasks`,
  )
})

test('a received upload moves into place with its type from its first bytes; one over the limit is refused', async () => {
  const scope = makeScope()
  const { key } = (await createTask(scope, { summary: 'Upload' })).result
  const receive = (name: string, bytes: Buffer) => {
    fs.mkdirSync(incomingDir(scope.dataDir), { recursive: true })
    const file = path.join(incomingDir(scope.dataDir), `upload-${name}`)
    fs.writeFileSync(file, bytes)
    return { file, result: () => attachReceived(scope, { key, name, file, size: bytes.length, head: bytes.subarray(0, 16) }) }
  }
  const shot = receive('shot.png', PNG)
  const stored = shot.result()
  assert.deepEqual([stored.contentType, stored.previewable, stored.size, stored.uploader.name], ['image/png', true, PNG.length, 'Ace (QA)'])
  assert.equal(fs.existsSync(shot.file), false, 'moved, not copied')
  assert.deepEqual(fs.readFileSync(attachmentFile(scope.dataDir, stored.id)), PNG)

  const big = receive('big.bin', Buffer.alloc(1))
  assert.throws(() => attachReceived(scope, { key, name: 'big.bin', file: big.file, size: 25 * 1024 * 1024 + 1, head: Buffer.alloc(1) }), {
    message: 'big.bin is 25.1 MB; the limit per file is 25 MB',
  })
  assert.deepEqual(listAttachments(scope, key).map((a) => a.name), ['shot.png'])
})

test('a load finishes an interrupted removal and drops uploads that never completed', async () => {
  const scope = makeScope()
  const { key } = (await createTask(scope, { summary: 'Crash' })).result
  const doc = attach(scope, { key, name: 'a.txt', contentBase64: b64('a') })
  // A deletion whose file removal never ran: the row is gone, the file and the queue entry are not.
  scope.db.prepare('DELETE FROM task_attachment WHERE id = ?').run(doc.id)
  const stale = path.join(incomingDir(scope.dataDir), 'stale')
  const fresh = path.join(incomingDir(scope.dataDir), 'fresh')
  fs.writeFileSync(stale, 'x')
  fs.writeFileSync(fresh, 'y')
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000
  fs.utimesSync(stale, dayAgo, dayAgo)
  sweepAttachmentFiles(scope.db, scope.dataDir)
  assert.deepEqual(storedFiles(scope.dataDir), [])
  assert.deepEqual(fs.readdirSync(incomingDir(scope.dataDir)), ['fresh'], 'an upload in progress is left alone')
})

test('attachments-0002 moves the bytes stored by 0001 into files, and refuses to drop them without a data directory', () => {
  const upTo0001 = allMigrations().filter((m) => m.id !== 'attachments-0002-files')
  const seed = (db: DatabaseSync) => {
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, upTo0001)
    db.prepare(
      `INSERT INTO task (id, number, summary, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
       VALUES (1, 1, 'Old', 1, 'agent', 'a', 'm', 'now', 'now')`,
    ).run()
    const id = '00000000-0000-4000-8000-000000000001'
    db.prepare(
      `INSERT INTO task_attachment (id, task_id, name, size, content_type, previewable, uploader_kind, uploader_name, created_at)
       VALUES (?, 1, 'old.png', ?, 'image/png', 1, 'agent', 'a', 'now')`,
    ).run(id, PNG.length)
    db.prepare('INSERT INTO task_attachment_content (attachment_id, bytes) VALUES (?, ?)').run(id, PNG)
    return id
  }

  const orphaned = new DatabaseSync(':memory:')
  seed(orphaned)
  assert.throws(() => migrate(orphaned), { message: /moves stored files into the data directory/ })
  assert.equal(
    (orphaned.prepare('SELECT count(*) AS n FROM task_attachment_content').get() as { n: number }).n,
    1,
    'the refused migration rolled back and kept the bytes',
  )

  const db = new DatabaseSync(':memory:')
  const id = seed(db)
  const dataDir = tempDataDir()
  assert.deepEqual(migrate(db, allMigrations(), { dataDir }), ['attachments-0002-files'])
  assert.deepEqual(fs.readFileSync(attachmentFile(dataDir, id)), PNG)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'task_attachment_content'").get(), undefined)
})
