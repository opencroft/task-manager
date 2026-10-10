import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { DETAIL_ACTIONS } from '../shared/compact.ts'
import type { TaskSummary } from '../shared/types.ts'
import type { WorkflowRun } from '../shared/workflows.ts'
import { withParamChecks } from './action-params.ts'
import { makeScope } from './attachments/testing.ts'
import { listComments } from './comments.ts'
import { runRow, taskRow, withDetail } from './compact.ts'
import { linkTasks } from './dependencies/store.ts'
import { addComment, createTask, deleteComment, getTask, listTasks, updateTask } from './service.ts'

const ctx = {} as never

test('a row keeps what an agent reads a list for, and leaves out what is empty', async () => {
  const scope = makeScope()
  const parent = (await createTask(scope, { summary: 'Epic', type: 'epic' })).result.key
  const child = (
    await createTask(scope, {
      summary: 'Build it',
      parent,
      labels: ['ui'],
      assignee: { kind: 'person', name: 'Alice' },
      startDate: '2026-10-01',
      endDate: '2026-10-03',
    })
  ).result.key
  const [epic, task] = listTasks(scope).tasks
  assert.deepEqual(taskRow(epic as TaskSummary), {
    key: parent,
    summary: 'Epic',
    status: 'To Do',
    type: 'epic',
    priority: 'medium',
    childCount: 1,
  })
  assert.deepEqual(taskRow(task as TaskSummary), {
    key: child,
    summary: 'Build it',
    status: 'To Do',
    type: 'task',
    priority: 'medium',
    assignee: 'Alice',
    parentKey: parent,
    labels: ['ui'],
    startDate: '2026-10-01',
    endDate: '2026-10-03',
  })
})

test('blockedBy lists only the blockers that are not done', () => {
  const base = {
    key: 'T-3',
    summary: 's',
    status: { name: 'To Do' },
    type: 'task',
    priority: 'low',
    assignee: null,
    parentKey: null,
    childCount: 0,
    labels: [],
    prs: { open: 0, merged: 0, closed: 0 },
  }
  const row = taskRow({
    ...base,
    startDate: null,
    endDate: null,
    blockers: [
      { key: 'T-1', open: true },
      { key: 'T-2', open: false },
    ],
  } as unknown as TaskSummary)
  assert.deepEqual(row.blockedBy, ['T-1'])
  assert.equal(
    'blockedBy' in taskRow({ ...base, blockers: [{ key: 'T-2', open: false }] } as unknown as TaskSummary),
    false,
  )
})

test('a run in brief names its steps, agents, outcomes and last gate result, and counts a rework only when there was one', () => {
  const step = {
    stepId: 'a',
    position: 0,
    agentNodeId: 'n1',
    chatRef: 'c',
    chatSlug: 'chat',
    threadRef: 't',
    threadId: 't1',
    startedAt: 'x',
    endedAt: 'y',
    summary: 'long text',
    finishedBy: 'Ace',
  }
  const run = {
    id: 'r1',
    taskKey: 'T-1',
    workflowId: 'w',
    workflowName: 'Dev',
    state: 'active',
    startedBy: { kind: 'person', name: 'M' },
    startedAt: '2026-09-26T10:00:00Z',
    endedAt: null,
    steps: [
      {
        ...step,
        name: 'Development',
        state: 'done',
        agentName: 'Ace',
        outcome: 'Review',
        attempts: 2,
        error: null,
        rounds: [{ gate: 'pass' }, { gate: 'pass' }],
      },
      {
        ...step,
        name: 'Review',
        state: 'active',
        agentName: null,
        outcome: null,
        attempts: 1,
        error: 'no chat',
        rounds: [{ gate: null }],
      },
    ],
  } as unknown as WorkflowRun
  assert.deepEqual(runRow(run), {
    taskKey: 'T-1',
    workflow: 'Dev',
    state: 'active',
    startedAt: '2026-09-26T10:00:00Z',
    steps: [
      { name: 'Development', state: 'done', agent: 'Ace', outcome: 'Review', gate: 'pass', attempts: 2 },
      { name: 'Review', state: 'active', error: 'no chat' },
    ],
  })
})

