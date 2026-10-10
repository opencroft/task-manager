// Reading one project out of OpenProject's API v3: the project, its work
// packages (open and closed), the statuses and types they use, and each work
// package's comments. Read-only. The token only ever goes into the
// Authorization header: no message, error or result here carries it.

import { TaskError } from '../service.ts'

/** A work package as the import uses it, flattened out of the HAL shape. */
export interface SourceWorkPackage {
  id: number
  /** `PROJ-12` on an instance with project-based ids; null where only the numeric id exists. */
  displayId: string | null
  subject: string
  /** Markdown. */
  description: string
  typeId: string
  typeName: string
  statusId: string
  statusName: string
  priorityName: string | null
  assigneeId: string | null
  assigneeName: string | null
  authorId: string | null
  authorName: string | null
  parentId: number | null
  startDate: string | null
  dueDate: string | null
  /** A milestone's single date. */
  date: string | null
  createdAt: string
  updatedAt: string
}

export interface SourceStatus {
  id: string
  name: string
  isClosed: boolean
  color: string | null
  position: number
}

export interface SourceType {
  id: string
  name: string
}

export interface SourceComment {
  id: number
  userId: string | null
  /** Markdown. */
  body: string
  internal: boolean
  createdAt: string
  updatedAt: string
}

/** "from <type> to", as OpenProject names it: relates, blocks, follows, duplicates, or one of their reverses. */
export interface SourceRelation {
  id: number
  type: string
  fromId: number
  toId: number
}

/** A file attached to a work package. */
export interface SourceAttachment {
  id: number
  workPackageId: number
  fileName: string
  /** Bytes, as OpenProject reports them. */
  fileSize: number
  createdAt: string
  authorId: string | null
  authorName: string | null
  /** The MD5 of the bytes in hex, where OpenProject gives one. */
  md5: string | null
}

export interface SourceProject {
  id: number
  identifier: string
  name: string
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export interface OpenProjectClient {
  /** The address requests go to, normalised: no trailing slash, no `/api/v3`. */
  base: string
  project(ref: string): Promise<SourceProject>
  workPackages(projectId: number): Promise<SourceWorkPackage[]>
  statuses(): Promise<SourceStatus[]>
  types(projectId: number): Promise<SourceType[]>
  comments(workPackageId: number): Promise<SourceComment[]>
  relations(): Promise<SourceRelation[]>
  attachments(workPackageId: number): Promise<SourceAttachment[]>
  /** An attachment's bytes, as they stream in. */
  attachmentContent(attachmentId: number): Promise<ReadableStream<Uint8Array>>
  /** A user's name, or null when OpenProject will not say (deleted, or not visible to the token's user). */
  userName(id: string): Promise<string | null>
}

/**
 * The OpenProject address as requests use it. Only https, so the token never
 * travels in the clear; plain http only for a server on this machine.
 */
export function normalizeBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TaskError(`"${raw}" is not an address: give the OpenProject URL, e.g. https://openproject.example.com`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new TaskError('The OpenProject address must start with https://, so the token is never sent unencrypted')
  }
  if (url.username || url.password) {
    throw new TaskError(
      'Give the OpenProject address without a user name or password in it; the token comes from the Secrets Store',
    )
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v3$/, '')
  return `${url.origin}${path}`
}

/** The last path segment of a HAL link, e.g. `10` from `/api/v3/users/10`; null for an empty link. */
export function idFromHref(link: unknown): string | null {
  const href = (link as { href?: unknown } | null | undefined)?.href
  if (typeof href !== 'string' || !href) {
    return null
  }
  return href.replace(/\/+$/, '').split('/').pop() || null
}

type Json = Record<string, unknown>

const linkOf = (item: Json, name: string) => ((item._links as Json | undefined)?.[name] ?? null) as Json | null
const text = (value: unknown) => (typeof value === 'string' ? value : null)
const raw = (value: unknown) => text((value as Json | null | undefined)?.raw) ?? ''

