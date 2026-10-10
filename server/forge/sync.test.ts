import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeScope } from '../attachments/testing.ts'
import { taskRow } from '../compact.ts'
import { createTask, getTask, listTasks } from '../service.ts'
import { type Fetch, forgeClient } from './api.ts'
import { checkConnection, usableConnection } from './connect.ts'
import { readConnection, readStatus, saveConnection } from './store.ts'
import { mentionedNumbers, syncOnce } from './sync.ts'

const BASE = 'https://git.example.com'
const TOKEN = 'forge-test-token-8d2a'

/** A pull request on the fake forge, in the Gitea API v1 shape the list answers with (trimmed). */
interface FakePull {
  repo: string
  number: number
  title: string
  body?: string
  state: 'open' | 'closed'
  merged?: boolean
  user: string
  head: string
  updated: string
}

/** A forge serving `pulls` the way Forgejo does: issue search by `since`, per-repository lists newest update first, in pages. */
function fakeForge(pulls: FakePull[]) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const state = { refuse: 0 }
  const fetch: Fetch = async (input, init) => {
    requests.push({ url: input, init })
    if (state.refuse) {
      return json({ message: 'token is required' }, state.refuse)
    }
    const url = new URL(input)
    const limit = Number(url.searchParams.get('limit') ?? 30)
    const page = Number(url.searchParams.get('page') ?? 1)
    const since = url.searchParams.get('since')
    const byUpdate = pulls
      .filter((pull) => !since || Date.parse(pull.updated) >= Date.parse(since))
      .sort((a, b) => b.updated.localeCompare(a.updated))
    if (url.pathname === '/api/v1/repos/issues/search') {
      const found = byUpdate.filter((pull) => pull.repo.startsWith(`${url.searchParams.get('owner')}/`))
      return json(
        found
          .slice((page - 1) * limit, page * limit)
          .map((pull) => ({ number: pull.number, repository: { full_name: pull.repo }, pull_request: {} })),
      )
    }
    const repo = /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)?.[1]
    if (repo) {
      const all = pulls.filter((pull) => pull.repo === repo).sort((a, b) => b.updated.localeCompare(a.updated))
      return json(
        all.slice((page - 1) * limit, page * limit).map((pull) => ({
          number: pull.number,
          title: pull.title,
          body: pull.body ?? '',
          state: pull.state,
          merged: pull.merged ?? false,
          user: { login: pull.user },
          html_url: `${BASE}/${pull.repo}/pulls/${pull.number}`,
          head: { ref: pull.head },
          updated_at: pull.updated,
        })),
      )
    }
    return json({ message: 'not found' }, 404)
  }
  return { fetch, requests, state }
}

async function project() {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  for (const summary of ['Login page', 'Password reset', 'Session timeout']) {
    await createTask(scope, { summary })
  }
  saveConnection(scope.db, { url: BASE, owner: 'acme', secretKey: 'FORGEJO_TASKS_TOKEN' })
  return scope
}

const pullsOf = (scope: ReturnType<typeof makeScope>, key: string) =>
  getTask(scope, key).pullRequests.map((pr) => `${pr.repo}#${pr.number} ${pr.state}`)

test('a key counts in the title and body as written, and in the branch in any case', () => {
  assert.deepEqual(
    mentionedNumbers('TASK', {
      title: 'Fix TASK-12 and TASK-3',
      body: 'Follows TASK-120; not XTASK-5 or TASK-',
      headRef: 'fix-task-7-login',
    }),
    [3, 7, 12, 120],
  )
  assert.deepEqual(
    mentionedNumbers('TASK', { title: 'task-4 in lower case', body: '', headRef: 'refs/pull/9/head' }),
    [],
  )
  assert.deepEqual(
    mentionedNumbers('DEMO', { title: 'DEMO-1.2: a version, not DEMO-12', body: '', headRef: '' }),
    [1, 12],
  )
})

