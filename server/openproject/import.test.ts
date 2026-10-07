import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { type OpenProjectImportResult, type OpenProjectPreview, isImportResult, isPreview } from '../../shared/openproject.ts'
import { incomingDir } from '../attachments/files.ts'
import { deleteAttachment, listAttachments, readAttachment } from '../attachments/store.ts'
import { PNG, type TestScope, makeScope } from '../attachments/testing.ts'
import { changeStatus, getTask, listStatuses, listTasks, moveTask, updateTask } from '../service.ts'
import { normalizeBaseUrl } from './api.ts'
import {
  BASE,
  TOKEN,
  type AttachmentFixture,
  type WorkPackageFixture,
  activitiesBody,
  attachmentsBody,
  commentFixtures,
  extraUsers,
  projectBody,
  statusesBody,
  typesBody,
  workPackageFixtures,
  workPackagesPage,
} from './fixtures.ts'
import { linkTasks, unlinkTasks } from '../dependencies/store.ts'
import { type ImportDeps, importOpenProject, syncOpenProject } from './import.ts'
import { pointAtCopies } from './mapping.ts'
import { readState, recordSyncTry, saveSync, syncDue } from './store.ts'

const KEY = 'OPENPROJECT_API_TOKEN'
const AUTHORIZATION = `Basic ${Buffer.from(`apikey:${TOKEN}`).toString('base64')}`

interface Call {
  url: string
  init: RequestInit
}

/**
 * OpenProject as the fixtures describe it, answering at most three work
 * packages a page (a real server caps pageSize too), so paging is exercised.
 */
/** A relation as the fake server holds it: "from <type> to", by work package id. */
type RelationFixture = [id: number, type: string, from: number, to: number]

interface FakeState {
  workPackages: WorkPackageFixture[]
  comments: ReturnType<typeof commentFixtures>
  relations: RelationFixture[]
  /** By work package id. */
  attachments: Record<number, AttachmentFixture[]>
  /** Attachment ids whose content answers 500. */
  failing: Set<number>
}

function fakeOpenProject(
  state: FakeState = {
    workPackages: workPackageFixtures(),
    comments: commentFixtures(),
    relations: [],
    attachments: {},
    failing: new Set(),
  },
) {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/hal+json' } })
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: input, init })
    if ((init.headers as Record<string, string>).authorization !== AUTHORIZATION) {
      return json({ _type: 'Error', message: 'unauthenticated' }, 401)
    }
    const url = new URL(input)
    const path = url.pathname.replace(/^\/api\/v3/, '')
    if (path === '/projects/DEMO' || path === '/projects/4') return json(projectBody())
    if (path === '/projects/4/work_packages') {
      const offset = Number(url.searchParams.get('offset'))
      return json(workPackagesPage(state.workPackages, offset, Math.min(3, Number(url.searchParams.get('pageSize')))))
    }
    if (path === '/relations') {
      // Two a page, so paging is exercised; offset is the page number, as OpenProject counts it.
      const page = Number(url.searchParams.get('offset'))
      const size = Math.min(2, Number(url.searchParams.get('pageSize')))
      const elements = state.relations.slice((page - 1) * size, page * size).map(([id, type, from, to]) => ({
        _type: 'Relation',
        id,
        type,
        _links: { from: { href: `/api/v3/work_packages/${from}` }, to: { href: `/api/v3/work_packages/${to}` } },
      }))
      return json({ _type: 'Collection', total: state.relations.length, count: elements.length, _embedded: { elements } })
    }
    if (path === '/statuses') return json(statusesBody())
    if (path === '/projects/4/types') return json(typesBody())
    const activities = /^\/work_packages\/(\d+)\/activities$/.exec(path)
    if (activities) {
      const id = Number(activities[1])
      return json(activitiesBody(id, state.comments[id] ?? []))
    }
    const listed = /^\/work_packages\/(\d+)\/attachments$/.exec(path)
    if (listed) {
      const id = Number(listed[1])
      return json(attachmentsBody(id, state.attachments[id] ?? []))
    }
    const content = /^\/attachments\/(\d+)\/content$/.exec(path)
    if (content) {
      const id = Number(content[1])
      const found = Object.values(state.attachments)
        .flat()
        .find((attachment) => attachment.id === id)
      if (found && !state.failing.has(id)) {
        return new Response(new Uint8Array(found.bytes), { headers: { 'content-type': 'application/octet-stream' } })
      }
      return json({ _type: 'Error', message: 'failed' }, found ? 500 : 404)
    }
    const user = /^\/users\/(\d+)$/.exec(path)
    if (user && extraUsers[Number(user[1])]) return json({ _type: 'User', id: Number(user[1]), name: extraUsers[Number(user[1])] })
    return json({ _type: 'Error', message: 'not found' }, 404)
  }
  return { fetch, calls, state }
}

function scopeWithTeam(): TestScope {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  scope.agents = async () => [
    { id: 'agent-carol', name: 'Carol' },
    { id: 'agent-bob', name: 'Bob' },
  ]
  scope.people = async () => [{ id: 'user-jane', name: 'Jane Doe' }]
  return scope
}

const asPerson = (server: ReturnType<typeof fakeOpenProject>, secrets: Record<string, string> = { [KEY]: TOKEN }): ImportDeps => ({
  byPerson: true,
  resolveSecret: async (key) => secrets[key] ?? null,
  fetch: server.fetch,
})
const asAgent = (server: ReturnType<typeof fakeOpenProject>): ImportDeps => ({ ...asPerson(server), byPerson: false })

