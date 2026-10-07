// Reading pull requests from a Forgejo (Gitea API v1) server. Read-only. The
// token only ever goes into the Authorization header: no message, error or
// result here carries it.

import { TaskError } from '../service.ts'

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** A pull request as the forge's list answers it, trimmed to what is read. */
export interface ForgePull {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  author: string
  url: string
  /** The head branch; `refs/pull/<n>/head` once the branch is gone. */
  headRef: string
  updatedAt: string
}

export interface ForgeClient {
  base: string
  /** The repositories of `owner` with a pull request updated since `since` (all, when null). */
  changedRepos(owner: string, since: string | null): Promise<string[]>
  /** One repository's pull requests updated since `since`, newest update first. */
  pulls(repo: string, since: string | null): Promise<ForgePull[]>
}

/** The forge address as requests use it: https only, plain http only for a server on this machine. */
export function normalizeForgeUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TaskError(`"${raw}" is not an address: give the forge's URL, e.g. https://git.example.com`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new TaskError('The forge address must start with https://, so the token is never sent unencrypted')
  }
  if (url.username || url.password) {
    throw new TaskError('Give the forge address without a user name or password in it; the token comes from the Secrets Store')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}`
}

// The forge's largest page.
const PAGE = 50
// Never more pages than this in one read: a runaway paging loop stops here.
const MAX_PAGES = 200

type Json = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export function toPull(item: Json): ForgePull {
  const head = (item.head ?? {}) as Json
  const user = (item.user ?? {}) as Json
  return {
    number: Number(item.number),
    title: text(item.title),
    body: text(item.body),
    state: item.state === 'open' ? 'open' : 'closed',
    merged: item.merged === true,
    author: text(user.login) || text(user.username),
    url: text(item.html_url),
    headRef: text(head.ref),
    updatedAt: text(item.updated_at),
  }
}

export function forgeClient(options: { url: string; token: string; secretKey: string; fetch?: Fetch; signal?: AbortSignal }): ForgeClient {
  const base = normalizeForgeUrl(options.url)
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init))

  async function get(path: string, what: string): Promise<unknown> {
    options.signal?.throwIfAborted()
    let response: Response
    try {
      response = await doFetch(`${base}/api/v1${path}`, {
        headers: { authorization: `token ${options.token}`, accept: 'application/json' },
        // A redirect could carry the header to another host: refuse it instead.
        redirect: 'error',
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new TaskError(`Could not reach the forge at ${base}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401) {
      throw new TaskError(`The forge refused the token stored under "${options.secretKey}" (401)`)
    }
    if (response.status === 403) {
      throw new TaskError(`The token stored under "${options.secretKey}" may not read ${what} (403): it needs read:repository and read:issue`)
    }
    if (!response.ok) {
      throw new TaskError(`The forge answered ${response.status} for ${what}`)
    }
    try {
      return await response.json()
    } catch {
      throw new TaskError(`The forge at ${base} did not answer with JSON for ${what}: is this the right address?`)
    }
  }

  return {
    base,
    async changedRepos(owner, since) {
      const repos = new Set<string>()
      for (let page = 1; page <= MAX_PAGES; page++) {
        const query = new URLSearchParams({ type: 'pulls', state: 'all', owner, limit: String(PAGE), page: String(page) })
        if (since) {
          query.set('since', since)
        }
        const items = (await get(`/repos/issues/search?${query}`, `the pull requests of ${owner}`)) as Json[]
        for (const item of Array.isArray(items) ? items : []) {
          const repo = text(((item.repository ?? {}) as Json).full_name)
          if (repo) {
            repos.add(repo)
          }
        }
        if (!Array.isArray(items) || items.length < PAGE) {
          break
        }
      }
      return [...repos].sort()
    },
    async pulls(repo, since) {
      const found: ForgePull[] = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const query = new URLSearchParams({ state: 'all', sort: 'recentupdate', limit: String(PAGE), page: String(page) })
        const items = (await get(`/repos/${repo.split('/').map(encodeURIComponent).join('/')}/pulls?${query}`, `the pull requests of ${repo}`)) as Json[]
        const pulls = (Array.isArray(items) ? items : []).map(toPull)
        // Compared as instants: the forge may write a time zone offset where the cursor has Z.
        const fresh = since ? pulls.filter((pull) => Date.parse(pull.updatedAt) >= Date.parse(since)) : pulls
        found.push(...fresh)
        // Newest update first: once one is older than the cursor, the rest are too.
        if (pulls.length < PAGE || fresh.length < pulls.length) {
          break
        }
      }
      return found
    },
  }
}
