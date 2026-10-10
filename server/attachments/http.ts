// Attachment bytes over HTTP, for people: the extension's session route (see
// ATTACHMENTS_ROUTE for its query). The host lets a request through only with
// a session and hands over who it is; this file decides what that person gets.
//
// Who may read or add a file is exactly who may call the App's actions: any
// signed-in person, on an instance of this App. The instance is looked up
// among the extension's own `tasks` instances, so an id from anywhere else is
// unknown here.
//
// A file is served with the type the server decided when it arrived, never
// one sniffed by the browser or sent by the uploader. Only the raster types
// are shown inline; everything else downloads. No response can run as a page:
// `nosniff`, and a CSP that allows nothing and sandboxes whatever opens it.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { HostUser } from '@opencroft/server/people'
import type { ExtensionRouteContext } from '@opencroft/server/routes'

import { ATTACHMENT_MAX_BYTES, type TaskAttachment } from '../../shared/attachments.ts'
import { type Scope, TaskError } from '../service.ts'
import { incomingDir } from './files.ts'
import { attachmentWithFile, attachReceived, cleanName, TYPE_HEAD_BYTES, tooLarge } from './store.ts'

/**
 * The scope a request acts in: the `tasks` instance with id `appId`, as
 * `person`, the way an App action runs when that person calls it from the UI;
 * null when the extension has no such instance. Supplied by the server entry.
 */
export type RouteScope = (appId: string | null, person: HostUser) => Promise<Scope | null>

const json = (status: number, body: unknown, headers?: HeadersInit) => Response.json(body, { status, headers })

/** `attachment; filename=…` with an ASCII fallback and the exact name in RFC 5987 form. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** The one range asked for, as inclusive offsets; null for the whole file; 'unsatisfiable' for a range outside it. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  // Only a single range is served; several (rare, and only ever an
  // optimisation) get the whole file, which RFC 9110 allows.
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (match[1] === '' && match[2] === '')) {
    return null
  }
  const [, first, last] = match
  if (first === '') {
    // A suffix: the last N bytes.
    const length = Number(last)
    if (length === 0 || size === 0) {
      return 'unsatisfiable'
    }
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || end < start) {
    return 'unsatisfiable'
  }
  return { start, end }
}

async function serve(request: Request, scope: Scope, url: URL): Promise<Response> {
  let found: { attachment: TaskAttachment; file: string }
  try {
    found = attachmentWithFile(scope, url.searchParams.get('id'))
  } catch (error) {
    if (error instanceof TaskError) {
      return json(404, { error: error.message })
    }
    throw error
  }
  const { attachment, file } = found
  const size = (await fs.stat(file)).size
  const inline = attachment.previewable && url.searchParams.get('download') !== '1'
  // The name is in the tag: a rename changes the Content-Disposition, and a
  // cached copy must not keep answering with the old one. The bytes never change.
  const etag = `"${attachment.id}-${createHash('sha256').update(attachment.name).digest('base64url').slice(0, 16)}"`
  const headers = new Headers({
    'Content-Type': attachment.contentType,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', attachment.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Private: it is behind a session. Revalidated each time, so a deleted
    // attachment stops being served from the browser's cache too.
    'Cache-Control': 'private, no-cache',
    ETag: etag,
    'Accept-Ranges': 'bytes',
  })
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers })
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  const status = range ? 206 : 200
  if (request.method === 'HEAD' || size === 0) {
    return new Response(null, { status, headers })
  }
  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

class TooLarge extends Error {}

async function receive(request: Request, scope: Scope, url: URL): Promise<Response> {
  const name = cleanName(url.searchParams.get('name'))
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
    return json(413, { error: tooLarge(name, declared).message })
  }
  if (!scope.dataDir) {
    throw new Error(`Instance ${scope.instanceId} has no data directory`)
  }
  const incoming = incomingDir(scope.dataDir)
  await fs.mkdir(incoming, { recursive: true })
  const file = path.join(incoming, randomUUID())
  let size = 0
  const head: Buffer[] = []
  let headLength = 0
  // Counted as it arrives, so a body without a length (or with a false one)
  // is cut off at the limit rather than written out in full first.
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > ATTACHMENT_MAX_BYTES) {
        done(new TooLarge())
        return
      }
      if (headLength < TYPE_HEAD_BYTES) {
        head.push(chunk.subarray(0, TYPE_HEAD_BYTES - headLength))
        headLength += Math.min(chunk.length, TYPE_HEAD_BYTES - headLength)
      }
      done(null, chunk)
    },
  })
  try {
    const source = request.body
      ? Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream)
      : Readable.from([])
    await pipeline(source, counter, createWriteStream(file))
    return json(
      201,
      attachReceived(scope, { key: url.searchParams.get('key'), name, file, size, head: Buffer.concat(head) }),
    )
  } catch (error) {
    if (error instanceof TooLarge) {
      return json(413, { error: tooLarge(name).message })
    }
    throw error
  } finally {
    // Moved into place on success; anything left here is a failed upload.
    await fs.rm(file, { force: true })
  }
}

/** The session route's handler: GET or HEAD reads a file, POST adds one. */
export const attachmentsRoute =
  (scopeOf: RouteScope) =>
  async (request: Request, { person }: ExtensionRouteContext): Promise<Response> => {
    const url = new URL(request.url)
    try {
      const scope = await scopeOf(url.searchParams.get('app'), person)
      if (!scope) {
        return json(404, { error: 'No tasks App with that id; pass the App instance as "app"' })
      }
      switch (request.method) {
        case 'GET':
        case 'HEAD':
          return await serve(request, scope, url)
        case 'POST':
          return await receive(request, scope, url)
        default:
          return json(405, { error: 'Use GET to read an attachment and POST to add one' }, { Allow: 'GET, HEAD, POST' })
      }
    } catch (error) {
      if (error instanceof TaskError) {
        return json(400, { error: error.message })
      }
      throw error
    }
  }