test('an action answers compact by default and in full when asked, and its handler never sees detail', async () => {
  const scope = makeScope()
  const key = (await createTask(scope, { summary: 'One' })).result.key
  const seen: unknown[] = []
  const actions = withDetail({
    task_update: async (_ctx, params) => {
      seen.push(params)
      return updateTask(scope, { key, ...(params as object) })
    },
    task_get: (_ctx, params) => getTask(scope, params.key),
  })
  const compact = (await actions.task_update?.(ctx, { summary: 'Two' })) as { result: object }
  assert.deepEqual(compact, { result: { key, summary: 'Two', status: 'To Do', type: 'task', priority: 'medium' } })
  const full = (await actions.task_update?.(ctx, { summary: 'Three', detail: 'full' })) as {
    result: { rank: string; comments: unknown[] }
  }
  assert.equal(typeof full.result.rank, 'string')
  assert.ok(Array.isArray(full.result.comments))
  assert.deepEqual(seen, [{ summary: 'Two' }, { summary: 'Three' }])
  // task_get's compact answer keeps the task's own fields.
  assert.equal(((await actions.task_get?.(ctx, { key })) as { summary: string }).summary, 'Three')
})

test('a bad detail is refused before the handler runs, so no write happens', async () => {
  let ran = false
  // Composed as the server entry composes them: the parameter check outside, detail inside.
  const actions = withParamChecks(
    withDetail({
      task_create: async () => {
        ran = true
        return { result: {} }
      },
    }),
  )
  await assert.rejects(
    async () => actions.task_create?.(ctx, { summary: 'x', detail: 'short' }),
    /^TaskError: "detail" must be one of "compact" or "full", not "short"\./,
  )
  assert.equal(ran, false)
})

test('my_work names its starting-soon tasks by key instead of repeating them', async () => {
  const task = {
    key: 'T-1',
    summary: 's',
    status: { name: 'To Do' },
    type: 'task',
    priority: 'low',
    assignee: null,
    parentKey: null,
    childCount: 0,
    labels: [],
    startDate: '2026-09-27',
    endDate: null,
    blockers: [],
    prs: { open: 0, merged: 0, closed: 0 },
  }
  const actions = withDetail({
    my_work: () => ({
      viewer: { kind: 'agent', id: 'agent_1', name: 'Ace' },
      today: '2026-09-26',
      waiting: [
        {
          id: 'r:s',
          state: 'open',
          task: { key: 'T-1', summary: 's' },
          workflow: 'Dev',
          step: 'Development',
          since: 'x',
          reason: null,
          sessionHref: null,
        },
      ],
      assigned: [task],
      startingSoon: [task],
      recent: [
        { id: 'n1', kind: 'assigned', createdAt: 'x', read: false, actor: null, task: { key: 'T-1', summary: 's' } },
        {
          id: 'n2',
          kind: 'status_changed',
          createdAt: 'y',
          read: true,
          task: { key: 'T-1', summary: 's' },
          from: { name: 'To Do', category: 'todo', color: null },
          to: { name: 'Done', category: 'done' },
        },
      ],
    }),
  })
  assert.deepEqual(await actions.my_work?.(ctx, {}), {
    viewer: { kind: 'agent', name: 'Ace' },
    today: '2026-09-26',
    waiting: [
      {
        id: 'r:s',
        state: 'open',
        task: { key: 'T-1', summary: 's' },
        workflow: 'Dev',
        step: 'Development',
        since: 'x',
      },
    ],
    assigned: [{ key: 'T-1', summary: 's', status: 'To Do', type: 'task', priority: 'low', startDate: '2026-09-27' }],
    assignedTotal: 1,
    startingSoon: ['T-1'],
    recent: [
      { id: 'n1', kind: 'assigned', createdAt: 'x', read: false, task: { key: 'T-1', summary: 's' } },
      {
        id: 'n2',
        kind: 'status_changed',
        createdAt: 'y',
        read: true,
        task: { key: 'T-1', summary: 's' },
        from: 'To Do',
        to: 'Done',
      },
    ],
  })
})

