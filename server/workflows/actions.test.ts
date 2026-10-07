import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { AppActionContext } from '@opencroft/server'

import type { Actor, Status, TaskSummary } from '../../shared/types.ts'
import type { OpenApproval, WorkflowDef } from '../../shared/workflows.ts'
import { allMigrations, migrate } from '../db.ts'
import { makeWorkflowActions, type PersonChatsPort, type WorkflowHost } from './actions.ts'
import { afterStatusChange, beforeStatusChange, type ChatsPort, type EngineEnv, type TaskPort } from './engine.ts'

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
const NOW = '2026-09-26T06:00:00.000Z'

/** `more` fills in the parts of the host a test needs beyond definitions and chats. */
function setup(person: PersonChatsPort | null = null, chats: ChatsPort | null = null, more: Partial<WorkflowHost> = {}) {
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
  const call = async (action: string, params: Record<string, unknown> = {}) => (await actions[action]!(ctx, params)) as WorkflowDef
  return { call, db }
}

const standard = {
  name: 'Standard',
  steps: [
    { name: 'Development', triggerStatus: 'In Progress', worker: { kind: 'assignee' }, instructions: 'Do {{ task.key }}', transitions: ['In Review'] },
    { name: 'Review', triggerStatus: 'in review', worker: { kind: 'assignee' }, instructions: 'Review', transitions: ['Done', 'In Progress'] },
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
  const updated = await call('workflow_step_update', { workflow: 'standard', step: 'review', instructions: 'Review {{ steps.development.summary }}', transitions: ['Done'] })
  assert.deepEqual(
    updated.steps.map((s) => [s.id, s.name, s.instructions, s.transitions.map((t) => t.status)]),
    [
      [saved.steps[0]!.id, 'Development', 'Do {{ task.key }}', [3]],
      [saved.steps[1]!.id, 'Review', 'Review {{ steps.development.summary }}', [4]],
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
  await assert.rejects(call('workflow_step_update', { workflow: 'Standard', step: 'QA', name: 'x' }), /No step "QA" in workflow "Standard"\. Steps: Development, Review/)
  await assert.rejects(call('workflow_step_update', { workflow: 'Hotfix', step: 'Review', name: 'x' }), /No workflow "Hotfix" in this project\. Workflows: "Standard"/)
  await assert.rejects(call('workflow_step_update', { workflow: 'Standard', step: 'Review' }), /Nothing to change: pass at least one of name, triggerStatus, kind, worker, approval, instructions, transitions, folder, sessionOptions$/)
  await assert.rejects(call('workflow_step_update', { workflow: 'Standard', step: 'Review', transitions: ['Shipped'] }), /steps\.1\.transitions\.0\.status: No such status\. Statuses \(name or id\): To Do \(1\)/)
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

type SpaceChat = { slug: string; ref: string | null; name: string | null; taskManagerIn: boolean; agents: unknown[]; youAreIn: boolean | null }

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
  await assert.rejects(call('space_chat_grant'), /You aren't in this space's chat \("dev"\), so you can't add the task manager to it/)
  assert.deepEqual(grants, [])
})

test('a step names no chat: saving any agent works, and an old draft that passes one still saves', async () => {
  const { call } = setup()
  const saved = await call('workflow_save', {
    workflow: { ...standard, steps: standard.steps.map((s) => ({ ...s, chat: 'old-project-chat', worker: { kind: 'agent', agentNodeId: 'agent_x' } })) },
  })
  assert.ok(saved.steps.every((s) => !('chat' in s)))
})

test('workflow_stats takes the workflow by name, defaults to 30 days, and names the ranges it accepts', async () => {
  const { call } = setup()
  await call('workflow_save', { workflow: standard })
  const stats = (await call('workflow_stats', { workflow: 'standard' })) as unknown as { range: string; runs: { started: number }; steps: Array<{ name: string }> }
  assert.deepEqual([stats.range, stats.runs.started, stats.steps.map((s) => s.name)], ['30d', 0, ['Development', 'Review']])
  await assert.rejects(call('workflow_stats', { workflow: 'standard', range: '1y' }), /"range" must be one of: 7d, 30d, 90d, all/)
  await assert.rejects(call('workflow_stats', { workflow: 'nightly' }), /No workflow "nightly"/)
})

/**
 * One task, TASK-1 in In Review, and a workflow whose only step is a Sign-off
 * decided by Alice (required) and Bob, one approval needed. `caller` is who
 * calls: a signed-in person, or null for an agent. Status changes run the
 * engine's hooks as the task model does.
 */
function approvalWorld() {
  const world = { caller: null as { id: string; name: string } | null, db: null as unknown as DatabaseSync }
  const statuses = () => world.db.prepare('SELECT id, name, category, color, position FROM status').all() as unknown as Status[]
  const getTask = (): TaskSummary => {
    const row = world.db.prepare('SELECT status_id FROM task WHERE number = 1').get() as { status_id: number }
    return {
      key: 'TASK-1',
      number: 1,
      summary: 'Fix login',
      status: statuses().find((s) => s.id === row.status_id)!,
      type: 'task',
      priority: 'medium',
      assignee: null,
      reporter: { kind: 'person', name: 'Alice' },
      parentKey: null,
      childCount: 0,
      childDoneCount: 0,
      labels: [],
      version: null,
      startDate: null,
      endDate: null,
      rank: 'a',
      createdAt: NOW,
      updatedAt: NOW,
      blockers: [],
      prs: { open: 0, merged: 0, closed: 0 },
    }
  }
  const actor = (): Actor => (world.caller ? { kind: 'person', name: world.caller.name } : { kind: 'agent', name: 'Dev' })
  const env = (): EngineEnv => ({ db: world.db, projectKey: 'TASK', app: 'dev.tasks', chats: null, spaceSlug: 'dev', now: () => NOW })
  const tasks = (): TaskPort => ({
    async changeStatus({ status }) {
      const before = getTask()
      const change = { task: before, from: before.status, to: statuses().find((s) => s.id === status)!, actor: actor() }
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
  })
  world.db = db
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', '', 3, 'person', 'Alice', 'a', ?, ?)`,
  ).run(NOW, NOW)
  const as = (caller: { id: string; name: string } | null) => {
    world.caller = caller
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
          verdict: 'approve',
          transitionId: done?.id,
          transition: 'Finish: Done',
          comment: 'Looks right',
          at: NOW,
        },
      },
    ],
    transitions: { approve: ['Finish: Done'], reject: ['Rework'] },
    canDecide: true,
    viewerId: BOB.id,
  })
  assert.equal((await view(null))?.canDecide, false, 'an agent does not decide')
  assert.equal((await view({ id: 'person-carol', name: 'Carol' }))?.canDecide, false, 'nor does a person who is not an approver')
  assert.equal(getTask().status.name, 'In Review', 'the required approver has not approved')

  await assert.rejects(as(ALICE)('workflow_step_decide', { task: 'TASK-1', verdict: 'maybe' }), /"verdict" must be one of: approve, reject/)
  await assert.rejects(as(null)('workflow_step_decide', { task: 'TASK-1', verdict: 'approve' }), /Only a person can approve or reject/)
  await as(ALICE)('workflow_step_decide', { task: 'TASK-1', verdict: 'reject' })
  assert.equal(getTask().status.name, 'In Progress')
  assert.equal(await view(ALICE), undefined, 'the run ended with the step')
})

