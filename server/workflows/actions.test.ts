import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { AppActionContext } from '@opencroft/server/apps'

import type { Actor, Status, TaskSummary } from '../../shared/types.ts'
import type { OpenApproval, WorkflowDef } from '../../shared/workflows.ts'
import { allMigrations, migrate } from '../db.ts'
import { makeWorkflowActions, type PersonChatsPort, type WorkflowHost } from './actions.ts'
import { afterStatusChange, beforeStatusChange, type ChatsPort, type EngineEnv, type TaskPort } from './engine.ts'

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
const NOW = '2026-09-26T06:00:00.000Z'

/** `more` fills in the parts of the host a test needs beyond definitions and chats. */
function setup(
  person: PersonChatsPort | null = null,
  chats: ChatsPort | null = null,
  more: Partial<WorkflowHost> = {},
) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, allMigrations())
  const host = {
    open: () => ({ db, projectKey: 'TASK' }),
    chats: () => chats,
    personChats: () => person,
    people: async () => [
      { id: 'person-alice', name: 'Alice' },
      { id: 'person-bob', name: 'Bob' },
    ],
    changed: () => {},
    now: () => NOW,
    ...more,
  } as unknown as WorkflowHost
  const actions = makeWorkflowActions(host)
  const ctx = { spaceSlug: 'dev' } as AppActionContext
  const call = async (action: string, params: Record<string, unknown> = {}) =>
    (await actions[action](ctx, params)) as WorkflowDef
  return { call, db }
}

const standard = {
  name: 'Standard',
  steps: [
    {
      name: 'Development',
      triggerStatus: 'In Progress',
      worker: { kind: 'assignee' },
      instructions: 'Do {{ task.key }}',
      transitions: ['In Review'],
    },
    {
      name: 'Review',
      triggerStatus: 'in review',
      worker: { kind: 'assignee' },
      instructions: 'Review',
      transitions: ['Done', 'In Progress'],
    },
  ],
}

test('workflow_step_update changes only the fields passed, on only the step named, and keeps step ids', async () => {
  const { call } = setup()
  const saved = await call('workflow_save', { workflow: standard })
  assert.deepEqual(
    saved.steps.map((s) => [s.triggerStatus, s.transitions.map((t) => t.status)]),
    [
      [2, [3]],
      [3, [4, 2]],
    ],
    'status names were stored as ids',
  )
  const updated = await call('workflow_step_update', {
    workflow: 'standard',
    step: 'review',
    instructions: 'Review {{ steps.development.summary }}',
    transitions: ['Done'],
  })
  assert.deepEqual(
    updated.steps.map((s) => [s.id, s.name, s.instructions, s.transitions.map((t) => t.status)]),
    [
      [saved.steps[0].id, 'Development', 'Do {{ task.key }}', [3]],
      [saved.steps[1].id, 'Review', 'Review {{ steps.development.summary }}', [4]],
    ],
  )
})

test("a step's folder is saved, read back, kept by an update that leaves it out, and cleared with an empty one", async () => {
  const { call } = setup()
  const saved = await call('workflow_save', {
    workflow: { ...standard, steps: [standard.steps[0], { ...standard.steps[1], folder: 'Testing' }] },
  })
  assert.deepEqual(
    saved.steps.map((s) => s.folder),
    ['', 'Testing'],
  )
  assert.deepEqual(
    (await call('workflow_get', { workflow: 'Standard' })).steps.map((s) => s.folder),
    ['', 'Testing'],
  )
  const renamed = await call('workflow_step_update', { workflow: 'Standard', step: 'Review', name: 'Code review' })
  assert.equal(renamed.steps[1]?.folder, 'Testing')
  const filed = await call('workflow_step_update', { workflow: 'Standard', step: 'Development', folder: 'Development' })
  assert.deepEqual(
    filed.steps.map((s) => s.folder),
    ['Development', 'Testing'],
  )
  const cleared = await call('workflow_step_update', { workflow: 'Standard', step: 'Code review', folder: '' })
  assert.equal(cleared.steps[1]?.folder, '')
})