const CONNECT = { url: `${BASE}/api/v3/`, secretKey: KEY, project: 'demo' }

async function preview(scope: TestScope, deps: ImportDeps, input = {}): Promise<OpenProjectPreview> {
  const result = await importOpenProject(scope, input, deps)
  assert.ok(isPreview(result))
  return result
}

async function run(scope: TestScope, deps: ImportDeps, input = {}): Promise<OpenProjectImportResult> {
  const result = await importOpenProject(scope, { ...input, confirm: true }, deps)
  assert.ok(isImportResult(result))
  return result
}

const statusId = (scope: TestScope, name: string) => listStatuses(scope).find((status) => status.name === name)?.id as number

test('the address is https only, without credentials, and /api/v3 is dropped', () => {
  assert.equal(normalizeBaseUrl('https://op.example.com/api/v3/'), 'https://op.example.com')
  assert.equal(normalizeBaseUrl(' https://example.com/openproject/ '), 'https://example.com/openproject')
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080')
  assert.throws(() => normalizeBaseUrl('http://op.example.com'), /must start with https/)
  assert.throws(() => normalizeBaseUrl('https://apikey:secret@op.example.com'), /without a user name or password/)
  assert.throws(() => normalizeBaseUrl('op.example.com'), /is not an address/)
})

test('preview: counts, the suggested mapping, nothing imported; the token only in the header, redirects refused', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const result = await preview(scope, asPerson(server), CONNECT)

  assert.deepEqual(result.connection, { url: BASE, secretKey: KEY, project: 'demo' })
  assert.deepEqual(result.project, { id: 4, identifier: 'DEMO', name: 'Demo' })
  assert.equal(result.workPackages, 7)
  assert.equal(result.alreadyImported, 0)
  assert.deepEqual(
    result.byType.map((entry) => [entry.name, entry.count]),
    [['Task', 3], ['Milestone', 1], ['Summary task', 1], ['Bug', 1], ['Design', 1]],
  )
  assert.deepEqual(
    result.byStatus.map((entry) => [entry.name, entry.count, entry.isClosed]),
    [['Backlog', 3, false], ['In progress', 1, false], ['In testing', 1, false], ['Closed', 1, true], ['Rejected', 1, true]],
  )
  // Matched by name where we have one; otherwise a new status in a guessed category.
  assert.deepEqual(result.mapping.statuses, {
    '1': { create: { name: 'Backlog', category: 'todo', color: '#878787' } },
    '7': { status: statusId(scope, 'In Progress') },
    '9': { create: { name: 'In testing', category: 'in_progress', color: '#22B8CF' } },
    '12': { create: { name: 'Closed', category: 'done', color: '#35C53F' } },
    '14': { create: { name: 'Rejected', category: 'done', color: '#FFA8A8' } },
  })
  assert.deepEqual(result.mapping.types, { '3': 'epic', '1': 'task', '7': 'bug', '8': 'task', '2': 'task' })
  assert.deepEqual(result.mapping.people, {
    '5': { kind: 'agent', id: 'agent-bob', name: 'Bob' },
    '10': { kind: 'agent', id: 'agent-carol', name: 'Carol' },
    '21': { kind: 'person', id: 'user-jane', name: 'Jane Doe' },
    '30': { kind: 'person', name: 'Pat Outsider' },
  })
  assert.equal(result.keepNumbers, true)
  assert.equal(listTasks(scope).tasks.length, 0)
  assert.equal(readState(scope).connection?.url, BASE)

  // Three pages of at most three, and no comment reads before the import.
  assert.equal(server.calls.filter((call) => call.url.includes('/work_packages?')).length, 3)
  assert.ok(!server.calls.some((call) => call.url.includes('/activities')))
  for (const call of server.calls) {
    assert.ok(call.url.startsWith(`${BASE}/api/v3/`), call.url)
    assert.ok(!call.url.includes(TOKEN))
    assert.equal(call.init.redirect, 'error')
  }
  assert.ok(!JSON.stringify(result).includes(TOKEN))
})