export function toWorkPackage(item: Json): SourceWorkPackage {
  const type = linkOf(item, 'type')
  const status = linkOf(item, 'status')
  const assignee = linkOf(item, 'assignee')
  const author = linkOf(item, 'author')
  const parent = idFromHref(linkOf(item, 'parent'))
  return {
    id: Number(item.id),
    displayId: text(item.displayId),
    subject: text(item.subject) ?? '',
    description: raw(item.description),
    typeId: idFromHref(type) ?? '',
    typeName: text(type?.title) ?? '',
    statusId: idFromHref(status) ?? '',
    statusName: text(status?.title) ?? '',
    priorityName: text(linkOf(item, 'priority')?.title),
    assigneeId: idFromHref(assignee),
    assigneeName: text(assignee?.title),
    authorId: idFromHref(author),
    authorName: text(author?.title),
    parentId: parent === null ? null : Number(parent),
    startDate: text(item.startDate),
    dueDate: text(item.dueDate),
    date: text(item.date),
    createdAt: text(item.createdAt) ?? '',
    updatedAt: text(item.updatedAt) ?? '',
  }
}

/** What a failed response means for the person importing, never with the token in it. */
function failure(status: number, what: string, secretKey: string): TaskError {
  if (status === 401) {
    return new TaskError(
      `OpenProject refused the token stored under "${secretKey}" (401): check it is a current API token`,
    )
  }
  if (status === 403) {
    return new TaskError(`The token stored under "${secretKey}" may not read ${what} (403)`)
  }
  if (status === 404) {
    return new TaskError(`OpenProject has no ${what}, or the token's user cannot see it (404)`)
  }
  return new TaskError(`OpenProject answered ${status} for ${what}`)
}

const PAGE_SIZE = 200