test('workflow_step_update refuses an unknown step or workflow by naming the ones that exist, and an empty change', async () => {
  const { call } = setup()
  await call('workflow_save', { workflow: standard })
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Standard', step: 'QA', name: 'x' }),
    /No step "QA" in workflow "Standard"\. Steps: Development, Review/,
  )
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Hotfix', step: 'Review', name: 'x' }),
    /No workflow "Hotfix" in this project\. Workflows: "Standard"/,
  )
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Standard', step: 'Review' }),
    /Nothing to change: pass at least one of name, triggerStatus, kind, worker, approval, instructions, transitions, folder, sessionOptions$/,
  )
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Standard', step: 'Review', transitions: ['Shipped'] }),
    /steps\.1\.transitions\.0\.status: No such status\. Statuses \(name or id\): To Do \(1\)/,
  )
})

const agents = [{ nodeId: 'agent_dev', name: 'Dev' }]

/**
 * The host as the test App (space `dev`) sees it: a person in the chats
 * `mine` names, and the task manager in the ones it was granted. Granting
 * adds the task manager, as the host's grantExtension does, and refuses a
 * chat the person is not in.
 */
function world(mine: string[], granted: string[] = []) {
  const chatOf = (slug: string) => ({ ref: `id-${slug}`, slug, name: slug.toUpperCase(), agents })
  const taskManager = new Set(granted)
  const grants: string[] = []
  const person: PersonChatsPort = {
    personChats: async () => mine.map((slug) => ({ ...chatOf(slug), extensionGranted: taskManager.has(slug) })),
    grantExtension: async (chat) => {
      grants.push(chat)
      if (!mine.includes(chat)) {
        throw new Error('Not available')
      }
      taskManager.add(chat)
    },
  }
  const chats = { list: async () => [...taskManager].map(chatOf) } as unknown as ChatsPort
  return { person, chats, grants }
}

type SpaceChat = {
  slug: string
  ref: string | null
  name: string | null
  taskManagerIn: boolean
  agents: unknown[]
  youAreIn: boolean | null
}

test("space_chat is the chat at the space's address; a person in it lets the task manager in", async () => {
  const { person, chats, grants } = world(['dev', 'ops'])
  const { call } = setup(person, chats)
  const before = (await call('space_chat')) as unknown as SpaceChat
  assert.deepEqual(before, { slug: 'dev', ref: 'id-dev', name: 'DEV', taskManagerIn: false, agents, youAreIn: true })

  const after = (await call('space_chat_grant')) as unknown as SpaceChat
  assert.deepEqual(grants, ['dev'], 'only the space chat is ever granted')
  assert.deepEqual([after.taskManagerIn, after.youAreIn], [true, true])
})

test("space_chat_grant refuses a person outside the space's chat, and never touches another chat", async () => {
  const { person, chats, grants } = world(['ops'])
  const { call } = setup(person, chats)
  const state = (await call('space_chat')) as unknown as SpaceChat
  assert.deepEqual([state.name, state.taskManagerIn, state.youAreIn], [null, false, false])
  await assert.rejects(
    call('space_chat_grant'),
    /You aren't in this space's chat \("dev"\), so you can't add the task manager to it/,
  )
  assert.deepEqual(grants, [])
})

test('a step names no chat: saving any agent works, and an old draft that passes one still saves', async () => {
  const { call } = setup()
  const saved = await call('workflow_save', {
    workflow: {
      ...standard,
      steps: standard.steps.map((s) => ({
        ...s,
        chat: 'old-project-chat',
        worker: { kind: 'agent', agentNodeId: 'agent_x' },
      })),
    },
  })
  assert.ok(saved.steps.every((s) => !('chat' in s)))
})

test('workflow_stats takes the workflow by name, defaults to 30 days, and names the ranges it accepts', async () => {
  const { call } = setup()
  await call('workflow_save', { workflow: standard })
  const stats = (await call('workflow_stats', { workflow: 'standard' })) as unknown as {
    range: string
    runs: { started: number }
    steps: Array<{ name: string }>
  }
  assert.deepEqual(
    [stats.range, stats.runs.started, stats.steps.map((s) => s.name)],
    ['30d', 0, ['Development', 'Review']],
  )
  await assert.rejects(call('workflow_stats', { workflow: 'standard', range: '1y' }), {
    name: 'TaskError',
    message:
      '"range" must be one of "7d", "30d", "90d" or "all", not "1y". Parameters of workflow_stats: workflow (required), range.',
  })
  await assert.rejects(call('workflow_stats', { workflow: 'nightly' }), /No workflow "nightly"/)
})