test('import: hierarchy, numbers, fields, markdown and comments, with a summary of what was left out', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const result = await run(scope, asPerson(server), {
    ...CONNECT,
    mapping: { statuses: { '12': { status: statusId(scope, 'Done') }, '14': { status: statusId(scope, 'Cancelled') } } },
  })

  assert.deepEqual(result, {
    created: 7,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    comments: 4,
    relations: { found: 0, added: { blocks: 0, relates: 0, duplicates: 0, follows: 0 }, importedBefore: 0, alreadyHere: 0 },
    attachments: { added: 0, bytes: 0, importedBefore: 0, rewritten: 0 },
    statusesCreated: ['Backlog', 'In testing'],
    skipped: [{ source: 'Comments', summary: '1 internal comment', reason: 'Internal in OpenProject: only some members may read them there' }],
    notes: [
      '1 work package has its parent outside the project: imported as top-level tasks.',
      '1 automatic note ("Updated automatically by changing values within child work package") left out.',
    ],
  })

  // OpenProject's numbers are kept, and the next task follows them.
  const tasks = listTasks(scope).tasks
  assert.deepEqual(
    tasks.map((task) => [task.key, task.summary, task.parentKey]),
    [
      ['TASK-1', 'Launch the demo', null],
      ['TASK-2', 'Write the landing page', 'TASK-1'],
      ['TASK-3', 'Login fails on Safari', 'TASK-1'],
      ['TASK-4', 'Visual design', 'TASK-1'],
      ['TASK-5', 'Go live', 'TASK-1'],
      ['TASK-6', 'Pick the colour palette', 'TASK-4'],
      ['TASK-7', 'Share the demo with sales', null],
    ],
  )
  assert.equal(scope.db.prepare("SELECT value FROM project_meta WHERE key = 'next_number'").get()?.value, '8')

  const epic = getTask(scope, 'TASK-1')
  assert.equal(epic.type, 'epic')
  assert.equal(epic.status.name, 'In Progress')
  assert.deepEqual(epic.assignee, { kind: 'agent', id: 'agent-bob', name: 'Bob' })
  assert.deepEqual(epic.reporter, { kind: 'agent', name: 'Bob' })
  assert.deepEqual([epic.startDate, epic.endDate], ['2026-09-01', '2026-09-30'])
  assert.deepEqual(
    epic.comments.map((comment) => [comment.author.name, comment.body, comment.createdAt]),
    [['Bob', 'Kick-off: the demo ships at the end of September.', '2026-09-01T10:00:00.000Z']],
  )

  const page = getTask(scope, 'TASK-2')
  assert.equal(page.status.name, 'Done')
  assert.equal(page.priority, 'high')
  assert.deepEqual(page.assignee, { kind: 'agent', id: 'agent-carol', name: 'Carol' })
  assert.equal(page.description, `Ask @Jane Doe for copy. Mock-up: [design](${BASE}/api/v3/attachments/9/content), spec in #103.`)
  // The internal comment is left out; a commenter met nowhere else is named by OpenProject.
  assert.deepEqual(
    page.comments.map((comment) => [comment.author.name, comment.body]),
    [
      ['Carol', 'Done, see the preview link.'],
      ['Alex Reviewer', 'Looks good to me.'],
    ],
  )

  const bug = getTask(scope, 'TASK-3')
  assert.deepEqual([bug.type, bug.priority, bug.status.name], ['bug', 'highest', 'In testing'])
  // Only a start date: a one-day task on it. A milestone's date likewise.
  assert.deepEqual([bug.startDate, bug.endDate], ['2026-09-10', '2026-09-10'])
  assert.deepEqual([getTask(scope, 'TASK-5').startDate, getTask(scope, 'TASK-5').endDate], ['2026-09-30', '2026-09-30'])
  assert.equal(getTask(scope, 'TASK-4').startDate, null)
  const palette = getTask(scope, 'TASK-6')
  assert.deepEqual([palette.status.name, palette.priority, palette.assignee], ['Cancelled', 'low', { kind: 'person', name: 'Pat Outsider' }])

  // Records of work done elsewhere: nobody is notified, the list refreshes once.
  assert.equal((scope.db.prepare('SELECT count(*) AS n FROM inbox').get() as { n: number }).n, 0)
  assert.deepEqual(scope.events, [
    { keys: [], kind: 'task' },
    { keys: [], kind: 'status' },
  ])
  assert.deepEqual(readState(scope).lastImport?.result, result)
  assert.equal(readState(scope).lastImport?.by, 'Alice')
})

test('a re-run changes only what OpenProject changed, and never adds a comment twice', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await run(scope, asPerson(server), CONNECT)
  const before = listTasks(scope).tasks.map((task) => [task.key, task.rank])

  const commentReads = () => server.calls.filter((call) => call.url.includes('/activities')).length
  const readsBefore = commentReads()
  const again = await run(scope, asAgent(server))
  assert.deepEqual([again.created, again.updated, again.unchanged, again.comments, again.statusesCreated], [0, 0, 7, 0, []])
  assert.deepEqual(listTasks(scope).tasks.map((task) => [task.key, task.rank]), before)
  // Nothing changed in OpenProject, so no work package's comments are read again.
  assert.equal(commentReads(), readsBefore)
  const unchangedPreview = await preview(scope, asAgent(server))
  assert.equal(unchangedPreview.alreadyImported, 7)
  assert.deepEqual(unchangedPreview.plan, { create: 0, update: 0, unchanged: 7 })

  // In OpenProject: the bug is closed and commented on, a new work package is added under the epic.
  const bug = server.state.workPackages.find((wp) => wp.id === 103) as WorkPackageFixture
  Object.assign(bug, { status: [12, 'Closed'], updatedAt: '2026-09-20T08:00:00.000Z' })
  server.state.comments[103]?.push({ id: 5007, user: 21, body: 'Fixed in 1.0.1.', at: '2026-09-20T08:00:00.000Z' })
  server.state.workPackages.push({ id: 108, number: 8, subject: 'Press release', type: [1, 'Task'], status: [1, 'Backlog'], author: [5, 'Bob (Lead Agent)'], parent: 101 })

  // The preview counts what confirming would do, and writes none of it.
  const changedPreview = await preview(scope, asAgent(server))
  assert.deepEqual(changedPreview.plan, { create: 1, update: 1, unchanged: 6 })
  assert.deepEqual(changedPreview.conflicts, [])
  assert.equal(listTasks(scope).tasks.length, 7)
  assert.equal(getTask(scope, 'TASK-3').status.name, 'In testing')

  const readsBeforeThird = commentReads()
  const third = await run(scope, asAgent(server))
  assert.deepEqual([third.created, third.updated, third.unchanged, third.comments, third.statusesCreated], [1, 1, 6, 1, []])
  // Only the changed bug's and the new work package's comments are read.
  assert.equal(commentReads() - readsBeforeThird, 2)
  const fixed = getTask(scope, 'TASK-3')
  assert.equal(fixed.status.name, 'Closed')
  assert.deepEqual(
    fixed.activity.filter((entry) => entry.field === 'status').map((entry) => [entry.from, entry.to]),
    [['In testing', 'Closed']],
  )
  assert.deepEqual(fixed.comments.map((comment) => comment.body), ['Reproduced on Safari 17 only.', 'Fixed in 1.0.1.'])
  assert.equal(getTask(scope, 'TASK-8').parentKey, 'TASK-1')
  // The new task comes after everything that was here.
  assert.equal(listTasks(scope).tasks.at(-1)?.key, 'TASK-8')
})