test('the inbox names statuses instead of describing them, and keeps its paging', async () => {
  const item = {
    id: 'n2',
    kind: 'status_changed',
    createdAt: 'y',
    read: false,
    actor: { kind: 'agent', name: 'Ace' },
    task: { key: 'T-1', summary: 's' },
    to: { name: 'QA', category: 'in_progress', color: null },
  }
  const actions = withDetail({ inbox_list: () => ({ items: [item], unread: 1, nextBefore: null }) })
  assert.deepEqual(await actions.inbox_list?.(ctx, {}), {
    items: [
      {
        id: 'n2',
        kind: 'status_changed',
        createdAt: 'y',
        read: false,
        actor: { kind: 'agent', name: 'Ace' },
        task: { key: 'T-1', summary: 's' },
        to: 'QA',
      },
    ],
    unread: 1,
    nextBefore: null,
  })
  assert.deepEqual(await actions.inbox_list?.(ctx, { detail: 'full' }), { items: [item], unread: 1, nextBefore: null })
})

test('the runs list keeps the match total in brief, and adds none when there was no match', async () => {
  const run = {
    taskKey: 'T-1',
    workflowName: 'Dev',
    state: 'finished',
    startedAt: 'x',
    endedAt: 'y',
    steps: [],
  } as unknown as WorkflowRun
  const matched = withDetail({ workflow_runs_list: () => ({ runs: [run], total: 205 }) })
  assert.deepEqual(await matched.workflow_runs_list?.(ctx, {}), {
    runs: [{ taskKey: 'T-1', workflow: 'Dev', state: 'finished', startedAt: 'x', endedAt: 'y' }],
    total: 205,
  })
  const plain = withDetail({ workflow_runs_list: () => ({ runs: [] }) })
  assert.deepEqual(await plain.workflow_runs_list?.(ctx, {}), { runs: [] })
})

test('exactly the actions with a compact shape declare detail in extension.json', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension.json', import.meta.url), 'utf8'))
  const declared: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node && typeof node === 'object') {
      const action = node as { id?: string; inputSchema?: { properties?: Record<string, unknown> } }
      if (action.id && action.inputSchema?.properties?.detail) {
        declared.push(action.id)
      }
      Object.values(node).forEach(walk)
    }
  }
  walk(manifest)
  assert.deepEqual(declared.sort(), [...DETAIL_ACTIONS].sort())
})

test('task_get holds the latest comments, related tasks as rows, and leaves out what is empty', async () => {
  const scope = makeScope()
  const key = (await createTask(scope, { summary: 'Talked about' })).result.key
  const blocker = (await createTask(scope, { summary: 'First' })).result.key
  linkTasks(scope, { from: blocker, to: key, type: 'blocks' })
  for (let n = 1; n <= 8; n++) {
    await addComment(scope, { key, body: `comment ${n}` })
  }
  const actions = withDetail({ task_get: (_ctx, params) => getTask(scope, params.key) })
  const compact = (await actions.task_get?.(ctx, { key })) as Record<string, unknown> & {
    comments: Array<{ body: string; mine?: true; updatedAt?: string }>
  }
  assert.deepEqual(
    compact.comments.map((comment) => comment.body),
    ['comment 4', 'comment 5', 'comment 6', 'comment 7', 'comment 8'],
  )
  assert.equal(compact.commentsTotal, 8)
  // Written by the caller and never edited.
  assert.equal(compact.comments[0]?.mine, true)
  assert.equal('updatedAt' in (compact.comments[0] ?? {}), false)
  assert.deepEqual(compact.blockedBy, [{ key: blocker, summary: 'First', status: 'To Do' }])
  for (const empty of [
    'blocks',
    'follows',
    'precedes',
    'duplicates',
    'duplicatedBy',
    'relatesTo',
    'subtasks',
    'ancestors',
    'labels',
    'parentKey',
    'pullRequests',
  ]) {
    assert.equal(empty in compact, false, empty)
  }
  const more = (await actions.task_get?.(ctx, { key, commentsLimit: 50 })) as { comments: unknown[] }
  assert.equal(more.comments.length, 8)
  // The page's shape: every comment, every relation list, in full.
  const full = (await actions.task_get?.(ctx, { key, detail: 'full' })) as {
    comments: unknown[]
    blocks: unknown[]
    blockedBy: Array<{ rank: string }>
  }
  assert.equal(full.comments.length, 8)
  assert.deepEqual(full.blocks, [])
  assert.equal(typeof full.blockedBy[0]?.rank, 'string')
  await assert.rejects(
    async () => actions.task_get?.(ctx, { key, commentsLimit: 51 }),
    /"commentsLimit" must be a whole number from 1 to 50/,
  )
  await assert.rejects(
    async () => actions.task_get?.(ctx, { key, commentsLimit: 0 }),
    /"commentsLimit" must be a whole number from 1 to 50/,
  )
})