/**
 * One task, TASK-1 in In Review, and a workflow whose only step is a Sign-off
 * decided by Alice (required) and Bob, one approval needed. `caller` is who
 * calls: a signed-in person, or null for the agent named `agent` (Dev by
 * default). The host's agents are Dev and Lead. Status changes run the
 * engine's hooks as the task model does.
 */
function approvalWorld() {
  const world = {
    caller: null as { id: string; name: string } | null,
    agent: 'Dev',
    db: null as unknown as DatabaseSync,
  }
  const statuses = () =>
    world.db.prepare('SELECT id, name, category, color, position FROM status').all() as unknown as Status[]
  const getTask = (): TaskSummary => {
    const row = world.db.prepare('SELECT status_id FROM task WHERE number = 1').get() as { status_id: number }
    const status = statuses().find((s) => s.id === row.status_id)
    assert.ok(status)
    return {
      key: 'TASK-1',
      number: 1,
      summary: 'Fix login',
      status,
      type: 'task',
      priority: 'medium',
      assignee: null,
      reporter: { kind: 'person', name: 'Alice' },
      parentKey: null,
      childCount: 0,
      childDoneCount: 0,
      labels: [],
      version: null,
      milestone: null,
      startDate: null,
      endDate: null,
      rank: 'a',
      createdAt: NOW,
      updatedAt: NOW,
      blockers: [],
      prs: { open: 0, merged: 0, closed: 0 },
    }
  }
  const actor = (): Actor =>
    world.caller ? { kind: 'person', name: world.caller.name } : { kind: 'agent', name: world.agent }
  const env = (): EngineEnv => ({
    db: world.db,
    projectKey: 'TASK',
    app: 'dev.tasks',
    chats: null,
    spaceSlug: 'dev',
    now: () => NOW,
  })
  const tasks = (): TaskPort => ({
    async changeStatus({ status }) {
      const before = getTask()
      const to = statuses().find((s) => s.id === status)
      assert.ok(to)
      const change = { task: before, from: before.status, to, actor: actor() }
      beforeStatusChange(world.db, 'TASK', change)
      world.db.prepare('UPDATE task SET status_id = ? WHERE number = 1').run(status)
      await afterStatusChange(env(), { ...change, task: getTask() })
    },
  })
  const { call, db } = setup(null, null, {
    getTask,
    actor,
    person: () => world.caller,
    tasks,
    appAddress: async () => 'dev.tasks',
    agents: async () => [
      { id: 'agent_dev', name: 'Dev' },
      { id: 'agent_lead', name: 'Lead' },
    ],
  })
  world.db = db
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', '', 3, 'person', 'Alice', 'a', ?, ?)`,
  ).run(NOW, NOW)
  const as = (caller: { id: string; name: string } | null, agent = 'Dev') => {
    world.caller = caller
    world.agent = agent
    return call
  }
  return { as, getTask }
}

const ALICE = { id: 'person-alice', name: 'Alice' }
const BOB = { id: 'person-bob', name: 'Bob' }