test('a skipped type leaves its work packages out, and their children move up to the nearest imported ancestor', async () => {
  const scope = scopeWithTeam()
  const result = await run(scope, asPerson(fakeOpenProject()), { ...CONNECT, mapping: { types: { '8': 'skip' } } })
  assert.equal(result.created, 6)
  assert.deepEqual(result.skipped[0], { source: 'DEMO-4', summary: 'Visual design', reason: 'Type "Design" is set to skip' })
  assert.equal(getTask(scope, 'TASK-6').parentKey, 'TASK-1')
  assert.ok(!listTasks(scope).tasks.some((task) => task.key === 'TASK-4'))
})

test('numbers already taken here are not reused: imported tasks take the next free ones', async () => {
  const scope = scopeWithTeam()
  scope.db.prepare("UPDATE project_meta SET value = '5' WHERE key = 'next_number'").run()
  await run(scope, asPerson(fakeOpenProject()), CONNECT)
  // 1-4 are below the project's next number, so those take 8-11; 5-7 keep theirs.
  assert.deepEqual(
    listTasks(scope).tasks.map((task) => task.key),
    ['TASK-8', 'TASK-9', 'TASK-10', 'TASK-11', 'TASK-5', 'TASK-6', 'TASK-7'],
  )
})

test('only a person sets the address and the key; an agent uses the saved connection or none', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await assert.rejects(importOpenProject(scope, {}, asAgent(server)), /No OpenProject connection is saved yet/)
  await assert.rejects(importOpenProject(scope, CONNECT, asAgent(server)), /Only a person sets/)
  assert.equal(server.calls.length, 0)

  await preview(scope, asPerson(server), CONNECT)
  await assert.rejects(importOpenProject(scope, { url: 'https://evil.example.com' }, asAgent(server)), /Only a person sets/)
  await assert.rejects(importOpenProject(scope, { secretKey: 'OPENPROJECT_OTHER' }, asAgent(server)), /Only a person sets/)
  // Restating the saved values is allowed, and so is choosing the project.
  assert.equal((await preview(scope, asAgent(server), { url: BASE, secretKey: KEY, project: '4' })).project.id, 4)
  // An agent's call does not change what is saved.
  assert.equal(readState(scope).connection?.project, 'demo')
})

test('only an OpenProject key is read from the Secrets Store, and errors name the key, never the token', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const asked: string[] = []
  const deps: ImportDeps = { byPerson: true, resolveSecret: async (key) => (asked.push(key), key === 'OPENPROJECT_WRONG' ? 'not-the-token' : null), fetch: server.fetch }

  await assert.rejects(importOpenProject(scope, { ...CONNECT, secretKey: 'MY_KEY' }, deps), /must start with OPENPROJECT_/)
  await assert.rejects(importOpenProject(scope, { ...CONNECT, secretKey: 'FORGE_PASSWORD' }, deps), /must start with OPENPROJECT_/)
  assert.deepEqual(asked, [])

  await assert.rejects(importOpenProject(scope, { ...CONNECT, secretKey: 'OPENPROJECT_MISSING' }, deps), /Secrets Store has no key "OPENPROJECT_MISSING"/)
  await assert.rejects(importOpenProject(scope, { ...CONNECT, secretKey: 'OPENPROJECT_WRONG' }, deps), (error: Error) => {
    assert.match(error.message, /refused the token stored under "OPENPROJECT_WRONG" \(401\)/)
    assert.ok(!error.message.includes('not-the-token'))
    return true
  })

  // A key saved before the prefix rule is checked again before it is read.
  scope.db.prepare("INSERT INTO openproject_import (id, url, project, secret_key) VALUES (1, ?, 'demo', 'MY_KEY')").run(BASE)
  await assert.rejects(importOpenProject(scope, {}, asAgent(server)), /must start with OPENPROJECT_/)
  assert.deepEqual(asked, ['OPENPROJECT_MISSING', 'OPENPROJECT_WRONG'])
})

test('a redirect is refused rather than followed, and the project is found in either case', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const redirecting = async (input: string, init: RequestInit) => {
    if (init.redirect === 'error' && input.includes('/statuses')) throw new TypeError('fetch failed: redirect mode is set to error')
    return server.fetch(input, init)
  }
  await assert.rejects(importOpenProject(scope, CONNECT, { ...asPerson(server), fetch: redirecting }), /Could not reach OpenProject at https:\/\/openproject.example.com: fetch failed/)
  assert.equal(listTasks(scope).tasks.length, 0)

  const lower = server.calls.filter((call) => call.url.endsWith('/projects/demo'))
  const upper = server.calls.filter((call) => call.url.endsWith('/projects/DEMO'))
  assert.deepEqual([lower.length, upper.length], [1, 1])
})

