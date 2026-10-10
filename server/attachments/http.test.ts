// The attachments route as the host calls it: after the session check, with
// the person, for one of the extension's instances (here the test scope's).
// What the host does before this (401 without a session, 403 for a
// cross-origin write) is core's, tested there.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { ATTACHMENT_MAX_BYTES } from '../../shared/attachments.ts'
import { createTask, getTask } from '../service.ts'
import { incomingDir } from './files.ts'
import { attachmentsRoute, contentDisposition, parseRange } from './http.ts'
import { attach, listAttachments } from './store.ts'
import { makeScope, PNG, storedFiles } from './testing.ts'

const person = { id: 'u1', name: 'Alice', avatarUrl: null }

async function setup() {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  const { key } = (await createTask(scope, { summary: 'Screens' })).result
  const route = attachmentsRoute(async (appId) => (appId === 'inst-1' ? scope : null))
  const call = (query: Record<string, string>, init: RequestInit = {}) =>
    route(
      new Request(
        `http://localhost/api/ext/opencroft.task-manager/http/attachments?${new URLSearchParams(query)}`,
        init,
      ),
      {
        person,
      },
    )
  return { scope, key, call }
}

test('a previewable image is served inline with its decided type, nosniff and a sandboxing CSP', async () => {
  const { scope, key, call } = await setup()
  const shot = attach(scope, { key, name: 'Écran 1.png', contentBase64: PNG.toString('base64') })
  const response = await call({ app: 'inst-1', id: shot.id })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
  const h = Object.fromEntries(response.headers)
  assert.equal(h['content-type'], 'image/png')
  assert.equal(h['content-disposition'], `inline; filename="_cran 1.png"; filename*=UTF-8''%C3%89cran%201.png`)
  assert.equal(h['x-content-type-options'], 'nosniff')
  assert.equal(h['content-security-policy'], "default-src 'none'; sandbox")
  assert.equal(h['accept-ranges'], 'bytes')
  assert.equal(h['content-length'], String(PNG.length))
  assert.equal(h['cache-control'], 'private, no-cache')

  const saved = await call({ app: 'inst-1', id: shot.id, download: '1' })
  assert.match(saved.headers.get('content-disposition') ?? '', /^attachment; /, 'download=1 saves even an image')
})

test('anything that is not a raster image is always a download', async () => {
  const { scope, key, call } = await setup()
  const page = attach(scope, {
    key,
    name: 'page.html',
    contentBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
  })
  const response = await call({ app: 'inst-1', id: page.id })
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="page.html"/)
})

test('a range is served as 206 from the file; one outside it is 416; an unchanged copy is 304', async () => {
  const { scope, key, call } = await setup()
  const bytes = Buffer.from('0123456789')
  const doc = attach(scope, { key, name: 'digits.txt', contentBase64: bytes.toString('base64') })
  const part = await call({ app: 'inst-1', id: doc.id }, { headers: { range: 'bytes=2-5' } })
  assert.equal(part.status, 206)
  assert.equal(await part.text(), '2345')
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(part.headers.get('content-length'), '4')
  const tail = await call({ app: 'inst-1', id: doc.id }, { headers: { range: 'bytes=-3' } })
  assert.equal(await tail.text(), '789')
  const outside = await call({ app: 'inst-1', id: doc.id }, { headers: { range: 'bytes=10-' } })
  assert.equal(outside.status, 416)
  assert.equal(outside.headers.get('content-range'), 'bytes */10')

  const etag = part.headers.get('etag') ?? ''
  const cached = await call({ app: 'inst-1', id: doc.id }, { headers: { 'if-none-match': etag } })
  assert.equal(cached.status, 304)
  const head = await call({ app: 'inst-1', id: doc.id }, { method: 'HEAD' })
  assert.deepEqual([head.status, head.headers.get('content-length'), await head.text()], [200, '10', ''])
})