test('workflow_step_decide records an approver’s decision; workflow_run_get shows where the approval stands and whether the caller decides', async () => {
  const { as, getTask } = approvalWorld()
  const saved = await as(ALICE)('workflow_save', {
    workflow: {
      name: 'Sign-off',
      steps: [
        {
          name: 'Sign-off',
          kind: 'approval',
          triggerStatus: 'In Review',
          approval: { approvers: [{ name: 'alice', required: true }, { personId: BOB.id }], needed: 1 },
          transitions: ['Done', { label: 'Rework', status: 'In Progress', gate: 'fail' }],
        },
      ],
    },
  })
  await as(ALICE)('workflow_start', { task: 'TASK-1' })
  await as(BOB)('workflow_step_decide', { task: 'TASK-1', verdict: 'approve', comment: 'Looks right' })

  type View = { openStep: { approval?: OpenApproval } | null }
  const view = async (caller: { id: string; name: string } | null) =>
    ((await as(caller)('workflow_run_get', { task: 'TASK-1' })) as unknown as View).openStep?.approval
  const approval = await view(BOB)
  const done = saved.steps[0]?.transitions.find((t) => t.label === 'Finish: Done')
  assert.deepEqual(approval, {
    needed: 1,
    approvers: [
      { personId: ALICE.id, name: 'Alice', required: true, decision: null },
      {
        personId: BOB.id,
        name: 'Bob',
        required: false,
        decision: {
          approver: { personId: BOB.id, name: 'Bob' },
          agent: null,
          verdict: 'approve',
          transitionId: done?.id,
          transition: 'Finish: Done',
          comment: 'Looks right',
          at: NOW,
        },
      },
    ],
    transitions: { approve: ['Finish: Done'], reject: ['Rework'] },
    rejectingAgents: [],
    canDecide: true,
    viewerId: BOB.id,
  })
  assert.equal((await view(null))?.canDecide, false, 'an agent does not decide')
  assert.equal(
    (await view({ id: 'person-carol', name: 'Carol' }))?.canDecide,
    false,
    'nor does a person who is not an approver',
  )
  assert.equal(getTask().status.name, 'In Review', 'the required approver has not approved')

  await assert.rejects(as(ALICE)('workflow_step_decide', { task: 'TASK-1', verdict: 'maybe' }), {
    name: 'TaskError',
    message:
      '"verdict" must be one of "approve" or "reject", not "maybe". ' +
      'Parameters of workflow_step_decide: detail, task (required), verdict (required), transition, comment, approver.',
  })
  await assert.rejects(
    as(null)('workflow_step_decide', { task: 'TASK-1', verdict: 'approve' }),
    /Dev may not decide "Sign-off": its approvers decide it, and it lets no agent reject for them/,
  )
  await as(ALICE)('workflow_step_decide', { task: 'TASK-1', verdict: 'reject' })
  assert.equal(getTask().status.name, 'In Progress')
  assert.equal(await view(ALICE), undefined, 'the run ended with the step')
})

test('an agent the step lists, found by the name the host bound to the call, rejects for an approver; workflow_run_get names it', async () => {
  const { as, getTask } = approvalWorld()
  await as(ALICE)('workflow_save', {
    workflow: {
      name: 'Sign-off',
      steps: [
        {
          name: 'Sign-off',
          kind: 'approval',
          triggerStatus: 'In Review',
          approval: { approvers: [{ name: 'alice', required: true }], rejectingAgents: [{ name: 'lead' }] },
          transitions: ['Done', { label: 'Rework', status: 'In Progress', gate: 'fail' }],
        },
      ],
    },
  })
  await as(ALICE)('workflow_start', { task: 'TASK-1' })
  type View = { openStep: { approval?: OpenApproval } | null }
  const view = (await as(null, 'Lead')('workflow_run_get', { task: 'TASK-1' })) as unknown as View
  assert.deepEqual(view.openStep?.approval?.rejectingAgents, [{ agentNodeId: 'agent_lead', name: 'Lead' }])
  await assert.rejects(
    as(null, 'Lead')('workflow_step_decide', { task: 'TASK-1', verdict: 'approve', approver: 'Alice', comment: 'ok' }),
    /Only people approve "Sign-off"/,
  )
  await assert.rejects(
    as(null, 'Dev')('workflow_step_decide', { task: 'TASK-1', verdict: 'reject', approver: 'Alice', comment: 'no' }),
    /Dev may not decide "Sign-off": its approvers decide it, and only Lead may reject it for them/,
  )
  assert.equal(getTask().status.name, 'In Review')
  await as(null, 'Lead')('workflow_step_decide', {
    task: 'TASK-1',
    verdict: 'reject',
    approver: 'Alice',
    comment: 'Alice: "not yet"',
  })
  assert.equal(getTask().status.name, 'In Progress')
})