test('task_comments pages through every comment newest first, with no gap or repeat, while comments come and go', async () => {
  const scope = makeScope()
  const key = (await createTask(scope, { summary: 'Long thread' })).result.key
  const ids: number[] = []
  for (let n = 1; n <= 23; n++) {
    ids.push((await addComment(scope, { key, body: `comment ${n}` })).result.id)
  }
  // Imported comments keep their own dates: two share a time, and one is older than those before it.
  scope.db
    .prepare('UPDATE comment SET created_at = ? WHERE id IN (?, ?)')
    .run('2026-01-01T00:00:00.000Z', ids[9] as number, ids[10] as number)
  scope.db.prepare('UPDATE comment SET created_at = ? WHERE id = ?').run('2025-12-31T00:00:00.000Z', ids[15] as number)
  const expected = (
    scope.db.prepare('SELECT id FROM comment ORDER BY created_at DESC, id DESC').all() as Array<{ id: number }>
  ).map((row) => row.id)

  const seen: number[] = []
  let before: string | undefined
  let pages = 0
  do {
    const page = listComments(scope, { key, limit: 5, ...(before ? { before } : {}) })
    assert.equal(page.total, 23)
    seen.push(...page.comments.map((comment) => comment.id))
    before = page.next
    pages++
  } while (before)
  assert.equal(pages, 5)
  assert.deepEqual(seen, expected)

  // A comment deleted between pages, and one added, move nothing on the pages still to read.
  const first = listComments(scope, { key, limit: 5 })
  await deleteComment(scope, { key, id: first.comments[4]?.id as number })
  await addComment(scope, { key, body: 'late' })
  const second = listComments(scope, { key, limit: 5, before: first.next })
  assert.deepEqual(
    second.comments.map((comment) => comment.id),
    expected.slice(5, 10),
  )
  assert.equal(listComments(scope, { key }).comments.length, 10)
  assert.throws(() => listComments(scope, { key, limit: 51 }), /"limit" must be a whole number from 1 to 50/)
  assert.throws(() => listComments(scope, { key, before: 'page-2' }), /"before" is not a cursor from task_comments/)
})

test('my_work caps assigned at the first rows, counts them all, and names starting-soon tasks past the cap', async () => {
  const row = (n: number, startDate: string | null = null) => ({
    key: `T-${n}`,
    summary: `task ${n}`,
    status: { name: 'To Do' },
    type: 'task',
    priority: 'medium',
    assignee: { kind: 'agent', name: 'Ace' },
    parentKey: null,
    childCount: 0,
    labels: [],
    startDate,
    endDate: null,
    blockers: [],
    prs: { open: 0, merged: 0, closed: 0 },
  })
  const assigned = Array.from({ length: 25 }, (_, n) => row(n + 1, n === 2 || n === 20 ? '2026-09-28' : null))
  const actions = withDetail({
    my_work: () => ({
      viewer: { kind: 'agent', name: 'Ace' },
      today: '2026-09-27',
      waiting: [],
      assigned,
      startingSoon: [assigned[2], assigned[20]],
      recent: [],
    }),
  })
  const compact = (await actions.my_work?.(ctx, {})) as {
    assigned: Array<{ key: string; assignee?: string }>
    assignedTotal: number
    startingSoon: string[]
    startingSoonNotShown?: string[]
  }
  assert.deepEqual(
    compact.assigned.map((task) => task.key),
    ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9', 'T-10'],
  )
  assert.equal(compact.assigned[0]?.assignee, undefined)
  assert.equal(compact.assignedTotal, 25)
  assert.deepEqual(compact.startingSoon, ['T-3', 'T-21'])
  assert.deepEqual(compact.startingSoonNotShown, ['T-21'])
  const raised = (await actions.my_work?.(ctx, { assignedLimit: 200 })) as {
    assigned: unknown[]
    startingSoonNotShown?: string[]
  }
  assert.equal(raised.assigned.length, 25)
  assert.equal('startingSoonNotShown' in raised, false)
  const full = (await actions.my_work?.(ctx, { detail: 'full' })) as { assigned: unknown[] }
  assert.equal(full.assigned.length, 25)
  await assert.rejects(
    async () => actions.my_work?.(ctx, { assignedLimit: 201 }),
    /"assignedLimit" must be a whole number from 1 to 200/,
  )
})