test("an approval step's approvers are checked against the host's people", async () => {
  const { call } = setup()
  await assert.rejects(
    call('workflow_save', {
      workflow: {
        name: 'Sign-off',
        steps: [{ name: 'Sign-off', kind: 'approval', triggerStatus: 'In Review', approval: { approvers: [{ name: 'Dev' }] }, transitions: ['Done', 'To Do'] }],
      },
    }),
    /steps\.0\.approval\.approvers\.0: "Dev" is not a person in the directory: only people can approve/,
  )
})

test("an agent sees the space chat as the task manager does, and cannot let it in", async () => {
  const { chats } = world([], ['dev', 'ops'])
  const { call } = setup(null, chats)
  const state = (await call('space_chat')) as unknown as SpaceChat
  assert.deepEqual(state, { slug: 'dev', ref: 'id-dev', name: 'DEV', taskManagerIn: true, agents, youAreIn: null })
  await assert.rejects(call('space_chat_grant'), /Only a person can let the task manager into this space's chat/)
})

test('runs matched past the list limit keep their total, so a caller can say it shows fewer', async () => {
  const { call, db } = setup()
  const saved = await call('workflow_save', { workflow: standard })
  const dev = saved.steps[0]!.id
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
  const listed = (await call('workflow_runs_list', { workflow: 'Standard', match: { step: 'Development', range: 'all', exit: 'moved_on' } })) as unknown as {
    runs: unknown[]
    total: number
  }
  assert.deepEqual([listed.runs.length, listed.total], [200, 205])
  await assert.rejects(call('workflow_runs_list', { workflow: 'Standard', match: { step: 'Deploy' } }), /"Standard" has no step "Deploy"/)
  await assert.rejects(call('workflow_runs_list', { match: { step: 'Development' } }), /"match" needs "workflow"/)
})