test("an approval step's agents that may reject are checked against the host's agents", async () => {
  const { call } = setup(null, null, { agents: async () => [{ id: 'agent_lead', name: 'Lead' }] })
  await assert.rejects(
    call('workflow_save', {
      workflow: {
        name: 'Sign-off',
        steps: [
          {
            name: 'Sign-off',
            kind: 'approval',
            triggerStatus: 'In Review',
            approval: { approvers: [{ name: 'Alice' }], rejectingAgents: [{ name: 'Bob' }] },
            transitions: ['Done', 'To Do'],
          },
        ],
      },
    }),
    /steps\.0\.approval\.rejectingAgents\.0: "Bob" is not an agent of this instance/,
  )
})

test("an approval step's approvers are checked against the host's people", async () => {
  const { call } = setup()
  await assert.rejects(
    call('workflow_save', {
      workflow: {
        name: 'Sign-off',
        steps: [
          {
            name: 'Sign-off',
            kind: 'approval',
            triggerStatus: 'In Review',
            approval: { approvers: [{ name: 'Dev' }] },
            transitions: ['Done', 'To Do'],
          },
        ],
      },
    }),
    /steps\.0\.approval\.approvers\.0: "Dev" is not a person in the directory: only people can approve/,
  )
})

test('an agent sees the space chat as the task manager does, and cannot let it in', async () => {
  const { chats } = world([], ['dev', 'ops'])
  const { call } = setup(null, chats)
  const state = (await call('space_chat')) as unknown as SpaceChat
  assert.deepEqual(state, { slug: 'dev', ref: 'id-dev', name: 'DEV', taskManagerIn: true, agents, youAreIn: null })
  await assert.rejects(call('space_chat_grant'), /Only a person can let the task manager into this space's chat/)
})

test('runs matched past the list limit keep their total, so a caller can say it shows fewer', async () => {
  const { call, db } = setup()
  const saved = await call('workflow_save', { workflow: standard })
  const dev = saved.steps[0].id
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', '', 4, 'person', 'Alice', 'a', ?, ?)`,
  ).run(NOW, NOW)
  const addRun = db.prepare(
    `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at, ended_at)
     VALUES (?, 1, ?, 'Standard', 'finished', 'person', 'Alice', ?, ?)`,
  )
  const addRound = db.prepare(
    `INSERT INTO workflow_run_round (run_id, step_id, round_no, started_at, ended_at, ended_by, outcome, transition_label, gate)
     VALUES (?, ?, 1, ?, ?, 'transition', 'In Review', 'Ready', 'pass')`,
  )
  for (let i = 0; i < 205; i++) {
    const at = new Date(Date.parse(NOW) - (i + 1) * 60_000).toISOString()
    addRun.run(`run-${i}`, saved.id, at, NOW)
    addRound.run(`run-${i}`, dev, at, NOW)
  }
  const listed = (await call('workflow_runs_list', {
    workflow: 'Standard',
    match: { step: 'Development', range: 'all', exit: 'moved_on' },
  })) as unknown as {
    runs: unknown[]
    total: number
  }
  assert.deepEqual([listed.runs.length, listed.total], [200, 205])
  await assert.rejects(
    call('workflow_runs_list', { workflow: 'Standard', match: { step: 'Deploy' } }),
    /"Standard" has no step "Deploy"/,
  )
  await assert.rejects(call('workflow_runs_list', { match: { step: 'Development' } }), /"match" needs "workflow"/)
})

// ── A step's thread ─────────────────────────────────────────────────────────

/**
 * The space's chat (`dev`) with Dev and Rev, and threads the host knows by
 * ref: Rev's live and archived ones, Dev's, and Rev's in another chat.
 * `activity` pages one thread at a time and, like the host, lists only live
 * threads. `lookups` records each thread the host was asked about.
 */