export function openProjectClient(options: {
  url: string
  token: string
  secretKey: string
  fetch?: Fetch
  signal?: AbortSignal
}): OpenProjectClient {
  const base = normalizeBaseUrl(options.url)
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init))
  const authorization = `Basic ${Buffer.from(`apikey:${options.token}`).toString('base64')}`

  async function request(path: string, what: string, accept: string): Promise<Response> {
    options.signal?.throwIfAborted()
    let response: Response
    try {
      response = await doFetch(`${base}/api/v3${path}`, {
        headers: { authorization, accept },
        // A redirect could carry the header to another host: refuse it instead.
        redirect: 'error',
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new TaskError(
        `Could not reach OpenProject at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      throw failure(response.status, what, options.secretKey)
    }
    return response
  }

  async function get(path: string, what: string): Promise<Json> {
    const response = await request(path, what, 'application/hal+json')
    try {
      return (await response.json()) as Json
    } catch {
      throw new TaskError(`OpenProject at ${base} did not answer with JSON for ${what}: is this the right address?`)
    }
  }

  const elements = (body: Json) => ((body._embedded as Json | undefined)?.elements ?? []) as Json[]

  return {
    base,
    async project(ref) {
      const wanted = String(ref ?? '').trim()
      if (!wanted) {
        throw new TaskError('Name the OpenProject project: its identifier, as in its address, or its id')
      }
      // Identifiers are matched as written; an instance may keep them in either case.
      const tries = [...new Set([wanted, wanted.toLowerCase(), wanted.toUpperCase()])]
      for (const [index, candidate] of tries.entries()) {
        try {
          const body = await get(`/projects/${encodeURIComponent(candidate)}`, `project "${wanted}"`)
          return {
            id: Number(body.id),
            identifier: text(body.identifier) ?? candidate,
            name: text(body.name) ?? candidate,
          }
        } catch (error) {
          if (index === tries.length - 1 || !(error instanceof TaskError) || !error.message.includes('(404)')) {
            throw error
          }
        }
      }
      throw new TaskError(`OpenProject has no project "${wanted}"`)
    },
    async workPackages(projectId) {
      // An explicit filter replaces OpenProject's default one, which hides
      // closed work packages; this one keeps them, and leaves subprojects out.
      const filters = encodeURIComponent(JSON.stringify([{ project: { operator: '=', values: [String(projectId)] } }]))
      const sortBy = encodeURIComponent(JSON.stringify([['id', 'asc']]))
      const all: SourceWorkPackage[] = []
      for (let page = 1; ; page++) {
        const body = await get(
          `/projects/${projectId}/work_packages?filters=${filters}&sortBy=${sortBy}&pageSize=${PAGE_SIZE}&offset=${page}`,
          "the project's work packages",
        )
        const items = elements(body)
        all.push(...items.map(toWorkPackage))
        const total = Number(body.total ?? 0)
        if (items.length === 0 || all.length >= total) {
          return all
        }
      }
    },
    async statuses() {
      return elements(await get('/statuses', 'the statuses')).map((item) => ({
        id: String(item.id),
        name: text(item.name) ?? '',
        isClosed: item.isClosed === true,
        color: text(item.color),
        position: Number(item.position ?? 0),
      }))
    },
    async types(projectId) {
      return elements(await get(`/projects/${projectId}/types`, "the project's types")).map((item) => ({
        id: String(item.id),
        name: text(item.name) ?? '',
      }))
    },
    async comments(workPackageId) {
      const body = await get(
        `/work_packages/${workPackageId}/activities`,
        `the activity of work package ${workPackageId}`,
      )
      return elements(body)
        .filter((item) => raw(item.comment).trim() !== '')
        .map((item) => ({
          id: Number(item.id),
          userId: idFromHref(linkOf(item, 'user')),
          body: raw(item.comment),
          internal: item.internal === true,
          createdAt: text(item.createdAt) ?? '',
          updatedAt: text(item.updatedAt) ?? text(item.createdAt) ?? '',
        }))
    },
    async relations() {
      // Every relation the token may read; the caller keeps those between its work packages.
      const filters = encodeURIComponent('[]')
      const sortBy = encodeURIComponent(JSON.stringify([['id', 'asc']]))
      const all: SourceRelation[] = []
      // Counted as read, not as kept: a server may answer fewer a page than asked.
      let read = 0
      for (let page = 1; ; page++) {
        const body = await get(
          `/relations?filters=${filters}&sortBy=${sortBy}&pageSize=${PAGE_SIZE}&offset=${page}`,
          'the relations',
        )
        const items = elements(body)
        read += items.length
        for (const item of items) {
          const from = idFromHref(linkOf(item, 'from'))
          const to = idFromHref(linkOf(item, 'to'))
          if (from !== null && to !== null) {
            all.push({ id: Number(item.id), type: text(item.type) ?? '', fromId: Number(from), toId: Number(to) })
          }
        }
        if (items.length === 0 || read >= Number(body.total ?? 0)) {
          return all
        }
      }
    },
    async attachments(workPackageId) {
      const body = await get(
        `/work_packages/${workPackageId}/attachments`,
        `the attachments of work package ${workPackageId}`,
      )
      return elements(body).map((item) => {
        const author = linkOf(item, 'author')
        const digest = item.digest as Json | undefined
        return {
          id: Number(item.id),
          workPackageId,
          fileName: text(item.fileName) ?? `attachment-${item.id}`,
          fileSize: Number(item.fileSize ?? 0),
          createdAt: text(item.createdAt) ?? '',
          authorId: idFromHref(author),
          authorName: text(author?.title),
          md5: digest?.algorithm === 'md5' ? text(digest.hash) : null,
        }
      })
    },
    async attachmentContent(attachmentId) {
      const response = await request(`/attachments/${attachmentId}/content`, `attachment ${attachmentId}`, '*/*')
      if (!response.body) {
        throw new TaskError(`OpenProject sent no content for attachment ${attachmentId}`)
      }
      return response.body
    },
    async userName(id) {
      try {
        const body = await get(`/users/${encodeURIComponent(id)}`, `user ${id}`)
        return text(body.name)
      } catch (error) {
        if (error instanceof TaskError && /\((403|404)\)/.test(error.message)) {
          return null
        }
        throw error
      }
    },
  }
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