test('the first read links every pull request mentioning a task; later ones read only what changed', async () => {
  const scope = await project()
  const forge = fakeForge([
    {
      repo: 'acme/web',
      number: 5,
      title: 'TASK-1: the login form',
      state: 'open',
      user: 'ana',
      head: 'ana-login',
      updated: '2026-09-20T10:00:00Z',
    },
    {
      repo: 'acme/web',
      number: 6,
      title: 'Reset links expire',
      state: 'closed',
      merged: true,
      user: 'sam',
      head: 'sam-task-2-reset',
      updated: '2026-09-21T10:00:00Z',
    },
    {
      repo: 'acme/api',
      number: 1,
      title: 'Tidy the session code',
      body: 'Part of TASK-3, and TASK-4 later.',
      state: 'closed',
      user: 'ana',
      head: 'tidy',
      updated: '2026-09-22T10:00:00Z',
    },
    {
      repo: 'acme/api',
      number: 2,
      title: 'Bump dependencies',
      state: 'open',
      user: 'bot',
      head: 'deps',
      updated: '2026-09-22T11:00:00Z',
    },
    {
      repo: 'other/web',
      number: 1,
      title: 'TASK-1 elsewhere',
      state: 'open',
      user: 'x',
      head: 'x',
      updated: '2026-09-22T12:00:00Z',
    },
  ])
  const client = forgeClient({ url: BASE, token: TOKEN, secretKey: 'FORGEJO_TASKS_TOKEN', fetch: forge.fetch })
  const clock = () => new Date('2026-09-26T12:00:00Z')

  const first = await syncOnce(scope.db, 'TASK', client, clock)
  assert.deepEqual(first, { read: 4, changed: [1, 2, 3] })
  assert.deepEqual(pullsOf(scope, 'TASK-1'), ['acme/web#5 open'])
  assert.deepEqual(pullsOf(scope, 'TASK-2'), ['acme/web#6 merged'])
  assert.deepEqual(pullsOf(scope, 'TASK-3'), ['acme/api#1 closed'])
  assert.deepEqual(getTask(scope, 'TASK-1').pullRequests[0], {
    repo: 'acme/web',
    number: 5,
    title: 'TASK-1: the login form',
    state: 'open',
    author: 'ana',
    url: `${BASE}/acme/web/pulls/5`,
    branch: 'ana-login',
    updatedAt: '2026-09-20T10:00:00Z',
  })
  // The list's rows carry the counts, its filter the open ones, the compact row the open count.
  const rows = listTasks(scope).tasks
  assert.deepEqual(
    rows.map((task) => task.prs),
    [
      { open: 1, merged: 0, closed: 0 },
      { open: 0, merged: 1, closed: 0 },
      { open: 0, merged: 0, closed: 1 },
    ],
  )
  assert.deepEqual(
    listTasks(scope, { hasOpenPr: true }).tasks.map((task) => task.key),
    ['TASK-1'],
  )
  assert.deepEqual(
    listTasks(scope, { hasOpenPr: false }).tasks.map((task) => task.key),
    ['TASK-2', 'TASK-3'],
  )
  assert.equal(taskRow(rows[0]).openPrs, 1)
  assert.equal(taskRow(rows[1]).openPrs, undefined)
  assert.deepEqual(readStatus(scope.db), {
    connection: { url: BASE, owner: 'acme', secretKey: 'FORGEJO_TASKS_TOKEN' },
    lastSyncAt: '2026-09-26T12:00:00.000Z',
    lastError: null,
    pullRequests: 4,
    linked: 3,
  })
  // Every request carried the token in its header, and could not be redirected.
  assert.ok(
    forge.requests.every(
      (request) =>
        (request.init.headers as Record<string, string>).authorization === `token ${TOKEN}` &&
        request.init.redirect === 'error',
    ),
  )

  // A task created later finds the pull request that already names it.
  await createTask(scope, { summary: 'Session store' })
  assert.deepEqual(pullsOf(scope, 'TASK-4'), ['acme/api#1 closed'])

  // Nothing changed: one search, nothing else, nothing written.
  forge.requests.length = 0
  const quiet = await syncOnce(scope.db, 'TASK', client, () => new Date('2026-09-26T12:01:00Z'))
  assert.deepEqual(quiet, { read: 0, changed: [] })
  assert.equal(forge.requests.length, 1)
  assert.match(forge.requests[0].url, /issues\/search\?.*since=2026-09-26T11%3A58%3A00Z/)
})

test('a merge, a deleted branch and an edit that drops the key all come through', async () => {
  const scope = await project()
  const pulls: FakePull[] = [
    {
      repo: 'acme/web',
      number: 5,
      title: 'The login form',
      state: 'open',
      user: 'ana',
      head: 'ana-task-1-login',
      updated: '2026-09-26T10:00:00Z',
    },
    {
      repo: 'acme/web',
      number: 7,
      title: 'TASK-3: shorter sessions',
      state: 'open',
      user: 'sam',
      head: 'sam-sessions',
      updated: '2026-09-26T10:05:00Z',
    },
  ]
  const forge = fakeForge(pulls)
  const client = forgeClient({ url: BASE, token: TOKEN, secretKey: 'FORGEJO_TASKS_TOKEN', fetch: forge.fetch })
  await syncOnce(scope.db, 'TASK', client, () => new Date('2026-09-26T11:00:00Z'))
  assert.deepEqual(pullsOf(scope, 'TASK-1'), ['acme/web#5 open'])

  // Merged with its branch deleted: the forge now reports refs/pull/5/head, and the key lived only in the branch.
  Object.assign(pulls[0], { state: 'closed', merged: true, head: 'refs/pull/5/head', updated: '2026-09-26T11:30:00Z' })
  // Retitled without its key.
  Object.assign(pulls[1], { title: 'Shorter sessions', updated: '2026-09-26T11:31:00Z' })
  const next = await syncOnce(scope.db, 'TASK', client, () => new Date('2026-09-26T12:00:00Z'))
  assert.deepEqual(next.changed, [1, 3])
  assert.deepEqual(pullsOf(scope, 'TASK-3'), [])
  // The key came from the branch, which the merge deleted: the link stays, as it was read while open.
  assert.deepEqual(pullsOf(scope, 'TASK-1'), ['acme/web#5 merged'])
  assert.equal(getTask(scope, 'TASK-1').pullRequests[0]?.branch, 'ana-task-1-login')
})