test('mapping input is checked: unknown statuses, types and people are refused', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await assert.rejects(importOpenProject(scope, { ...CONNECT, mapping: { statuses: { '1': { status: 999 } } } }, asPerson(server)), /there is no status 999/)
  await assert.rejects(importOpenProject(scope, { ...CONNECT, mapping: { types: { '1': 'feature' as never } } }, asPerson(server)), /must be one of: /)
  await assert.rejects(importOpenProject(scope, { ...CONNECT, mapping: { people: { '5': { kind: 'agent', id: 'nobody', name: 'Nobody' } } } }, asPerson(server)), /no agent "nobody"/)
  await assert.rejects(
    importOpenProject(scope, { ...CONNECT, mapping: { statuses: { '1': { create: { name: 'x'.repeat(41), category: 'todo', color: null } } } } }, asPerson(server)),
    /at most 40 characters/,
  )
  // A person mapped to null is kept by name only: unassigned.
  await run(scope, asPerson(server), { ...CONNECT, mapping: { people: { '10': null } } })
  assert.equal(getTask(scope, 'TASK-2').assignee, null)
})

const workPackageOf = (server: ReturnType<typeof fakeOpenProject>, id: number) => server.state.workPackages.find((wp) => wp.id === id) as WorkPackageFixture

test('edits made here stay; OpenProject changes to other fields come through; a field changed on both sides is a conflict', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await run(scope, asPerson(server), CONNECT)
  // Here: the bug gets a sharper summary and is set to Done.
  await updateTask(scope, { key: 'TASK-3', summary: 'Login fails on Safari 17' })
  await changeStatus(scope, { key: 'TASK-3', status: 'Done' })
  // In OpenProject: the bug is closed and its priority lowered; its subject is as imported.
  const bug = workPackageOf(server, 103)
  Object.assign(bug, { status: [12, 'Closed'], priority: 'Low', updatedAt: '2026-09-20T08:00:00.000Z' })

  const conflict = { key: 'TASK-3', summary: 'Login fails on Safari 17', fields: [{ field: 'status', here: 'Done', openProject: 'Closed' }], overwritten: false }
  const planned = await preview(scope, asAgent(server))
  assert.deepEqual(planned.plan, { create: 0, update: 1, unchanged: 6 })
  assert.deepEqual(planned.conflicts, [conflict])

  const result = await run(scope, asAgent(server))
  assert.deepEqual([result.created, result.updated, result.unchanged], [0, 1, 6])
  assert.deepEqual(result.conflicts, [conflict])
  assert.ok(result.notes.includes('1 task keeps the edits made here where OpenProject changed the same fields: see the conflicts.'))
  const kept = getTask(scope, 'TASK-3')
  assert.deepEqual([kept.summary, kept.status.name, kept.priority], ['Login fails on Safari 17', 'Done', 'low'])

  // Reported once: OpenProject touching the bug again without changing those fields brings no conflict back.
  bug.updatedAt = '2026-09-21T08:00:00.000Z'
  const quiet = await run(scope, asAgent(server))
  assert.deepEqual([quiet.updated, quiet.unchanged, quiet.conflicts], [0, 7, []])
  assert.equal(getTask(scope, 'TASK-3').status.name, 'Done')

  // Named in overwrite, the task takes OpenProject's value; a key with no conflict is reported, not ignored.
  Object.assign(bug, { status: [14, 'Rejected'], updatedAt: '2026-09-22T08:00:00.000Z' })
  const forced = await run(scope, asAgent(server), { overwrite: ['task-3', 'TASK-99'] })
  assert.deepEqual(forced.conflicts, [{ ...conflict, fields: [{ field: 'status', here: 'Done', openProject: 'Rejected' }], overwritten: true }])
  assert.ok(forced.notes.includes('Nothing to overwrite on TASK-99: it has no conflict with OpenProject.'))
  const taken = getTask(scope, 'TASK-3')
  assert.deepEqual([taken.summary, taken.status.name], ['Login fails on Safari 17', 'Rejected'])
  assert.deepEqual(
    taken.activity.filter((entry) => entry.field === 'status').map((entry) => [entry.actor.name, entry.from, entry.to]),
    [
      ['Alice', 'In testing', 'Done'],
      ['Alice', 'Done', 'Rejected'],
    ],
  )
})

test('a parent chosen here stays; moved on both sides to different parents, it is a conflict', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await run(scope, asPerson(server), CONNECT)
  // Here: the palette moves from under the visual design to the epic.
  await moveTask(scope, { key: 'TASK-6', parent: 'TASK-1' })

  // In OpenProject: only its subject changes.
  const palette = workPackageOf(server, 106)
  Object.assign(palette, { subject: 'Pick the palette', updatedAt: '2026-09-20T08:00:00.000Z' })
  const renamed = await run(scope, asAgent(server))
  assert.deepEqual([renamed.updated, renamed.conflicts], [1, []])
  assert.deepEqual([getTask(scope, 'TASK-6').summary, getTask(scope, 'TASK-6').parentKey], ['Pick the palette', 'TASK-1'])

  // In OpenProject: it moves under Go live.
  Object.assign(palette, { parent: 105, updatedAt: '2026-09-21T08:00:00.000Z' })
  const moved = await run(scope, asAgent(server))
  assert.deepEqual(moved.conflicts, [{ key: 'TASK-6', summary: 'Pick the palette', fields: [{ field: 'parent', here: 'TASK-1', openProject: 'TASK-5' }], overwritten: false }])
  assert.equal(moved.updated, 0)
  assert.equal(getTask(scope, 'TASK-6').parentKey, 'TASK-1')
})