function threadWorld() {
  const members = [
    { nodeId: 'agent_dev', name: 'Dev' },
    { nodeId: 'agent_rev', name: 'Rev' },
  ]
  const threads = [
    { ref: 'dev.rev.coordination', agent: 'agent_rev', chat: 'dev', archived: false, title: 'Coordination' },
    { ref: 'dev.rev.old', agent: 'agent_rev', chat: 'dev', archived: true, title: 'Old' },
    { ref: 'dev.dev.notes', agent: 'agent_dev', chat: 'dev', archived: false, title: 'Notes' },
    { ref: 'dev.rev.later', agent: 'agent_rev', chat: 'dev', archived: false, title: null },
    { ref: 'ops.rev.elsewhere', agent: 'agent_rev', chat: 'ops', archived: false, title: 'Elsewhere' },
  ]
  const lookups: string[] = []
  const describe = (t: (typeof threads)[number]) => ({
    ref: t.ref,
    threadId: `id-${t.ref}`,
    title: t.title,
    archived: t.archived,
    folder: null,
    agent: { nodeId: t.agent },
    chat: { ref: `id-${t.chat}`, slug: t.chat },
  })
  const chats = {
    list: async () => [{ ref: 'id-dev', slug: 'dev', name: 'DEV', agents: members }],
    thread: async (ref: string) => {
      lookups.push(ref)
      const found = threads.find((t) => t.ref === ref)
      if (!found) {
        throw new Error('Not available')
      }
      return describe(found)
    },
    activity: async (options: { chat?: string; cursor?: string }) => {
      const live = threads.filter((t) => t.chat === options.chat && !t.archived)
      const at = Number(options.cursor ?? 0)
      return { threads: live.slice(at, at + 1).map(describe), nextCursor: at + 1 < live.length ? String(at + 1) : null }
    },
  } as unknown as ChatsPort
  return { chats, threads, lookups }
}

const withThread = (thread: string, agentNodeId = 'agent_rev') => ({
  ...standard,
  steps: [standard.steps[0], { ...standard.steps[1], worker: { kind: 'agent', agentNodeId, thread } }],
})

test("a step's thread is saved and read back; a worker passed without one clears it", async () => {
  const { chats } = threadWorld()
  const { call } = setup(null, chats)
  const saved = await call('workflow_save', { workflow: withThread(' dev.rev.coordination ') })
  assert.deepEqual(saved.steps[1]?.worker, { kind: 'agent', agentNodeId: 'agent_rev', thread: 'dev.rev.coordination' })
  assert.deepEqual((await call('workflow_get', { workflow: 'Standard' })).steps[1]?.worker, saved.steps[1]?.worker)
  const cleared = await call('workflow_step_update', {
    workflow: 'Standard',
    step: 'Review',
    worker: { kind: 'agent', agentNodeId: 'agent_rev' },
  })
  assert.deepEqual(cleared.steps[1]?.worker, { kind: 'agent', agentNodeId: 'agent_rev' })
})

test('a thread that is gone, archived, in another chat or not the agent’s is refused, on the step’s thread field', async () => {
  const { chats } = threadWorld()
  const { call } = setup(null, chats)
  const issues = async (thread: string, agentNodeId?: string) =>
    (
      (await call('workflow_validate', { workflow: withThread(thread, agentNodeId) })) as unknown as {
        issues: Array<{ path: string; message: string }>
      }
    ).issues
  assert.deepEqual(await issues('dev.rev.coordination'), [])
  assert.deepEqual(await issues('dev.rev.nothing'), [
    {
      path: 'steps.1.worker.thread',
      message: `The thread "dev.rev.nothing" is gone, or the task manager can't reach it`,
    },
  ])
  assert.deepEqual(
    [
      ...(await issues('dev.rev.old')),
      ...(await issues('ops.rev.elsewhere')),
      ...(await issues('dev.rev.coordination', 'agent_dev')),
    ].map((i) => i.message),
    [
      'The thread "dev.rev.old" is archived',
      `The thread "ops.rev.elsewhere" isn't in this space's chat`,
      `The thread "dev.rev.coordination" is another agent's thread`,
    ],
  )
  await assert.rejects(
    call('workflow_save', { workflow: withThread('dev.rev.old') }),
    /The workflow was not saved:\n- steps\.1\.worker\.thread: The thread "dev\.rev\.old" is archived/,
  )
})