test('parseRange reads one range and leaves the rest to a full answer', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 })
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 })
  assert.deepEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 })
  assert.deepEqual(parseRange('bytes=-100', 10), { start: 0, end: 9 })
  assert.equal(parseRange('bytes=0-1,4-5', 10), null)
  assert.equal(parseRange('items=0-1', 10), null)
  assert.equal(parseRange(null, 10), null)
  assert.equal(parseRange('bytes=6-2', 10), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable')
  assert.equal(
    contentDisposition('attachment', 'a"b\\c.txt'),
    `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`,
  )
})

test('an upload streams to a file, is attributed to the person, and reads back byte for byte', async () => {
  const { scope, key, call } = await setup()
  const response = await call({ app: 'inst-1', key, name: 'shot.png' }, { method: 'POST', body: PNG })
  assert.equal(response.status, 201)
  const stored = (await response.json()) as {
    id: string
    contentType: string
    uploader: { kind: string; name: string }
  }
  assert.deepEqual([stored.contentType, stored.uploader], ['image/png', { kind: 'person', name: 'Alice' }])
  assert.deepEqual(Buffer.from(await (await call({ app: 'inst-1', id: stored.id })).arrayBuffer()), PNG)
  assert.deepEqual(
    getTask(scope, key)
      .activity.filter((a) => a.kind === 'attachment_added')
      .map((a) => [a.actor.name, a.to]),
    [['Alice', 'shot.png']],
  )
  assert.deepEqual(fs.readdirSync(incomingDir(scope.dataDir)), [])
})

test('an upload over the limit is cut off while it streams, with no length declared, and leaves nothing behind', async () => {
  const { scope, key, call } = await setup()
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Far past the limit if nothing stopped it.
      if (sent++ > 40) {
        controller.close()
      } else {
        controller.enqueue(chunk)
      }
    },
  })
  const response = await call({ app: 'inst-1', key, name: 'video.mov' }, {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit)
  assert.equal(response.status, 413)
  // Cut off part way, its full size is unknown: the refusal says only that it is over.
  assert.deepEqual(await response.json(), { error: 'video.mov is over 25 MB; the limit per file is 25 MB' })
  assert.ok(sent < 40, `stopped reading at ${sent} MiB`)
  assert.deepEqual(
    [listAttachments(scope, key), storedFiles(scope.dataDir), fs.readdirSync(incomingDir(scope.dataDir))],
    [[], [], []],
  )

  const declared = await call(
    { app: 'inst-1', key, name: 'big.iso' },
    { method: 'POST', body: new Uint8Array(1), headers: { 'content-length': String(ATTACHMENT_MAX_BYTES + 1) } },
  )
  assert.equal(declared.status, 413, 'a declared length over the limit is refused before reading')
})

test('refusals: unknown instance or attachment is 404, a bad key or name is 400, other methods 405', async () => {
  const { key, call } = await setup()
  const statusOf = async (query: Record<string, string>, init?: RequestInit) => {
    const response = await call(query, init)
    return [response.status, ((await response.json()) as { error: string }).error]
  }
  assert.deepEqual(await statusOf({ app: 'other', id: 'x' }), [
    404,
    'No tasks App with that id; pass the App instance as "app"',
  ])
  assert.deepEqual((await statusOf({ app: 'inst-1', id: 'nope' }))[0], 404)
  assert.deepEqual(
    (await statusOf({ app: 'inst-1', key: 'TASK-99', name: 'a.txt' }, { method: 'POST', body: 'a' }))[0],
    400,
  )
  assert.deepEqual(await statusOf({ app: 'inst-1', key, name: ' / ' }, { method: 'POST', body: 'a' }), [
    400,
    '"name" must be a file name, e.g. "screenshot.png"',
  ])
  assert.deepEqual((await statusOf({ app: 'inst-1', id: 'x' }, { method: 'PUT', body: 'a' }))[0], 405)
})