test('the schedule runs only after a first import and when due, and keeps the edits made here', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const deps = { resolveSecret: async (key: string) => (key === KEY ? TOKEN : null), fetch: server.fetch }
  assert.equal(await syncOpenProject(scope, deps), null)
  await preview(scope, asPerson(server), CONNECT)
  const calls = server.calls.length
  // Connected but never imported: no mapping anyone has seen, so nothing runs.
  assert.equal(await syncOpenProject(scope, deps), null)
  assert.equal(server.calls.length, calls)
  assert.equal(syncDue(scope, Date.now() + 86_400_000), false)

  await run(scope, asPerson(server), CONNECT)
  const importedAt = Date.parse(readState(scope).lastImport?.at as string)
  assert.deepEqual(readState(scope).sync, { minutes: null, error: null })
  assert.equal(syncDue(scope, importedAt + 86_400_000), false)
  saveSync(scope, 15)
  assert.deepEqual(readState(scope).sync, { minutes: 15, error: null })
  assert.equal(syncDue(scope, importedAt + 14 * 60_000), false)
  assert.equal(syncDue(scope, importedAt + 15 * 60_000), true)
  // A failed run is shown, and the next waits the same interval after it.
  recordSyncTry(scope, 'Could not reach OpenProject')
  const failed = readState(scope).sync.error
  assert.equal(failed?.message, 'Could not reach OpenProject')
  assert.equal(syncDue(scope, Date.parse(failed?.at as string) + 14 * 60_000), false)
  assert.equal(syncDue(scope, Date.parse(failed?.at as string) + 15 * 60_000), true)

  await changeStatus(scope, { key: 'TASK-3', status: 'Done' })
  Object.assign(workPackageOf(server, 103), { status: [12, 'Closed'], updatedAt: '2026-09-20T08:00:00.000Z' })
  const synced = await syncOpenProject(scope, deps)
  assert.deepEqual(synced?.conflicts.map((conflict) => [conflict.key, conflict.overwritten]), [['TASK-3', false]])
  assert.equal(getTask(scope, 'TASK-3').status.name, 'Done')
  saveSync(scope, null)
  assert.deepEqual(readState(scope).sync, { minutes: null, error: null })
})

test('relations only: mapped by the work package each task came from, previewed first, imported once', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  await run(scope, asPerson(server), CONNECT)
  server.state.relations.push(
    [1, 'relates', 102, 103],
    [2, 'blocks', 103, 105],
    [3, 'precedes', 104, 105],
    [4, 'duplicated', 106, 102],
    [5, 'includes', 101, 102],
    [6, 'relates', 102, 999],
    [7, 'relates', 998, 999],
    [8, 'blocks', 105, 103],
  )
  const relations = async (confirm: boolean) => {
    const result = await importOpenProject(scope, { relations: true, confirm }, asAgent(server))
    assert.ok(!isPreview(result) && !isImportResult(result))
    return result
  }
  const expected = {
    found: 6,
    added: { relates: 1, blocks: 1, follows: 1, duplicates: 1 },
    importedBefore: 0,
    alreadyHere: 0,
    skipped: [
      { source: 'TASK-5 blocks TASK-3', summary: 'OpenProject relation 8', reason: 'TASK-5 cannot block TASK-3: that would make a loop (TASK-3 → TASK-5 → TASK-3)' },
      { source: 'Relations', summary: '1 relation', reason: 'The work package at the other end is not imported here: in another project, or of a type left out' },
      { source: 'Relations', summary: '1 "includes" relation', reason: 'No such relation here' },
    ],
  }

  const workPackageReads = server.calls.filter((call) => call.url.includes('/work_packages?')).length
  assert.deepEqual(await relations(false), { imported: false, ...expected })
  assert.deepEqual(getTask(scope, 'TASK-2').relatesTo, [], 'a preview writes nothing')

  assert.deepEqual(await relations(true), { imported: true, ...expected })
  assert.equal(server.calls.filter((call) => call.url.includes('/work_packages?')).length, workPackageReads, 'no work package is read again')
  const two = getTask(scope, 'TASK-2')
  assert.deepEqual([two.relatesTo, two.duplicates].map((list) => list.map((task) => task.key)), [['TASK-3'], ['TASK-6']])
  const five = getTask(scope, 'TASK-5')
  assert.deepEqual(five.blockers, [{ key: 'TASK-3', open: true }])
  assert.deepEqual(five.follows.map((task) => task.key), ['TASK-4'])
  assert.deepEqual(getTask(scope, 'TASK-6').duplicatedBy.map((task) => task.key), ['TASK-2'])

  // A re-run adds nothing twice, and a relation removed here stays removed.
  unlinkTasks(scope, { type: 'relates', from: 'TASK-3', to: 'TASK-2' })
  assert.deepEqual(await relations(true), {
    ...expected,
    imported: true,
    added: { relates: 0, blocks: 0, follows: 0, duplicates: 0 },
    importedBefore: 4,
  })
  assert.deepEqual(getTask(scope, 'TASK-2').relatesTo, [])

  // One recorded here by hand is counted, not added again.
  server.state.relations.push([9, 'follows', 106, 101])
  linkTasks(scope, { type: 'follows', from: 'TASK-6', to: 'TASK-1' })
  assert.equal((await relations(true)).alreadyHere, 1)
})

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0])
const CAROL_OP: [number, string] = [10, 'Carol (Agent)']
const JANE_OP: [number, string] = [21, 'Jane Doe']
const TOO_LARGE = { source: 'DEMO-2', summary: 'demo.mp4 (30 MB)', reason: 'Over the 25 MB limit per file' }

const contentReads = (server: ReturnType<typeof fakeOpenProject>) => server.calls.filter((call) => call.url.endsWith('/content')).length
const listReads = (server: ReturnType<typeof fakeOpenProject>) => server.calls.filter((call) => call.url.endsWith('/attachments')).length
const attachmentRows = (scope: TestScope) => (scope.db.prepare('SELECT count(*) AS n FROM task_attachment').get() as { n: number }).n