test("editing another step doesn't look a step's saved thread up again, so one archived since still saves", async () => {
  const { chats, threads, lookups } = threadWorld()
  const { call } = setup(null, chats)
  await call('workflow_save', { workflow: withThread('dev.rev.coordination') })
  assert.deepEqual(lookups, ['dev.rev.coordination'])
  const coordination = threads.find((t) => t.ref === 'dev.rev.coordination')
  assert.ok(coordination)
  coordination.archived = true
  const renamed = await call('workflow_step_update', { workflow: 'Standard', step: 'Development', name: 'Build' })
  assert.equal(renamed.steps[1]?.worker.kind === 'agent' && renamed.steps[1].worker.thread, 'dev.rev.coordination')
  assert.deepEqual(lookups, ['dev.rev.coordination'], 'not looked up again')
  await assert.rejects(
    call('workflow_step_update', {
      workflow: 'Standard',
      step: 'Review',
      worker: { kind: 'agent', agentNodeId: 'agent_dev', thread: 'dev.rev.coordination' },
    }),
    /steps\.1\.worker\.thread: The thread "dev\.rev\.coordination" is another agent's thread/,
    'a changed agent looks it up again',
  )
})

test('a step with both a thread and session options is refused, naming both, by validate, save and step_update either way', async () => {
  const { chats } = threadWorld()
  const { call } = setup(null, chats)
  const refused =
    /steps\.1\.worker\.thread: A step with a worker\.thread has no sessionOptions \(it sets effort\): clear one or the other/
  const given = withThread('dev.rev.coordination')
  const both = {
    ...given,
    steps: [given.steps[0], { ...given.steps[1], sessionOptions: { effort: 'high', compactAbove: 0 } }],
  }
  assert.deepEqual(((await call('workflow_validate', { workflow: both })) as unknown as { issues: unknown[] }).issues, [
    {
      path: 'steps.1.worker.thread',
      message:
        'A step with a worker.thread has no sessionOptions (it sets effort, compactAbove): clear one or the other',
    },
  ])
  await assert.rejects(
    call('workflow_save', { workflow: both }),
    /The workflow was not saved:\n- steps\.1\.worker\.thread: /,
  )

  await call('workflow_save', { workflow: given })
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Standard', step: 'Review', sessionOptions: { effort: 'high' } }),
    refused,
    'options added to a step with a thread',
  )

  await call('workflow_step_update', {
    workflow: 'Standard',
    step: 'Review',
    worker: { kind: 'agent', agentNodeId: 'agent_rev' },
    sessionOptions: { effort: 'high' },
  })
  const thread = { kind: 'agent', agentNodeId: 'agent_rev', thread: 'dev.rev.coordination' }
  await assert.rejects(
    call('workflow_step_update', { workflow: 'Standard', step: 'Review', worker: thread }),
    refused,
    'a thread added to a step with options',
  )
  const moved = await call('workflow_step_update', {
    workflow: 'Standard',
    step: 'Review',
    worker: thread,
    sessionOptions: {},
  })
  assert.deepEqual([moved.steps[1]?.worker, moved.steps[1]?.sessionOptions], [thread, {}])
})

test("space_chat_threads lists one agent's live threads in the space's chat, by node id or name, across pages", async () => {
  const { chats } = threadWorld()
  const { call } = setup(null, chats)
  const listed = (await call('space_chat_threads', { agent: 'rev' })) as unknown as {
    agent: { nodeId: string; name: string }
    threads: Array<{ ref: string; title: string | null }>
    cut?: true
  }
  assert.deepEqual(listed.agent, { nodeId: 'agent_rev', name: 'Rev' })
  assert.deepEqual(
    listed.threads.map((t) => [t.ref, t.title]),
    [
      ['dev.rev.coordination', 'Coordination'],
      ['dev.rev.later', null],
    ],
  )
  assert.equal(listed.cut, undefined)
  assert.deepEqual(
    (
      (await call('space_chat_threads', { agent: 'agent_dev' })) as unknown as { threads: Array<{ ref: string }> }
    ).threads.map((t) => t.ref),
    ['dev.dev.notes'],
  )
  await assert.rejects(
    call('space_chat_threads', { agent: 'Far' }),
    /No agent "Far" in this space's chat\. Its agents: Dev, Rev/,
  )
})