test('a refused token is recorded without the token, and the cursor stays for the next read', async () => {
  const scope = await project()
  const forge = fakeForge([])
  const client = forgeClient({ url: BASE, token: TOKEN, secretKey: 'FORGEJO_TASKS_TOKEN', fetch: forge.fetch })
  await syncOnce(scope.db, 'TASK', client, () => new Date('2026-09-26T11:00:00Z'))
  const cursor = readConnection(scope.db)?.cursor
  forge.state.refuse = 401
  await assert.rejects(
    syncOnce(scope.db, 'TASK', client, () => new Date('2026-09-26T11:01:00Z')),
    /refused the token stored under "FORGEJO_TASKS_TOKEN" \(401\)/,
  )
  const status = readStatus(scope.db)
  assert.match(status.lastError ?? '', /FORGEJO_TASKS_TOKEN/)
  assert.ok(!JSON.stringify(status).includes(TOKEN))
  assert.equal(readConnection(scope.db)?.cursor, cursor)
})

test('only a person connects, to an https forge, naming a FORGEJO_ key', () => {
  const good = { url: 'https://git.example.com/', owner: 'acme', secretKey: 'FORGEJO_TASKS_TOKEN' }
  assert.deepEqual(checkConnection(good, true), {
    url: 'https://git.example.com',
    owner: 'acme',
    secretKey: 'FORGEJO_TASKS_TOKEN',
  })
  assert.throws(() => checkConnection(good, false), /Only a person connects the forge/)
  assert.throws(() => checkConnection({ ...good, secretKey: 'OPENAI_API_KEY' }, true), /starts with FORGEJO_/)
  assert.throws(() => checkConnection({ ...good, url: 'http://git.example.com' }, true), /must start with https/)
  assert.deepEqual(checkConnection({ ...good, url: 'http://localhost:3999/api/v1' }, true).url, 'http://localhost:3999')
  assert.throws(() => checkConnection({ ...good, owner: '../etc' }, true), /owner/)
})

test('connecting to another forge or owner forgets what was read through the old one', async () => {
  const scope = await project()
  const forge = fakeForge([
    {
      repo: 'acme/web',
      number: 5,
      title: 'TASK-1',
      state: 'open',
      user: 'ana',
      head: 'x',
      updated: '2026-09-26T10:00:00Z',
    },
  ])
  await syncOnce(
    scope.db,
    'TASK',
    forgeClient({ url: BASE, token: TOKEN, secretKey: 'FORGEJO_TASKS_TOKEN', fetch: forge.fetch }),
  )
  saveConnection(scope.db, { url: BASE, owner: 'acme', secretKey: 'FORGEJO_OTHER_TOKEN' })
  assert.deepEqual(pullsOf(scope, 'TASK-1'), ['acme/web#5 open'])
  saveConnection(scope.db, { url: BASE, owner: 'globex', secretKey: 'FORGEJO_OTHER_TOKEN' })
  assert.deepEqual(pullsOf(scope, 'TASK-1'), [])
  assert.equal(readConnection(scope.db)?.cursor, null)
})

test('a connection that arrived without Settings (a restored file) is reported, not read', async () => {
  const scope = await project()
  assert.deepEqual(usableConnection(scope.db), {
    connection: { url: BASE, owner: 'acme', secretKey: 'FORGEJO_TASKS_TOKEN' },
    problem: null,
  })
  for (const [url, key, reason] of [
    ['https://git.example.com', 'OPENAI_API_KEY', /starts with FORGEJO_/],
    ['http://collector.example.net', 'FORGEJO_TASKS_TOKEN', /must start with https/],
  ] as const) {
    scope.db.prepare('UPDATE forge_connection SET url = ?, secret_key = ? WHERE id = 1').run(url, key)
    const { connection, problem } = usableConnection(scope.db)
    assert.equal(connection, null)
    assert.match(problem ?? '', reason)
    assert.match(problem ?? '', /Connect again in Settings/)
  }
  scope.db.exec('DELETE FROM forge_connection')
  assert.deepEqual(usableConnection(scope.db), { connection: null, problem: null })
})