/** Attachments on the landing page (one too large) and on the bug, with images embedded in a description and a comment. */
function withAttachments(server: ReturnType<typeof fakeOpenProject>) {
  server.state.attachments[102] = [
    { id: 301, fileName: 'mock-up.png', bytes: PNG, author: CAROL_OP, at: '2026-09-03T10:00:00.000Z' },
    { id: 302, fileName: 'notes.txt', bytes: Buffer.from('hello'), author: [30, 'Pat Outsider'], at: '2026-09-03T11:00:00.000Z' },
    { id: 303, fileName: 'demo.mp4', bytes: Buffer.from('x'), fileSize: 30 * 1024 * 1024, author: CAROL_OP, at: '2026-09-03T12:00:00.000Z' },
  ]
  server.state.attachments[103] = [{ id: 304, fileName: 'safari.jpg', bytes: JPEG, author: JANE_OP, at: '2026-09-11T09:00:00.000Z' }]
  workPackageOf(server, 102).description =
    'See ![Mock-up](/api/v3/attachments/301/content) and <img src="/api/v3/attachments/301/content" alt="again">, notes [here](/api/v3/attachments/302/content).'
  server.state.comments[103]?.push({ id: 5010, user: 21, body: `Screenshot:\n![Safari](${BASE}/api/v3/attachments/304/content)`, at: '2026-09-11T09:31:00.000Z' })
}

test('attachments: counted in the preview, imported with their name, type, time and uploader; embedded images show the copy', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  withAttachments(server)

  const planned = await preview(scope, asPerson(server), CONNECT)
  assert.deepEqual(planned.attachments, { count: 3, bytes: PNG.length + 5 + JPEG.length, skipped: [TOO_LARGE] })
  assert.equal(attachmentRows(scope), 0, 'a preview writes nothing')
  assert.equal(contentReads(server), 0, 'a preview reads no file')

  const result = await run(scope, asPerson(server), CONNECT)
  assert.deepEqual(result.attachments, { added: 3, bytes: PNG.length + 5 + JPEG.length, importedBefore: 0, rewritten: 2 })
  assert.deepEqual(result.skipped.filter((item) => item.source === 'DEMO-2'), [TOO_LARGE])
  assert.equal(contentReads(server), 3, 'the file over the limit is never read')
  assert.deepEqual(readState(scope).lastImport?.result, result)

  const files = listAttachments(scope, 'TASK-2')
  assert.deepEqual(
    files.map((file) => [file.name, file.contentType, file.previewable, file.size, file.createdAt, file.uploader]),
    [
      // The type comes from the bytes; the uploader is mapped like an assignee, or kept by name.
      ['mock-up.png', 'image/png', true, PNG.length, '2026-09-03T10:00:00.000Z', { kind: 'agent', name: 'Carol' }],
      ['notes.txt', 'text/plain', false, 5, '2026-09-03T11:00:00.000Z', { kind: 'person', name: 'Pat Outsider' }],
    ],
  )
  const mockUp = files[0]?.id as string
  assert.equal(readAttachment(scope, mockUp).contentBase64, PNG.toString('base64'))
  // Images point at the copy; a plain link to a file stays a link to OpenProject.
  assert.equal(
    getTask(scope, 'TASK-2').description,
    `See ![Mock-up](attachment:${mockUp}) and ![again](attachment:${mockUp}), notes [here](${BASE}/api/v3/attachments/302/content).`,
  )
  const [shot] = listAttachments(scope, 'TASK-3')
  assert.deepEqual(shot?.uploader, { kind: 'person', name: 'Jane Doe' })
  assert.equal(getTask(scope, 'TASK-3').comments.at(-1)?.body, `Screenshot:\n![Safari](attachment:${shot?.id})`)

  // A re-run with nothing changed reads no list and adds nothing; it still counts all three as imported before.
  const lists = listReads(server)
  const again = await run(scope, asAgent(server))
  assert.deepEqual(again.attachments, { added: 0, bytes: 0, importedBefore: 3, rewritten: 0 })
  assert.deepEqual([again.updated, again.conflicts], [0, []])
  assert.equal(listReads(server), lists)
  assert.equal(attachmentRows(scope), 3)

  // One removed here stays removed; a new one in OpenProject is added.
  deleteAttachment(scope, mockUp)
  server.state.attachments[102]?.push({ id: 305, fileName: 'final.png', bytes: PNG, author: CAROL_OP, at: '2026-09-20T08:00:00.000Z' })
  workPackageOf(server, 102).updatedAt = '2026-09-20T08:00:00.000Z'
  const third = await run(scope, asAgent(server))
  assert.deepEqual(third.attachments, { added: 1, bytes: PNG.length, importedBefore: 3, rewritten: 0 })
  assert.deepEqual(listAttachments(scope, 'TASK-2').map((file) => file.name), ['notes.txt', 'final.png'])
  assert.deepEqual(third.conflicts, [])
})

test('an already-imported project gets its attachments on a plain re-run, and images imported before point at them', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  workPackageOf(server, 103).description = 'Seen here: ![Safari](/api/v3/attachments/304/content)'
  await run(scope, asPerson(server), CONNECT)
  assert.equal(getTask(scope, 'TASK-3').description, `Seen here: ![Safari](${BASE}/api/v3/attachments/304/content)`)
  // As a project imported before attachments came along: no list read yet.
  scope.db.exec('UPDATE task_source SET attachments_read_at = NULL')
  server.state.attachments[103] = [{ id: 304, fileName: 'safari.jpg', bytes: JPEG, author: JANE_OP, at: '2026-09-11T09:00:00.000Z' }]

  const result = await run(scope, asAgent(server))
  assert.deepEqual([result.created, result.updated], [0, 0])
  assert.deepEqual(result.attachments, { added: 1, bytes: JPEG.length, importedBefore: 0, rewritten: 1 })
  const [shot] = listAttachments(scope, 'TASK-3')
  assert.equal(getTask(scope, 'TASK-3').description, `Seen here: ![Safari](attachment:${shot?.id})`)

  // What the import last wrote was rewritten too: a later change in OpenProject is not taken for a changed description.
  Object.assign(workPackageOf(server, 103), { status: [12, 'Closed'], updatedAt: '2026-09-20T08:00:00.000Z' })
  const later = await run(scope, asAgent(server))
  assert.deepEqual([later.updated, later.conflicts], [1, []])
  assert.equal(getTask(scope, 'TASK-3').description, `Seen here: ![Safari](attachment:${shot?.id})`)
})

test('a file that cannot be read is listed, and the next run tries it again', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  server.state.attachments[104] = [{ id: 306, fileName: 'palette.png', bytes: PNG, author: JANE_OP, at: '2026-09-04T09:00:00.000Z' }]
  server.state.failing.add(306)
  const first = await run(scope, asPerson(server), CONNECT)
  assert.equal(first.attachments?.added, 0)
  assert.deepEqual(first.skipped.filter((item) => item.source === 'DEMO-4'), [
    { source: 'DEMO-4', summary: 'palette.png', reason: 'Could not be read: OpenProject answered 500 for attachment 306. The next import tries again.' },
  ])
  assert.equal(attachmentRows(scope), 0)
  assert.deepEqual(fs.readdirSync(incomingDir(scope.dataDir)), [], 'nothing is left half-read')

  server.state.failing.delete(306)
  const second = await run(scope, asAgent(server))
  assert.equal(second.attachments?.added, 1)
  assert.deepEqual(listAttachments(scope, 'TASK-4').map((file) => file.name), ['palette.png'])
})

test('the scheduled run brings new relations and attachments too, and never one removed here', async () => {
  const scope = scopeWithTeam()
  const server = fakeOpenProject()
  const deps = { resolveSecret: async (key: string) => (key === KEY ? TOKEN : null), fetch: server.fetch }
  await run(scope, asPerson(server), CONNECT)

  // In OpenProject: a relation, and a file on the bug (which changes its updatedAt).
  server.state.relations.push([1, 'relates', 102, 103])
  server.state.attachments[103] = [{ id: 307, fileName: 'trace.txt', bytes: Buffer.from('stack'), author: JANE_OP, at: '2026-09-20T08:00:00.000Z' }]
  workPackageOf(server, 103).updatedAt = '2026-09-20T08:00:00.000Z'
  const planned = await preview(scope, asAgent(server))
  assert.deepEqual([planned.relations, planned.attachments.count], [1, 1])

  const synced = await syncOpenProject(scope, deps)
  assert.deepEqual(synced?.relations?.added, { blocks: 0, relates: 1, duplicates: 0, follows: 0 })
  assert.equal(synced?.attachments?.added, 1)
  assert.deepEqual(getTask(scope, 'TASK-2').relatesTo.map((task) => task.key), ['TASK-3'])
  const [trace] = listAttachments(scope, 'TASK-3')
  assert.equal(trace?.name, 'trace.txt')

  // Removed here, then OpenProject changes the bug again: neither comes back.
  unlinkTasks(scope, { type: 'relates', from: 'TASK-2', to: 'TASK-3' })
  deleteAttachment(scope, trace?.id)
  workPackageOf(server, 103).updatedAt = '2026-09-21T08:00:00.000Z'
  const next = await syncOpenProject(scope, deps)
  assert.deepEqual([next?.relations?.importedBefore, next?.attachments?.importedBefore, next?.attachments?.added], [1, 1, 0])
  assert.deepEqual(getTask(scope, 'TASK-2').relatesTo, [])
  assert.deepEqual(listAttachments(scope, 'TASK-3'), [])
})

test('embedded images of imported attachments point at the copy, in every form OpenProject writes them', () => {
  const copies = new Map([
    ['7', '00000000-0000-4000-8000-000000000007'],
    ['8', '00000000-0000-4000-8000-000000000008'],
  ])
  const point = (text: string) => pointAtCopies(text, BASE, copies)
  const seven = 'attachment:00000000-0000-4000-8000-000000000007'
  assert.equal(point('![a](/api/v3/attachments/7/content)'), `![a](${seven})`)
  assert.equal(point(`![a](${BASE}/api/v3/attachments/7/content "title")`), `![a](${seven})`)
  assert.equal(point('![](/attachments/7/shot.png)'), `![](${seven})`)
  assert.equal(point('<img class="op-uc-image" src="/api/v3/attachments/8/content" alt="b">'), '![b](attachment:00000000-0000-4000-8000-000000000008)')
  assert.equal(point('![c](/api/v3/attachments/9/content)'), '![c](/api/v3/attachments/9/content)', 'not imported here')
  assert.equal(point('[a](/api/v3/attachments/7/content)'), '[a](/api/v3/attachments/7/content)', 'a link, not an image')
  assert.equal(point('![a](https://elsewhere.example.com/api/v3/attachments/7/content)'), '![a](https://elsewhere.example.com/api/v3/attachments/7/content)')
})
