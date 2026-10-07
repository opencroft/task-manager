import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { Actor, Status, TaskSummary } from '../../shared/types.ts'
import type { StepSessionOptions, WorkflowStepDraft } from '../../shared/workflows.ts'
import { allMigrations, migrate } from '../db.ts'
import type { NotificationDraft } from '../inbox/store.ts'
import { oneThreadAtATime } from '../task-threads.ts'
import type { CompactResult } from './compaction.ts'
import { normalizeDraft } from './definition.ts'
import {
  afterStatusChange,
  beforeStatusChange,
  cancelRun,
  type ChatsPort,
  decideStep,
  type EngineEnv,
  finishStep,
  recoverInterruptedCompactions,
  restartStep,
  startWorkflow,
  type TaskPort,
} from './engine.ts'
import { openingMessage } from './messages.ts'
import { activeRunForTask, getRun, mintId, runsForTask, saveWorkflow } from './store.ts'
import { settlePendingUsage, type ThreadUsage, withLiveUsage } from './usage.ts'

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
const PERSON: Actor = { kind: 'person', name: 'user' }
const DEV: Actor = { kind: 'agent', name: 'Dev' }
const REV: Actor = { kind: 'agent', name: 'Rev' }
/** Rev as the task's assignee: Rev then works Development as well as Review. */
const REV_ASSIGNED = { kind: 'agent', id: 'agent_rev', name: 'Rev' } as const

const at = (hhmm: string) => `2026-09-26T${hhmm}:00.000Z`
/** A turn of a thread's session as the host's usage records it. */
const turn = (hhmm: string, total: number): ThreadUsage['turns'][number] => ({
  endedAt: at(hhmm),
  tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  cost: { amount: total / 1000, currency: 'USD' },
})

interface Sent {
  kind: 'start' | 'send' | 'compact'
  target: string
  agentNodeId?: string
  title?: string
  folder?: string
  queue?: 'wait' | 'push'
  message: string
  sessionOptions?: StepSessionOptions
}

/** The host's answer to session options: each given one applied, except those its agent does not offer. */
function outcomeOf(options: StepSessionOptions | undefined, unoffered: ReadonlyArray<keyof StepSessionOptions>) {
  if (!options) {
    return undefined
  }
  const given = Object.keys(options) as Array<keyof StepSessionOptions>
  return {
    applied: given.filter((option) => !unoffered.includes(option)),
    skipped: given.filter((option) => unoffered.includes(option)).map((option) => ({ option, reason: 'not offered' })),
  }
}

/**
 * The host's group chats as the task manager sees them: the space's chat
 * (`dev`, the test App's space) with two agents. `outsider` leaves the task
 * manager out of it; `refuse` makes the host refuse a thread anyway. `titles`
 * holds each agent's thread titles, as `<chat> <agent> <title>`: the host
 * refuses a second thread of one name for an agent in a chat, as the real one does.
 * `unoffered` names the session options its agents do not offer. A
 * compaction is listed in `sent` as it starts and ends as `compact` says;
 * by default it shrinks the thread's context to 20k.
 */
function fakeChats(
  opts: {
    refuse?: boolean
    outsider?: boolean
    unoffered?: Array<keyof StepSessionOptions>
    compact?: (thread: string) => Promise<CompactResult>
  } = {},
): ChatsPort & {
  sent: Sent[]
  threads: Map<string, ThreadUsage>
  archived: Set<string>
  archiveCalls: string[]
  titles: Set<string>
} {
  const sent: Sent[] = []
  const titles = new Set<string>()
  // What each thread has spent, as the host's turn records would say.
  const threads = new Map<string, ThreadUsage>()
  // Archived threads refuse a send, as the host's do.
  const archived = new Set<string>()
  const archiveCalls: string[] = []
  let n = 0
  return {
    sent,
    threads,
    archived,
    archiveCalls,
    titles,
    archive: async (ref) => {
      archiveCalls.push(`archive ${ref}`)
      archived.add(ref)
    },
    unarchive: async (ref) => {
      archiveCalls.push(`unarchive ${ref}`)
      archived.delete(ref)
    },
    usage: async (thread, options) => {
      const usage = threads.get(thread) ?? { turns: [], busy: false }
      const since = options?.since ?? ''
      return { ...usage, turns: usage.turns.filter((t) => t.endedAt >= since) }
    },
    compact: async (thread) => {
      sent.push({ kind: 'compact', target: thread, message: '' })
      if (opts.compact) {
        return opts.compact(thread)
      }
      const usage = threads.get(thread) ?? { turns: [], busy: false }
      threads.set(thread, { ...usage, context: { usedTokens: 20_000, contextLimit: 1_000_000 } })
      return { outcome: 'compacted', contextBefore: usage.context?.usedTokens ?? null, contextAfter: 20_000 }
    },
    list: async () => [
      { ref: 'chat-other', slug: 'elsewhere', name: 'Elsewhere', agents: [{ nodeId: 'agent_far', name: 'Far' }] },
      ...(opts.outsider
        ? []
        : [
            {
              ref: 'chat-1',
              slug: 'dev',
              name: 'Dev',
              agents: [
                { nodeId: 'agent_dev', name: 'Dev' },
                { nodeId: 'agent_rev', name: 'Rev' },
                { nodeId: 'agent_des', name: 'Des' },
              ],
            },
          ]),
    ],
    startThread: async (input) => {
      if (opts.refuse) {
        throw new Error('Not available')
      }
      const named = `${input.chat} ${input.agentNodeId} ${input.title}`
      if (titles.has(named)) {
        throw Object.assign(new Error(`This agent already has a thread named "${input.title}" here`), { code: 'slug-taken' })
      }
      titles.add(named)
      n += 1
      sent.push({
        kind: 'start',
        target: input.chat,
        agentNodeId: input.agentNodeId,
        title: input.title,
        folder: input.folder,
        message: input.message,
        sessionOptions: input.sessionOptions,
      })
      const sessionOptions = outcomeOf(input.sessionOptions, opts.unoffered ?? [])
      return {
        thread: { ref: `dev.agent.t${n}`, threadId: `thread-${n}`, chat: { ref: 'chat-1', slug: 'dev' } },
        ...(sessionOptions ? { sessionOptions } : {}),
      }
    },
    send: async (input) => {
      if (archived.has(input.thread)) {
        throw new Error('This thread is archived; unarchive it to write')
      }
      sent.push({
        kind: 'send',
        target: input.thread,
        queue: input.queue,
        message: input.message,
        sessionOptions: input.sessionOptions,
      })
      const sessionOptions = outcomeOf(input.sessionOptions, opts.unoffered ?? [])
      return sessionOptions ? { sessionOptions } : {}
    },
  }
}

function setup(
  opts: {
    refuse?: boolean
    outsider?: boolean
    assignee?: TaskSummary['assignee']
    /** Development's session options. */
    devOptions?: StepSessionOptions
    unoffered?: Array<keyof StepSessionOptions>
    /** The workflow's steps in place of Development and Review. */
    steps?: WorkflowStepDraft[]
    compact?: (thread: string) => Promise<CompactResult>
  } = {},
) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, allMigrations())
  const now = '2026-09-26T06:00:00.000Z'
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', 'It returns 500', 1, 'person', 'user', 'a', ?, ?)`,
  ).run(now, now)
  const all = db.prepare('SELECT id, name, category, color, position FROM status').all() as unknown as Status[]
  const wf = saveWorkflow(
    db,
    normalizeDraft(
      {
        name: 'Standard',
        steps: opts.steps ?? [
          {
            name: 'Development',
            triggerStatus: 2,
            worker: { kind: 'assignee' },
            instructions: 'Implement {{ task.key }}: {{ task.description }}',
            transitions: [3],
            sessionOptions: opts.devOptions,
          },
          {
            name: 'Review',
            triggerStatus: 3,
            worker: { kind: 'agent', agentNodeId: 'agent_rev' },
            instructions: 'Review what Development did: {{ steps.development.summary }}',
            transitions: [4, 2],
            folder: ' Review queue ',
          },
        ],
      },
      mintId,
      all,
    ),
    now,
  )
  const chats = fakeChats(opts)
  const env: EngineEnv = { db, projectKey: 'TASK', app: 'dev.tasks', chats, spaceSlug: 'dev', now: () => now }
  const status = (id: number) => all.find((s) => s.id === id)!
  const assignee = opts.assignee === undefined ? ({ kind: 'agent', id: 'agent_dev', name: 'Dev' } as const) : opts.assignee
  const task = (): TaskSummary => {
    const row = db.prepare('SELECT status_id FROM task WHERE number = 1').get() as { status_id: number }
    return {
      key: 'TASK-1',
      number: 1,
      summary: 'Fix login',
      status: status(row.status_id),
      type: 'task',
      priority: 'medium',
      assignee,
      reporter: { kind: 'person', name: 'alice' },
      parentKey: null,
      childCount: 0,
      childDoneCount: 0,
      labels: [],
      version: null,
      startDate: null,
      endDate: null,
      rank: 'a',
      createdAt: now,
      updatedAt: now,
      blockers: [],
      prs: { open: 0, merged: 0, closed: 0 },
    }
  }
  const warnings: string[] = []
  // What the task model's changeStatus does, in the order it does it: `before`
  // inside the write, then commit, then `after` with its failure as a warning.
  // A status the task already has changes nothing and runs no hook.
  const changeAs = (actor: Actor): TaskPort => ({
    async changeStatus({ status: to }) {
      const before = task()
      if (before.status.id === to) {
        return
      }
      const change = { task: before, from: before.status, to: status(to), actor }
      beforeStatusChange(db, 'TASK', change)
      db.prepare('UPDATE task SET status_id = ? WHERE number = 1').run(to)
      try {
        await afterStatusChange(env, { ...change, task: task() })
      } catch (error) {
        warnings.push((error as Error).message)
      }
    },
  })
  return { db, env, chats, task, changeAs, warnings, wf }
}

test('starting moves the task to the first step, whose session opens with its rendered instructions and nothing before them', async () => {
  const { env, chats, task, changeAs } = setup()
  const run = await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.equal(task().status.name, 'In Progress')
  assert.equal(chats.sent.length, 1)
  const [opened] = chats.sent
  assert.equal(opened?.kind, 'start')
  assert.equal(opened?.agentNodeId, 'agent_dev')
  assert.equal(opened?.title, 'TASK-1', 'titled with the task key alone')
  assert.equal(opened?.target, 'chat-1', "in the space's chat")
  assert.equal(
    opened?.message,
    [
      'Implement TASK-1: It returns 500',
      '',
      '**When you are done**, finish this step (this moves the task on and starts the next step):',
      '`app_call { app: "dev.tasks", action: "workflow_step_finish", params: {"task":"TASK-1","transition":"On to Review","summary":"What you did, and anything the next step needs to know"} }`',
      'Allowed `transition` values: "On to Review".',
      'Your `summary` is posted on the task as a comment and shown to the next step, so do not also post it with `task_comment`.',
      '',
      'Read the task with `task_get {"key":"TASK-1"}` and the whole run with `workflow_run_get {"task":"TASK-1"}` — same app.',
    ].join('\n'),
  )
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.equal(run.state, 'active')
  assert.deepEqual([dev?.state, dev?.agentName, dev?.threadId, dev?.attempts], ['active', 'Dev', 'thread-1', 1])
})

test('a step with empty instructions opens with only how to finish it', () => {
  const message = openingMessage({ app: 'dev.tasks', taskKey: 'TASK-1', stepName: 'Development', instructions: '  \n', transitions: ['In Review'] })
  assert.ok(message.startsWith('**When you are done**, finish this step'), message)
})

test("an agent's finish moves the task on; the next step opens for its fixed agent and quotes the summary", async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'in review', summary: 'Patched the handler', actor: DEV })
  assert.equal(task().status.name, 'In Review')
  const steps = activeRunForTask(env.db, 'TASK', 1)?.steps ?? []
  assert.deepEqual(
    steps.map((s) => [s.name, s.state, s.outcome, s.summary, s.finishedBy]),
    [
      ['Development', 'done', 'In Review', 'Patched the handler', 'Dev'],
      ['Review', 'active', null, null, null],
    ],
  )
  assert.equal(chats.sent[1]?.agentNodeId, 'agent_rev')
  assert.match(chats.sent[1]?.message ?? '', /Review what Development did: Patched the handler/)
})

test('an agent can finish only its own step, only into an allowed transition — through either action', async () => {
  const { env, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await assert.rejects(
    () => finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV }),
    /worked by Dev, not Rev/,
  )
  await assert.rejects(
    () => finishStep(env, changeAs(DEV), { task: task(), transition: 'Done', actor: DEV }),
    /not a way out of "Development"; choose one of: "On to Review"/,
  )
  // The same rule holds when the agent skips the workflow action and changes status directly.
  await assert.rejects(() => changeAs(DEV).changeStatus({ key: 'TASK-1', status: 4 }), /can finish by: "On to Review"/)
  assert.equal(task().status.name, 'In Progress')
  // A person on the board is not bound by the step's list.
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 4 })
  assert.equal(activeRunForTask(env.db, 'TASK', 1), null, 'a done status with no step finishes the run')
})

test("sent back for rework, a step's own thread gets the task again with the reviewer's notes", async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  await finishStep(env, changeAs(REV), {
    task: task(),
    transition: 'In Progress',
    summary: 'Missing a test for the 500',
    actor: REV,
  })
  const rework = chats.sent[2]
  assert.equal(rework?.kind, 'send')
  assert.equal(rework?.target, 'dev.agent.t1', 'the Development thread, not a new one')
  assert.equal(rework?.queue, 'wait', 'queued behind a running turn, never pushed into it')
  assert.match(rework?.message ?? '', /back at Development\*\* \(round 2\): Rev moved it from "In Review"/)
  assert.match(rework?.message ?? '', /Missing a test for the 500/)
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([dev?.state, dev?.attempts, dev?.summary], ['active', 2, null])
})

test("a step's new thread is filed in the step's folder; one without a folder, and a reused thread, are not filed", async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'fixed', actor: DEV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.target, s.folder]),
    [
      ['start', 'chat-1', undefined],
      ['start', 'chat-1', 'Review queue'],
      ['send', 'dev.agent.t1', undefined],
      ['send', 'dev.agent.t2', undefined],
    ],
  )
})

test("a step's session options ride its opening message, and its round records what the host did with them", async () => {
  const devOptions: StepSessionOptions = { effort: 'high', presence: { kind: 'online' }, permissionMode: 'plan' }
  const { env, chats, task, changeAs } = setup({ devOptions, unoffered: ['permissionMode'] })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.deepEqual(chats.sent[0]?.sessionOptions, devOptions)
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual(dev?.rounds[0]?.sessionOptions, {
    applied: ['effort', 'presence'],
    skipped: [{ option: 'permissionMode', reason: 'not offered' }],
  })
})

test('a step entered again sends its session options again, into the thread it reuses', async () => {
  const devOptions: StepSessionOptions = { effort: 'low' }
  const { env, chats, task, changeAs } = setup({ devOptions })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.target, s.sessionOptions]),
    [
      ['start', 'chat-1', devOptions],
      ['start', 'chat-1', undefined],
      ['send', 'dev.agent.t1', devOptions],
    ],
    'Review sets none; the rework re-applies Development’s',
  )
  const rounds = activeRunForTask(env.db, 'TASK', 1)?.steps[0]?.rounds ?? []
  assert.deepEqual(
    rounds.map((r) => r.sessionOptions),
    [
      { applied: ['effort'], skipped: [] },
      { applied: ['effort'], skipped: [] },
    ],
  )
})

test('a step with no session options sends none, and its round records none', async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.equal(chats.sent[0]?.sessionOptions, undefined)
  assert.equal(activeRunForTask(env.db, 'TASK', 1)?.steps[0]?.rounds[0]?.sessionOptions, null)
})

// ── Compacting a reused session ─────────────────────────────────────────────

/** Everything queued on Dev's thread lane has run: a deferred compaction and its message included. */
const devLaneSettled = () => oneThreadAtATime({ app: 'dev.tasks', taskId: 1, agentId: 'agent_dev' }, async () => {})

/** A step's session holding `tokens` of context, as the host reports it. */
function holding(chats: ReturnType<typeof fakeChats>, thread: string, tokens: number): void {
  const usage = chats.threads.get(thread) ?? { turns: [], busy: false }
  chats.threads.set(thread, { ...usage, context: { usedTokens: tokens, contextLimit: 1_000_000 } })
}

/** Development done, then Review sends the task back: Development's rework round. */
async function sendBack(s: ReturnType<typeof setup>): Promise<void> {
  const { env, task, changeAs } = s
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'Missing a test', actor: REV })
}

test('a rework into a session over the default threshold compacts it first, then gives the instructions again', async () => {
  const s = setup()
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'Missing a test', actor: REV })
  await devLaneSettled()

  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => [m.kind, m.target]),
    [
      ['compact', 'dev.agent.t1'],
      ['send', 'dev.agent.t1'],
    ],
    'compacted, and only then sent',
  )
  const rework = s.chats.sent[3]?.message ?? ''
  assert.match(rework, /back at Development\*\* \(round 2\)/)
  assert.match(rework, /This session was compacted before this round\. Re-read the task and the run before you continue\./)
  assert.match(rework, /The step's instructions:\n\nImplement TASK-1: It returns 500/)
  const dev = activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]
  assert.equal(dev?.state, 'active')
  assert.deepEqual(
    dev?.rounds.map((r) => r.compaction),
    [null, { outcome: 'compacted', threshold: 200_000, before: 350_000, after: 20_000, error: null }],
  )
})

test("the finishing call does not wait for the compaction: the round shows it running until it ends", async () => {
  let release: (result: CompactResult) => void = () => {}
  const s = setup({ compact: () => new Promise((resolve) => (release = resolve)) })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })

  const round = () => activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)
  assert.deepEqual(round()?.compaction, { outcome: 'running', threshold: 200_000, before: 350_000, after: null, error: null })
  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => m.kind),
    ['compact'],
    'nothing sent while the session compacts',
  )

  release({ outcome: 'compacted', contextBefore: 351_000, contextAfter: 30_000 })
  await devLaneSettled()
  assert.deepEqual(round()?.compaction, { outcome: 'compacted', threshold: 200_000, before: 351_000, after: 30_000, error: null })
  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => m.kind),
    ['compact', 'send'],
  )
})

test("a failed compaction still sends the round's message, without the re-read note, and the round records why, its message not marked unsent", async () => {
  const s = setup({
    compact: async () => {
      throw new Error('That agent is no longer a member of this group chat')
    },
  })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  await devLaneSettled()

  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => [m.kind, m.target]),
    [
      ['compact', 'dev.agent.t1'],
      ['send', 'dev.agent.t1'],
    ],
  )
  assert.doesNotMatch(s.chats.sent[3]?.message ?? '', /compacted/)
  const dev = activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([dev?.state, dev?.error], ['active', null])
  assert.deepEqual(dev?.rounds.at(-1)?.compaction, {
    outcome: 'failed',
    threshold: 200_000,
    before: 350_000,
    after: null,
    error: 'That agent is no longer a member of this group chat',
  })
})

test("a session that cannot be messaged after its compaction leaves the step waiting, and the compaction records its message unsent", async () => {
  const s = setup({
    compact: async (thread) => {
      s.chats.archived.add(thread)
      return { outcome: 'compacted', contextBefore: 350_000, contextAfter: 20_000 }
    },
  })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  await devLaneSettled()

  const dev = activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]
  assert.equal(dev?.state, 'waiting')
  assert.deepEqual(dev?.rounds.at(-1)?.compaction, {
    outcome: 'compacted',
    threshold: 200_000,
    before: 350_000,
    after: 20_000,
    error: null,
    unsent: true,
  })
})

test('a compaction that timed out still sends, and its re-read note is left out', async () => {
  const s = setup({ compact: async () => ({ outcome: 'timed_out', contextBefore: 350_000, contextAfter: null }) })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  await devLaneSettled()

  assert.equal(s.chats.sent[3]?.kind, 'send')
  assert.doesNotMatch(s.chats.sent[3]?.message ?? '', /compacted/)
  assert.equal(activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)?.compaction?.outcome, 'timed_out')
})

test("a session at the step's threshold, a step that never compacts, and a session with no context reading are not compacted", async () => {
  for (const [devOptions, tokens] of [
    [{ compactAbove: 300_000 }, 300_000],
    [{ compactAbove: 0 }, 900_000],
    [{}, null],
  ] as const) {
    const s = setup({ devOptions })
    await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
    await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
    if (tokens !== null) {
      holding(s.chats, 'dev.agent.t1', tokens)
    }
    await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
    await devLaneSettled()
    assert.deepEqual(
      s.chats.sent.slice(2).map((m) => m.kind),
      ['send'],
      `compactAbove ${JSON.stringify(devOptions)}, context ${tokens}`,
    )
    assert.equal(activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)?.compaction, null)
  }
})

test("a step's own threshold compacts below the default, and is never sent to the host as a session option", async () => {
  const s = setup({ devOptions: { effort: 'low', compactAbove: 100_000 } })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 150_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  await devLaneSettled()

  assert.deepEqual(
    s.chats.sent.map((m) => [m.kind, m.sessionOptions]),
    [
      ['start', { effort: 'low' }],
      ['start', undefined],
      ['compact', undefined],
      ['send', { effort: 'low' }],
    ],
  )
  assert.equal(activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)?.compaction?.threshold, 100_000)
})

test('a round that ended while its session compacted records how the compaction ended, and sends nothing', async () => {
  let release: (result: CompactResult) => void = () => {}
  const s = setup({ compact: () => new Promise((resolve) => (release = resolve)) })
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  const runId = activeRunForTask(s.env.db, 'TASK', 1)!.id
  await cancelRun(s.env, { task: s.task(), actor: PERSON })
  const sentAtCancel = s.chats.sent.length

  release({ outcome: 'compacted', contextBefore: 350_000, contextAfter: 25_000 })
  await devLaneSettled()
  assert.equal(s.chats.sent.length, sentAtCancel, 'no rework message after the cancel')
  const round = getRun(s.env.db, 'TASK', runId)?.steps[0]?.rounds.at(-1)
  assert.deepEqual([round?.endedBy, round?.compaction?.outcome, round?.compaction?.after], ['cancel', 'compacted', 25_000])
})

/** Run `body` as if the process had restarted: compactions it starts or finds carry another process's mark. */
async function afterRestart(body: () => Promise<void>): Promise<void> {
  const global = globalThis as unknown as { __taskPipelinesProcessMark?: string }
  const saved = global.__taskPipelinesProcessMark
  global.__taskPipelinesProcessMark = 'restarted-process'
  try {
    await body()
  } finally {
    if (saved === undefined) {
      delete global.__taskPipelinesProcessMark
    } else {
      global.__taskPipelinesProcessMark = saved
    }
  }
}

/** Development sent back into a session over the threshold, its compaction held until `release`. */
async function compactingRework(s: ReturnType<typeof withInbox>) {
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t1', 350_000)
  await finishStep(s.env, s.changeAs(REV), { task: s.task(), transition: 'In Progress', summary: 'again', actor: REV })
  s.drafts.length = 0
}

function heldCompaction() {
  let release: (result: CompactResult) => void = () => {}
  const compact = () => new Promise<CompactResult>((resolve) => (release = resolve))
  return { compact, release: (result: CompactResult) => release(result) }
}

test('a compaction a restart cut off is recorded as failed with its message unsent, and its step waits with the reason and asks for attention', async () => {
  const held = heldCompaction()
  const s = withInbox({ compact: held.compact })
  await compactingRework(s)

  await afterRestart(async () => {
    assert.equal(await recoverInterruptedCompactions(s.env), 1)
  })
  const dev = activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual(dev?.rounds.at(-1)?.compaction, {
    outcome: 'failed',
    threshold: 200_000,
    before: 350_000,
    after: null,
    error: 'The server restarted while the session was compacting',
    unsent: true,
  })
  assert.deepEqual([dev?.state, dev?.error], [
    'waiting',
    "The server restarted while this step's session was compacting, so the round's message was never sent. Restart the step to send it.",
  ])
  assert.deepEqual(s.told(), [['step_attention', 'Development', [{ kind: 'person', name: 'user' }, 'reporter'], null]])

  // The cut-off job is gone in a real restart; should it end after all, it sends nothing.
  held.release({ outcome: 'compacted', contextBefore: 350_000, contextAfter: 20_000 })
  await devLaneSettled()
  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => m.kind),
    ['compact'],
  )
  assert.equal(activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)?.compaction?.outcome, 'failed')
})

test('a reload in the same process leaves a running compaction alone, and it ends and sends as usual', async () => {
  const held = heldCompaction()
  const s = withInbox({ compact: held.compact })
  await compactingRework(s)

  assert.equal(await recoverInterruptedCompactions(s.env), 0)
  assert.equal(activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]?.rounds.at(-1)?.compaction?.outcome, 'running')

  held.release({ outcome: 'compacted', contextBefore: 350_000, contextAfter: 20_000 })
  await devLaneSettled()
  const dev = activeRunForTask(s.env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([dev?.state, dev?.rounds.at(-1)?.compaction?.outcome], ['active', 'compacted'])
  assert.deepEqual(
    s.chats.sent.slice(2).map((m) => m.kind),
    ['compact', 'send'],
  )
  assert.deepEqual(s.told(), [['step_open', 'Development', [{ kind: 'agent', id: 'agent_dev', name: 'Dev' }], 'Rev']])
})

test('a cut-off compaction of a round that has ended is recorded as failed, and asks nobody for anything', async () => {
  const held = heldCompaction()
  const s = withInbox({ compact: held.compact })
  await compactingRework(s)
  const runId = activeRunForTask(s.env.db, 'TASK', 1)!.id
  await cancelRun(s.env, { task: s.task(), actor: PERSON })
  s.drafts.length = 0

  await afterRestart(async () => {
    assert.equal(await recoverInterruptedCompactions(s.env), 1)
  })
  const dev = getRun(s.env.db, 'TASK', runId)?.steps[0]
  assert.deepEqual([dev?.state, dev?.rounds.at(-1)?.compaction?.outcome], ['done', 'failed'])
  assert.deepEqual(s.told(), [])
  held.release({ outcome: 'failed', contextBefore: null, contextAfter: null, error: 'gone' })
  await devLaneSettled()
})

test("a step's first entry opens a new session and never compacts", async () => {
  const s = setup()
  holding(s.chats, 'dev.agent.t1', 900_000)
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  assert.deepEqual(
    s.chats.sent.map((m) => m.kind),
    ['start'],
  )
})

test("a round records the context its session held as it ended, and an open round reads it live", async () => {
  const s = setup()
  await startWorkflow(s.env, s.changeAs(PERSON), { task: s.task(), actor: PERSON })
  holding(s.chats, 'dev.agent.t1', 123_000)
  await finishStep(s.env, s.changeAs(DEV), { task: s.task(), transition: 'In Review', summary: 'done', actor: DEV })
  holding(s.chats, 'dev.agent.t2', 45_000)
  const run = activeRunForTask(s.env.db, 'TASK', 1)!
  assert.deepEqual(
    run.steps.map((step) => step.rounds.map((r) => r.contextTokens)),
    [[123_000], [null]],
    'recorded at the end; the open round has no stored figure',
  )
  const live = await withLiveUsage(s.env.db, s.chats, run)
  assert.equal(live.steps[1]?.rounds[0]?.contextTokens, 45_000)
})

test("a round that ends inside its session's first turn, before any context is reported, takes the context when it settles", async () => {
  const { env, chats, task, changeAs } = setup()
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const reviewRound = () => getRun(env.db, 'TASK', runId)!.steps[1]!.rounds[0]!

  // Review sends the task back from inside its session's first turn: nothing reported yet.
  chats.threads.set('dev.agent.t2', { turns: [], busy: true })
  clock = at('10:10')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  assert.deepEqual([reviewRound().usage?.state, reviewRound().contextTokens], ['pending', null])

  // That turn ends, reporting the context the session holds.
  chats.threads.set('dev.agent.t2', {
    turns: [turn('10:11', 117)],
    busy: false,
    context: { usedTokens: 117_000, contextLimit: 1_000_000 },
  })
  await settlePendingUsage(env.db, chats, [runId])
  assert.deepEqual([reviewRound().usage?.state, reviewRound().contextTokens], ['settled', 117_000])
})

test("a round that ends mid-turn keeps no in-turn reading, even 0, and takes the session's figure once that turn has ended", async () => {
  const { env, chats, task, changeAs } = setup()
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const reviewRound = () => getRun(env.db, 'TASK', runId)!.steps[1]!.rounds[0]!

  // Inside its session's first turn the harness reports a count it has not built up yet.
  chats.threads.set('dev.agent.t2', { turns: [], busy: true, context: { usedTokens: 0, contextLimit: 1_000_000 } })
  clock = at('10:10')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  assert.deepEqual([reviewRound().usage?.state, reviewRound().contextTokens], ['pending', null])

  chats.threads.set('dev.agent.t2', {
    turns: [turn('10:11', 291)],
    busy: false,
    context: { usedTokens: 291_000, contextLimit: 1_000_000 },
  })
  await settlePendingUsage(env.db, chats, [runId])
  assert.deepEqual([reviewRound().usage?.state, reviewRound().contextTokens], ['settled', 291_000])
})

test('a round whose thread has started another round by the time it settles keeps no context: it would be the later round’s', async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id

  // Development ends inside the session's first turn, and Review opens in the same thread.
  chats.threads.set('dev.agent.t1', { turns: [], busy: true })
  clock = at('10:10')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  chats.threads.set('dev.agent.t1', {
    turns: [turn('10:11', 20), turn('10:15', 50)],
    busy: false,
    context: { usedTokens: 90_000, contextLimit: 1_000_000 },
  })
  await settlePendingUsage(env.db, chats, [runId])
  const dev = getRun(env.db, 'TASK', runId)!.steps[0]!.rounds[0]!
  assert.deepEqual([dev.usage?.state, dev.contextTokens], ['settled', null])
})

test("each round records what its session spent; one that ended mid-turn settles once that turn's record exists", async () => {
  const { env, chats, task, changeAs } = setup()
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id

  // Dev worked a turn, and finishes from inside the next one: the round ends mid-turn.
  chats.threads.set('dev.agent.t1', { turns: [turn('10:04', 100)], busy: true })
  clock = at('10:10')
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  const devRound = () => getRun(env.db, 'TASK', runId)!.steps[0]!.rounds[0]!
  assert.deepEqual([devRound().usage?.state, devRound().usage?.tokens.total], ['pending', 100])

  // The finishing turn ends a minute later; Rev reviews and sends it back, idle when it does.
  chats.threads.set('dev.agent.t1', { turns: [turn('10:04', 100), turn('10:11', 20)], busy: false })
  chats.threads.set('dev.agent.t2', { turns: [turn('10:15', 50)], busy: false })
  clock = at('10:20')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'Add a test', actor: REV })
  const review = getRun(env.db, 'TASK', runId)!.steps[1]!
  assert.deepEqual(
    [review.rounds[0]?.usage?.state, review.rounds[0]?.usage?.tokens.total],
    ['settled', 50],
    'idle at its end: nothing still to come',
  )

  // Round 2 of Development reuses the thread; its turns are not round 1's.
  chats.threads.set('dev.agent.t1', { turns: [turn('10:04', 100), turn('10:11', 20), turn('10:30', 300)], busy: true })
  await settlePendingUsage(env.db, chats, [runId])
  const dev = getRun(env.db, 'TASK', runId)!.steps[0]!
  assert.deepEqual(
    dev.rounds.map((r) => [r.roundNo, r.usage?.state ?? null, r.usage?.turns ?? null, r.usage?.tokens.total ?? null]),
    [
      [1, 'settled', 2, 120],
      [2, null, null, null],
    ],
    'round 1 counts its finishing turn; round 2 is open, read live rather than stored',
  )
  assert.deepEqual(dev.spent.usage?.cost, [{ amount: 0.12, currency: 'USD' }])
  assert.equal(dev.rounds[0]?.timeMs, 10 * 60_000)
  const run = getRun(env.db, 'TASK', runId)!
  assert.deepEqual([run.spent.usage?.tokens.total, run.spent.pending], [170, 0])
})

test("a space chat the task manager isn't in leaves the step waiting with the reason; restart retries it", async () => {
  const { env, task, changeAs, warnings, chats } = setup({ outsider: true })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.equal(task().status.name, 'In Progress', 'the status change stands')
  assert.match(warnings[0] ?? '', /The task manager isn't in this space's chat \("dev"\) yet: a person grants it in the task manager's Settings → Chat/)
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.equal(dev?.state, 'waiting')
  assert.match(dev?.error ?? '', /isn't in this space's chat/)
  assert.equal(chats.sent.length, 0, 'no thread in any other chat')

  const granted = fakeChats()
  env.chats = granted
  await restartStep(env, changeAs(PERSON), { task: task(), step: 'development', actor: PERSON })
  const again = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([again?.state, again?.error, again?.attempts], ['active', null, 2])
  assert.deepEqual([granted.sent[0]?.kind, granted.sent[0]?.target], ['start', 'chat-1'])
})

test("an agent who isn't in the space's chat leaves the step waiting, named in the reason", async () => {
  const { env, task, changeAs, warnings, chats } = setup({ assignee: { kind: 'agent', id: 'agent_far', name: 'Far' } })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.match(warnings[0] ?? '', /Far isn't in this space's chat/)
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([dev?.state, dev?.error], ['waiting', "Far isn't in this space's chat"])
  assert.equal(chats.sent.length, 0, 'not opened in the chat Far is in either')
})

test("a fixed agent who isn't in the space's chat is named from the directory, not by its node id", async () => {
  const { env, task, changeAs } = setup()
  env.agents = async () => [{ id: 'agent_rev', name: 'Reviewer (Code)' }]
  env.chats = { ...fakeChats(), list: async () => [{ ref: 'chat-1', slug: 'dev', name: 'Dev', agents: [{ nodeId: 'agent_dev', name: 'Dev' }] }] }
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 3 })
  const review = activeRunForTask(env.db, 'TASK', 1)?.steps[1]
  assert.deepEqual([review?.state, review?.agentName, review?.error], ['waiting', 'Reviewer (Code)', "Reviewer (Code) isn't in this space's chat"])
})

test('the host refusing a thread in the space chat reads as the task manager not being in it', async () => {
  const { env, task, changeAs, warnings } = setup({ refuse: true })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.match(warnings[0] ?? '', /isn't in this space's chat \("dev"\)/)
})

test("each time a step couldn't start, its round records the reason and the message", async () => {
  const cases: Array<[Parameters<typeof setup>[0], string]> = [
    [{ assignee: null }, 'unassigned'],
    [{ outsider: true }, 'not_in_chat'],
    [{ refuse: true }, 'not_in_chat'],
    [{ assignee: { kind: 'agent', id: 'agent_far', name: 'Far' } }, 'session_failed'],
  ]
  for (const [options, reason] of cases) {
    const { env, task, changeAs } = setup(options)
    await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
    const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
    const rows = env.db.prepare('SELECT round_no, reason, message FROM workflow_run_attention').all() as Array<Record<string, unknown>>
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ round_no: 1, reason, message: dev?.error }],
      `${JSON.stringify(options)} records ${reason}`,
    )
  }
})

test('a thread opened in another chat before is left there: the step opens a new one in the space chat', async () => {
  const { env, task, changeAs, chats } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  // Development's session is recorded in a chat other than the space's.
  env.db.prepare("UPDATE workflow_run_step SET chat_slug = 'old-project-chat', chat_ref = 'chat-old'").run()
  chats.titles.clear()
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 3 })
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 2 })
  const back = chats.sent.at(-1)
  assert.deepEqual([back?.kind, back?.target], ['start', 'chat-1'], 'a new thread, not a message into the old one')
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.deepEqual([dev?.chatSlug, dev?.threadRef], ['dev', back ? 'dev.agent.t3' : null])
})

test('a step assigned to a person waits without a session', async () => {
  const { env, task, changeAs, chats } = setup({ assignee: { kind: 'person', name: 'Ada' } })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const dev = activeRunForTask(env.db, 'TASK', 1)?.steps[0]
  assert.equal(dev?.state, 'waiting')
  assert.match(dev?.error ?? '', /a person/)
  assert.equal(chats.sent.length, 0)
})

test("a task reaching a done status archives every thread its runs used, earlier runs' included", async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await cancelRun(env, { task: task(), actor: PERSON })
  // As if another agent had worked the cancelled run, so its thread is not continued.
  env.db.prepare("UPDATE workflow_run_step SET agent_node_id = 'agent_other' WHERE thread_ref IS NOT NULL").run()
  chats.titles.clear()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  assert.deepEqual(chats.archiveCalls, [], 'nothing is archived before the task closes')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', summary: 'ok', actor: REV })
  assert.deepEqual(
    [...chats.archiveCalls].sort(),
    ['archive dev.agent.t1', 'archive dev.agent.t2', 'archive dev.agent.t3'],
    'the cancelled run’s thread, and both steps of the finished one',
  )
})

test('a task closed with no run active still has its earlier runs’ threads archived', async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await cancelRun(env, { task: task(), actor: PERSON })
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 5 })
  assert.deepEqual(chats.archiveCalls, ['archive dev.agent.t1'])
})

test('a step re-entering its archived thread unarchives it before writing to it', async () => {
  const { env, chats, task, changeAs, warnings } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'done', actor: DEV })
  chats.archived.add('dev.agent.t1')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  assert.deepEqual(warnings, [])
  assert.deepEqual(chats.archiveCalls, ['unarchive dev.agent.t1'])
  assert.deepEqual([chats.sent.at(-1)?.kind, chats.sent.at(-1)?.target], ['send', 'dev.agent.t1'])
})

// ─── Transitions: edges to steps, and the gate each round passed or failed ─

const DES: Actor = { kind: 'agent', name: 'Des' }

/** Code and Design both start on In Progress; QA sends the task back to either, or passes it to the end. */
const twoTracks: WorkflowStepDraft[] = [
  { name: 'Code', triggerStatus: 2, worker: { kind: 'assignee' }, transitions: [{ label: 'Ready for design', toStep: 'Design', status: 2 }] },
  {
    name: 'Design',
    triggerStatus: 2,
    worker: { kind: 'agent', agentNodeId: 'agent_des' },
    transitions: [{ label: 'Ready for QA', toStep: 'QA', status: 3 }],
  },
  {
    name: 'QA',
    triggerStatus: 3,
    worker: { kind: 'agent', agentNodeId: 'agent_rev' },
    transitions: [
      { label: 'Passed', toStep: 'end', status: 4 },
      { label: 'Back to code', toStep: 'Code', status: 2 },
      { label: 'Back to design', toStep: 'Design', status: 2 },
    ],
  },
]

/** Each step's rounds as `<transition> <gate>`, open ones as `open`. */
function gates(run: ReturnType<typeof activeRunForTask>) {
  return Object.fromEntries((run?.steps ?? []).map((s) => [s.name, s.rounds.map((r) => (r.endedAt ? `${r.transition} ${r.gate}` : 'open'))]))
}

test('each round records the transition it left by and its gate: forward passes, back fails', async () => {
  const { env, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'On to Review', summary: 'done', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'back to development', summary: 'again', actor: REV })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', summary: 'fixed', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Finish: Done', summary: 'ok', actor: REV })
  const [run] = runsForTask(env.db, 'TASK', 1)
  assert.equal(run?.state, 'finished')
  assert.deepEqual(gates(run ?? null), {
    Development: ['On to Review pass', 'On to Review pass'],
    Review: ['Back to Development fail', 'Finish: Done pass'],
  })
})

test('QA sends the task back to either of two steps that share a status, and that step’s own session gets it', async () => {
  const { env, chats, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  // Code to Design keeps In Progress: no status change, and still the next step opens.
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Ready for design', summary: 'coded', actor: DEV })
  assert.equal(task().status.name, 'In Progress')
  await finishStep(env, changeAs(DES), { task: task(), transition: 'Ready for QA', summary: 'designed', actor: DES })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Back to design', summary: 'misaligned', actor: REV })
  assert.equal(task().status.name, 'In Progress')
  await finishStep(env, changeAs(DES), { task: task(), transition: 'Ready for QA', summary: 'aligned', actor: DES })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Back to code', summary: 'crashes', actor: REV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.agentNodeId ?? s.target]),
    [
      ['start', 'agent_dev'],
      ['start', 'agent_des'],
      ['start', 'agent_rev'],
      ['send', 'dev.agent.t2'],
      ['send', 'dev.agent.t3'],
      ['send', 'dev.agent.t1'],
    ],
    'Design, then Code, each reopened in its own thread',
  )
  assert.match(chats.sent[3]?.message ?? '', /back at Design\*\* \(round 2\)[\s\S]*misaligned/)
  assert.match(chats.sent[5]?.message ?? '', /back at Code\*\* \(round 2\)[\s\S]*crashes/)
  const run = activeRunForTask(env.db, 'TASK', 1)
  assert.deepEqual(gates(run), {
    Code: ['Ready for design pass', 'open'],
    Design: ['Ready for QA pass', 'Ready for QA pass'],
    QA: ['Back to design fail', 'Back to code fail'],
  })
  assert.deepEqual(
    run?.steps.map((s) => [s.name, s.state]),
    [
      ['Code', 'active'],
      ['Design', 'done'],
      ['QA', 'done'],
    ],
  )
})

test('a status named for a finish picks the transition into the step that status starts', async () => {
  const { env, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Ready for design', actor: DEV })
  await finishStep(env, changeAs(DES), { task: task(), transition: 'In Review', actor: DES })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', actor: REV })
  assert.deepEqual(gates(activeRunForTask(env.db, 'TASK', 1)).QA, ['Back to code fail'])
})

test('a person’s move opens the first step its status starts, and counts as the open step’s transition into it', async () => {
  const { env, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Ready for design', actor: DEV })
  await finishStep(env, changeAs(DES), { task: task(), transition: 'Ready for QA', actor: DES })
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 2 })
  let run = activeRunForTask(env.db, 'TASK', 1)
  assert.equal(run?.steps.find((s) => s.state === 'active')?.name, 'Code')
  assert.deepEqual(gates(run).QA, ['Back to code fail'])
  // Into a status no transition of the open step sets: no gate result, and To Do starts no step.
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 1 })
  run = activeRunForTask(env.db, 'TASK', 1)
  assert.deepEqual(gates(run).Code, ['Ready for design pass', 'null null'])
  assert.equal(run?.state, 'active', 'a status that starts no step and is not done leaves the run open')
})

test('a transition to the end finishes the run even into a status that is not done; a person reaching it does too', async () => {
  const steps: WorkflowStepDraft[] = [
    { name: 'Development', triggerStatus: 2, worker: { kind: 'assignee' }, transitions: [{ label: 'Handed over', toStep: 'end', status: 3 }] },
  ]
  const agent = setup({ steps })
  await startWorkflow(agent.env, agent.changeAs(PERSON), { task: agent.task(), actor: PERSON })
  await finishStep(agent.env, agent.changeAs(DEV), { task: agent.task(), transition: 'Handed over', actor: DEV })
  assert.deepEqual(
    runsForTask(agent.env.db, 'TASK', 1).map((r) => [r.state, gates(r).Development]),
    [['finished', ['Handed over pass']]],
  )
  const person = setup({ steps })
  await startWorkflow(person.env, person.changeAs(PERSON), { task: person.task(), actor: PERSON })
  await person.changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 3 })
  assert.equal(runsForTask(person.env.db, 'TASK', 1)[0]?.state, 'finished')
})

test('a gate override wins over the one the graph gives', async () => {
  const steps: WorkflowStepDraft[] = [
    { name: 'Development', triggerStatus: 2, worker: { kind: 'assignee' }, transitions: [{ label: 'Abandoned', toStep: 'end', status: 5, gate: 'fail' }] },
  ]
  const { env, task, changeAs } = setup({ steps })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Abandoned', actor: DEV })
  assert.deepEqual(gates(runsForTask(env.db, 'TASK', 1)[0] ?? null).Development, ['Abandoned fail'])
})

test('restarting a step that shares the current status closes the open one and opens it in place', async () => {
  const { env, chats, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await restartStep(env, changeAs(PERSON), { task: task(), step: 'Design', actor: PERSON })
  const run = activeRunForTask(env.db, 'TASK', 1)
  assert.deepEqual(
    run?.steps.map((s) => [s.name, s.state]),
    [
      ['Code', 'done'],
      ['Design', 'active'],
      ['QA', 'pending'],
    ],
  )
  assert.deepEqual(gates(run).Code, ['null null'])
  assert.equal(chats.sent.at(-1)?.agentNodeId, 'agent_des')
})

test('restarting a step on another status reaches that step, not the first one the status starts', async () => {
  const { env, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Ready for design', actor: DEV })
  await finishStep(env, changeAs(DES), { task: task(), transition: 'Ready for QA', actor: DES })
  await restartStep(env, changeAs(PERSON), { task: task(), step: 'Design', actor: PERSON })
  assert.equal(task().status.name, 'In Progress')
  assert.equal(activeRunForTask(env.db, 'TASK', 1)?.steps.find((s) => s.state === 'active')?.name, 'Design')
})

test('a finish the task model refuses leaves no move pending for the next status change', async () => {
  const { env, task, changeAs } = setup({ steps: twoTracks })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'Ready for design', actor: DEV })
  await finishStep(env, changeAs(DES), { task: task(), transition: 'Ready for QA', actor: DES })
  const refusing: TaskPort = {
    changeStatus: async () => {
      throw new Error('refused')
    },
  }
  await assert.rejects(finishStep(env, refusing, { task: task(), transition: 'Back to design', actor: REV }), /refused/)
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 2 })
  assert.equal(activeRunForTask(env.db, 'TASK', 1)?.steps.find((s) => s.state === 'active')?.name, 'Code', 'the move a person made, not the refused one')
})

// ─── One thread per agent per task ─────────────────────────────────────────

test("an agent's next step on the task continues in its thread, queued, with that step's opening message", async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', summary: 'Patched the handler', actor: REV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.target, s.title, s.queue]),
    [
      ['start', 'chat-1', 'TASK-1', undefined],
      ['send', 'dev.agent.t1', undefined, 'wait'],
    ],
  )
  assert.equal(
    chats.sent[1]?.message,
    openingMessage({
      app: 'dev.tasks',
      taskKey: 'TASK-1',
      stepName: 'Review',
      instructions: 'Review what Development did: Patched the handler',
      transitions: ['Finish: Done', 'Back to Development'],
    }),
  )
  const steps = activeRunForTask(env.db, 'TASK', 1)?.steps ?? []
  assert.deepEqual(
    steps.map((s) => [s.name, s.threadRef, s.threadId]),
    [
      ['Development', 'dev.agent.t1', 'thread-1'],
      ['Review', 'dev.agent.t1', 'thread-1'],
    ],
  )
})

test('in a shared thread, rework of a step still gets the rework message, and a new step never does', async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', summary: 'done', actor: REV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'Missing a test', actor: REV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', summary: 'Added it', actor: REV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.target, s.queue]),
    [
      ['start', 'chat-1', undefined],
      ['send', 'dev.agent.t1', 'wait'],
      ['send', 'dev.agent.t1', 'wait'],
      ['send', 'dev.agent.t1', 'wait'],
    ],
  )
  assert.match(chats.sent[1]?.message ?? '', /^Review what Development did: done/)
  assert.doesNotMatch(chats.sent[1]?.message ?? '', /back at/)
  assert.match(chats.sent[2]?.message ?? '', /back at Development\*\* \(round 2\)/)
  assert.match(chats.sent[3]?.message ?? '', /back at Review\*\* \(round 2\)/)
})

test('different agents get different threads, each titled with the task key', async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.agentNodeId, s.title]),
    [
      ['start', 'agent_dev', 'TASK-1'],
      ['start', 'agent_rev', 'TASK-1'],
    ],
  )
})

test("an agent's thread already named with the task key is left alone: the step opens its own beside it, and the agent's next step continues there", async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  // Started by hand, before the run.
  chats.titles.add('chat-1 agent_rev TASK-1')
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', summary: 'done', actor: REV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.kind === 'start' ? s.title : s.target]),
    [
      ['start', 'TASK-1 (task manager)'],
      ['send', 'dev.agent.t1'],
    ],
  )
  const steps = activeRunForTask(env.db, 'TASK', 1)?.steps ?? []
  assert.deepEqual(
    steps.map((s) => [s.name, s.state, s.error, s.threadRef]),
    [
      ['Development', 'done', null, 'dev.agent.t1'],
      ['Review', 'active', null, 'dev.agent.t1'],
    ],
  )
})

test('a step waits with the reason only when every title for its thread is taken', async () => {
  const { env, chats, task, changeAs, warnings } = setup()
  for (const title of ['TASK-1', 'TASK-1 (task manager)', 'TASK-1 (task manager 2)', 'TASK-1 (task manager 3)']) {
    chats.titles.add(`chat-1 agent_dev ${title}`)
  }
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const [development] = activeRunForTask(env.db, 'TASK', 1)?.steps ?? []
  assert.deepEqual([development?.state, development?.error], ['waiting', 'This agent already has a thread named "TASK-1 (task manager 3)" here'])
  assert.equal(warnings.length, 1)
  assert.equal(chats.sent.length, 0)
})

test("steps sharing a thread each count only their own turns; the finishing turn goes to the step it finished", async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const thread = 'dev.agent.t1'

  // Development finishes from inside a turn, and Review opens in the same thread at the same moment.
  chats.threads.set(thread, { turns: [turn('10:04', 100)], busy: true })
  clock = at('10:10')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })

  // Development's finishing turn ends at 10:11; Review's queued message runs after it.
  chats.threads.set(thread, { turns: [turn('10:04', 100), turn('10:11', 20), turn('10:15', 50)], busy: false })
  const live = await withLiveUsage(env.db, chats, getRun(env.db, 'TASK', runId)!)
  assert.equal(live.steps[1]?.rounds[0]?.usage?.tokens.total, 50, "Review read live before Development settled leaves out Development's finishing turn")

  // Review sends the task back from inside a turn that ends at 10:21; Development round 2 follows it in the thread.
  chats.threads.set(thread, { turns: [turn('10:04', 100), turn('10:11', 20), turn('10:15', 50)], busy: true })
  clock = at('10:20')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'Add a test', actor: REV })
  chats.threads.set(thread, {
    turns: [turn('10:04', 100), turn('10:11', 20), turn('10:15', 50), turn('10:21', 5), turn('10:30', 300)],
    busy: true,
  })
  await settlePendingUsage(env.db, chats, [runId])
  const run = await withLiveUsage(env.db, chats, getRun(env.db, 'TASK', runId)!)
  const usage = run.steps.map((s) => [s.name, s.rounds.map((r) => [r.usage?.state, r.usage?.turns, r.usage?.tokens.total])])
  assert.deepEqual(usage, [
    [
      'Development',
      [
        ['settled', 2, 120],
        ['live', 1, 300],
      ],
    ],
    ['Review', [['settled', 2, 55]]],
  ])
  assert.equal(run.spent.usage?.tokens.total, 475, 'every turn counted once')
})

test("a round after a still-pending one on its thread keeps its own first turn when the pending one's finishing turn ended before it began", async () => {
  const { env, chats, task, changeAs } = setup()
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  chats.threads.set('dev.agent.t1', { turns: [turn('10:04', 100)], busy: true })
  clock = at('10:10')
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  // Nothing reads the run while Rev reviews, so Development round 1 stays pending past its finishing turn at 10:11.
  clock = at('10:20')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  chats.threads.set('dev.agent.t1', { turns: [turn('10:04', 100), turn('10:11', 20), turn('10:25', 300)], busy: true })
  const run = await withLiveUsage(env.db, chats, getRun(env.db, 'TASK', runId)!)
  const dev = run.steps[0]!.rounds.map((r) => [r.usage?.state, r.usage?.tokens.total])
  assert.deepEqual(dev, [
    ['pending', 100],
    ['live', 300],
  ])
})

test("a round whose usage could not be read claims no turn of the next round on its thread", async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const thread = 'dev.agent.t1'
  const usage = chats.usage!
  // Development ends idle, and the host fails to answer the one read of its usage.
  chats.threads.set(thread, { turns: [turn('10:04', 100)], busy: false })
  chats.usage = async () => {
    throw new Error('usage unavailable')
  }
  clock = at('10:10')
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 3 })
  chats.usage = usage
  // Review works one turn in the same thread and sends the task back.
  chats.threads.set(thread, { turns: [turn('10:04', 100), turn('10:15', 50)], busy: false })
  clock = at('10:20')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  await settlePendingUsage(env.db, chats, [runId])
  const run = getRun(env.db, 'TASK', runId)!
  assert.deepEqual(
    run.steps.map((s) => [s.name, s.rounds.map((r) => [r.usage?.state ?? null, r.usage?.tokens.total ?? null])]),
    [
      [
        'Development',
        [
          [null, null],
          [null, null],
        ],
      ],
      ['Review', [['settled', 50]]],
    ],
    "Development's lost read costs only its own figure; Review keeps its turn",
  )
})

test('rounds that all happened inside one turn count that turn once, for the first of them; the rest say they shared it', async () => {
  // A harness that takes input mid-turn folds each step's message into the
  // turn still running: four rounds end while the thread is busy, and the host
  // records one turn when it finally ends.
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const thread = 'dev.agent.t1'
  chats.threads.set(thread, { turns: [], busy: true })
  clock = at('10:01')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  clock = at('10:02')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  clock = at('10:03')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  clock = at('10:04')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', actor: REV })
  chats.threads.set(thread, { turns: [turn('10:05', 400)], busy: false })
  await settlePendingUsage(env.db, chats, [runId])
  const run = getRun(env.db, 'TASK', runId)!
  assert.deepEqual(
    run.steps.map((s) => [s.name, s.rounds.map((r) => [r.usage?.state, r.usage?.tokens.total, r.usage?.sharedWith])]),
    [
      [
        'Development',
        [
          ['settled', 400, undefined],
          ['shared', 0, 'Development'],
        ],
      ],
      [
        'Review',
        [
          ['shared', 0, 'Development'],
          ['shared', 0, 'Development'],
        ],
      ],
    ],
  )
  const review = run.steps[1]!.spent
  assert.deepEqual([review.usage, review.sharedWith], [null, ['Development']], 'Review shows no figures of its own, only that it shared a turn')
  assert.equal(run.spent.usage?.tokens.total, 400, 'the one turn is counted once')
  assert.equal(run.spent.sharedWith, undefined, 'the run total already holds the shared turn')
})

test('a round that ended inside a claimed turn takes no later turn as its finishing one, however late it settles', async () => {
  // Development round 1 and Review round 1 both end inside one long turn and
  // wait on it. Development round 2 then works a turn of its own, and both
  // earlier rounds settle only after that.
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const thread = 'dev.agent.t1'
  chats.threads.set(thread, { turns: [], busy: true })
  clock = at('10:01')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  clock = at('10:02')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  chats.threads.set(thread, { turns: [turn('10:05', 400), turn('10:08', 70)], busy: false })
  clock = at('10:10')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  clock = at('10:12')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', actor: REV })
  await settlePendingUsage(env.db, chats, [runId])
  const run = getRun(env.db, 'TASK', runId)!
  assert.deepEqual(
    run.steps.map((s) => [s.name, s.rounds.map((r) => [r.usage?.state, r.usage?.tokens.total, r.usage?.sharedWith])]),
    [
      [
        'Development',
        [
          ['settled', 400, undefined],
          ['settled', 70, undefined],
        ],
      ],
      [
        'Review',
        [
          ['shared', 0, 'Development'],
          ['settled', 0, undefined],
        ],
      ],
    ],
  )
  assert.equal(run.spent.usage?.tokens.total, 470, 'each turn counted once')
})

test('a round whose usage read failed in the middle of one shared turn does not let a later round count that turn again', async () => {
  const { env, chats, task, changeAs } = setup({ assignee: REV_ASSIGNED })
  let clock = at('10:00')
  env.now = () => clock
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const runId = activeRunForTask(env.db, 'TASK', 1)!.id
  const thread = 'dev.agent.t1'
  const usage = chats.usage!
  chats.threads.set(thread, { turns: [], busy: true })
  clock = at('10:01')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  // The one read when Review round 1 ends fails, so that round has no usage record at all.
  chats.usage = async () => {
    throw new Error('usage unavailable')
  }
  clock = at('10:02')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  chats.usage = usage
  clock = at('10:03')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Review', actor: REV })
  clock = at('10:04')
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', actor: REV })
  chats.threads.set(thread, { turns: [turn('10:05', 400)], busy: false })
  await settlePendingUsage(env.db, chats, [runId])
  const run = getRun(env.db, 'TASK', runId)!
  assert.deepEqual(
    run.steps.map((s) => [s.name, s.rounds.map((r) => [r.usage?.state ?? null, r.usage?.tokens.total ?? null, r.usage?.sharedWith ?? null])]),
    [
      [
        'Development',
        [
          ['settled', 400, null],
          ['shared', 0, 'Development'],
        ],
      ],
      [
        'Review',
        [
          [null, null, null],
          ['shared', 0, 'Development'],
        ],
      ],
    ],
  )
  assert.equal(run.spent.usage?.tokens.total, 400, 'the one turn is counted once')
})

test("a later run continues each agent's thread from the earlier one, unarchived, with the step's opening message", async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', actor: REV })
  assert.deepEqual([...chats.archived].sort(), ['dev.agent.t1', 'dev.agent.t2'])

  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.deepEqual(chats.archiveCalls.at(-1), 'unarchive dev.agent.t1')
  const last = chats.sent.at(-1)
  assert.deepEqual([last?.kind, last?.target, last?.queue], ['send', 'dev.agent.t1', 'wait'])
  assert.match(last?.message ?? '', /^Implement TASK-1: It returns 500/)
  assert.equal(chats.sent.filter((s) => s.kind === 'start').length, 2, 'no new thread')
})

/** A mention session of the task's, as the mentions engine records one. */
function mentionSession(env: EngineEnv, agentId: string, threadRef: string, lastAt: string, chatSlug = 'dev') {
  env.db
    .prepare(
      `INSERT INTO mention_session (task_id, agent_id, agent_name, chat_ref, chat_slug, thread_id, thread_ref, started_at, last_at)
       VALUES ((SELECT id FROM task WHERE number = 1), ?, 'Dev', 'chat-1', ?, ?, ?, ?, ?)`,
    )
    .run(agentId, chatSlug, `id-${threadRef}`, threadRef, lastAt, lastAt)
}

test("a step continues in the agent's mention thread on the task; one in another chat is left", async () => {
  const { env, chats, task, changeAs } = setup()
  mentionSession(env, 'agent_dev', 'old.agent.m0', at('08:00'), 'elsewhere')
  mentionSession(env, 'agent_rev', 'dev.agent.m1', at('09:00'))
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  assert.deepEqual(
    chats.sent.map((s) => [s.kind, s.kind === 'start' ? s.agentNodeId : s.target]),
    [
      ['start', 'agent_dev'],
      ['send', 'dev.agent.m1'],
    ],
  )
  const review = activeRunForTask(env.db, 'TASK', 1)?.steps[1]
  assert.deepEqual([review?.threadRef, review?.threadId, review?.chatSlug], ['dev.agent.m1', 'id-dev.agent.m1', 'dev'])
})

test('a step sent back returns to its own thread even when its agent has used another on the task since', async () => {
  const { env, chats, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  // Development has its own thread, and a mention has since opened a newer one for the same agent.
  mentionSession(env, 'agent_dev', 'dev.agent.m9', at('23:00'))
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', summary: 'again', actor: REV })
  const back = chats.sent.at(-1)
  assert.deepEqual([back?.target, back?.queue], ['dev.agent.t1', 'wait'])
  assert.match(back?.message ?? '', /back at Development/)
})

test('a host without archiving closes the task with no warning and ends the run', async () => {
  const { env, chats, task, changeAs, warnings } = setup()
  chats.archive = undefined
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 4 })
  assert.deepEqual(warnings, [])
  assert.equal(activeRunForTask(env.db, 'TASK', 1), null)
})

test('cancelling ends the run, closes the open step and tells its session to stop', async () => {
  const { env, task, changeAs, chats } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  const run = await cancelRun(env, { task: task(), actor: PERSON })
  assert.equal(run.state, 'cancelled')
  assert.equal(run.steps[0]?.outcome, 'Cancelled')
  assert.match(chats.sent.at(-1)?.message ?? '', /cancelled by user/)
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.ok(activeRunForTask(env.db, 'TASK', 1), 'the task can run a workflow again')
})

/** Every round recorded, in the order it was entered. */
function rounds(env: EngineEnv) {
  return env.db
    .prepare(
      `SELECT s.name, o.round_no, o.worker_kind, o.worker_name, o.ended_by, o.outcome, o.attention
       FROM workflow_run_round o JOIN workflow_run_step s ON s.run_id = o.run_id AND s.step_id = o.step_id
       ORDER BY o.rowid`,
    )
    .all()
    .map((r) => Object.values(r))
}

test('each entry into a step is a round: ended by the move out, a second one after rework, and by a cancel', async () => {
  const { env, task, changeAs } = setup()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'In Progress', actor: REV })
  await restartStep(env, changeAs(PERSON), { task: task(), step: 'development', actor: PERSON })
  await cancelRun(env, { task: task(), actor: PERSON })
  assert.deepEqual(rounds(env), [
    ['Development', 1, 'agent', 'Dev', 'transition', 'In Review', 0],
    ['Review', 1, 'agent', 'Rev', 'transition', 'In Progress', 0],
    // The restart in place continued round 2 rather than starting a third.
    ['Development', 2, 'agent', 'Dev', 'cancel', 'Cancelled', 0],
  ])
})

test('a round counts each time its step could not proceed, and a person it waits on works it', async () => {
  const refused = setup({ refuse: true })
  await startWorkflow(refused.env, refused.changeAs(PERSON), { task: refused.task(), actor: PERSON })
  await restartStep(refused.env, refused.changeAs(PERSON), { task: refused.task(), step: 'development', actor: PERSON }).catch(() => {})
  assert.deepEqual(rounds(refused.env), [['Development', 1, 'agent', 'Dev', null, null, 2]])

  const nobody = setup({ assignee: null })
  await startWorkflow(nobody.env, nobody.changeAs(PERSON), { task: nobody.task(), actor: PERSON })
  assert.deepEqual(rounds(nobody.env), [['Development', 1, null, null, null, null, 1]])

  const person = setup({ assignee: { kind: 'person', name: 'Ada' } })
  await startWorkflow(person.env, person.changeAs(PERSON), { task: person.task(), actor: PERSON })
  await person.changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 3 })
  assert.deepEqual(rounds(person.env)[0], ['Development', 1, 'person', 'Ada', 'transition', 'In Review', 0])
})

test('a run starts on the step for the current status without moving the task', async () => {
  const { env, task, changeAs, db } = setup()
  db.prepare('UPDATE task SET status_id = 3 WHERE number = 1').run()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  assert.equal(task().status.name, 'In Review')
  const steps = activeRunForTask(env.db, 'TASK', 1)?.steps ?? []
  assert.deepEqual(
    steps.map((s) => s.state),
    ['pending', 'active'],
  )
})

// ─── The inbox ─────────────────────────────────────────────────────────────

function withInbox(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts)
  const drafts: NotificationDraft[] = []
  ctx.env.inbox = async (draft) => {
    drafts.push(draft)
  }
  const told = () => drafts.map((d) => [d.kind, d.step?.name ?? d.workflow?.name, d.recipients, d.actor?.name ?? null])
  return { ...ctx, drafts, told }
}

test('the inbox hears each step open for its agent, and the run finishing for whoever started it', async () => {
  const { env, task, changeAs, told, drafts } = withInbox()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'In Review', actor: DEV })
  await finishStep(env, changeAs(REV), { task: task(), transition: 'Done', actor: REV })
  assert.deepEqual(told(), [
    ['step_open', 'Development', [{ kind: 'agent', id: 'agent_dev', name: 'Dev' }], 'user'],
    ['step_open', 'Review', [{ kind: 'agent', id: 'agent_rev', name: 'Rev' }], 'Dev'],
    ['workflow_finished', 'Standard', [{ kind: 'person', name: 'user' }], 'Rev'],
  ])
  assert.deepEqual(drafts.at(-1)?.to, { name: 'Done', category: 'done', color: null })
})

test('the inbox hears a step waiting on a person, and a step that needs attention with the reason', async () => {
  const person = withInbox({ assignee: { kind: 'person', name: 'Ada' } })
  await startWorkflow(person.env, person.changeAs(PERSON), { task: person.task(), actor: PERSON })
  assert.deepEqual(person.told(), [['step_waiting', 'Development', ['assignee'], 'user']])

  const nobody = withInbox({ assignee: null })
  await startWorkflow(nobody.env, nobody.changeAs(PERSON), { task: nobody.task(), actor: PERSON })
  assert.deepEqual(nobody.told(), [['step_attention', 'Development', [{ kind: 'person', name: 'user' }, 'reporter'], null]])
  assert.match(nobody.drafts[0]?.excerpt ?? '', /Nobody is assigned/)

  const refused = withInbox({ outsider: true })
  await startWorkflow(refused.env, refused.changeAs(PERSON), { task: refused.task(), actor: PERSON })
  assert.deepEqual(refused.told(), [['step_attention', 'Development', [{ kind: 'person', name: 'user' }, 'reporter'], null]])
  assert.match(refused.drafts[0]?.excerpt ?? '', /isn't in this space's chat \("dev"\)/)
})

test('the inbox hears a cancelled run, and a failing inbox never fails the run', async () => {
  const { env, task, changeAs, told } = withInbox()
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await cancelRun(env, { task: task(), actor: REV })
  assert.deepEqual(told().at(-1), ['workflow_cancelled', 'Standard', [{ kind: 'person', name: 'user' }], 'Rev'])

  const broken = setup()
  broken.env.inbox = async () => {
    throw new Error('disk full')
  }
  const run = await startWorkflow(broken.env, broken.changeAs(PERSON), { task: broken.task(), actor: PERSON })
  assert.equal(run.steps[0]?.state, 'active')
  assert.deepEqual(broken.warnings, [])
})

// ─── Approval steps ────────────────────────────────────────────────────────

const ALICE = { id: 'person-alice', name: 'Alice' }
const BOB = { id: 'person-bob', name: 'Bob' }
const CAROL = { id: 'person-carol', name: 'Carol' }
const as = (p: { name: string }): Actor => ({ kind: 'person', name: p.name })

/**
 * Development, then a Sign-off decided by Alice (required), Bob and Carol, two
 * approvals needed: Approve finishes the run in Done, Rework sends the task
 * back to Development. `extra` adds transitions to Sign-off, `after` steps after it.
 */
function approvalSetup(extra: WorkflowStepDraft['transitions'] = [], after: WorkflowStepDraft[] = []) {
  const ctx = withInbox({
    steps: [
      { name: 'Development', triggerStatus: 2, worker: { kind: 'assignee' }, instructions: 'Implement {{ task.key }}', transitions: [3] },
      {
        name: 'Sign-off',
        kind: 'approval',
        triggerStatus: 3,
        approval: {
          approvers: [
            { personId: ALICE.id, name: ALICE.name, required: true },
            { personId: BOB.id, name: BOB.name },
            { personId: CAROL.id, name: CAROL.name },
          ],
          needed: 2,
        },
        transitions: [{ label: 'Approve', status: 4 }, { label: 'Rework', status: 2 }, ...extra],
      },
      ...after,
    ],
  })
  const decide = (person: { id: string; name: string }, verdict: 'approve' | 'reject', more: { transition?: string; comment?: string } = {}) =>
    decideStep(ctx.env, ctx.changeAs(as(person)), { task: ctx.task(), verdict, person, ...more })
  /** Start, and let Development hand the task to Sign-off. */
  const reachSignOff = async () => {
    await startWorkflow(ctx.env, ctx.changeAs(PERSON), { task: ctx.task(), actor: PERSON })
    await finishStep(ctx.env, ctx.changeAs(DEV), { task: ctx.task(), transition: 'On to Sign-off', summary: 'Patched', actor: DEV })
  }
  const signOff = () => activeRunForTask(ctx.env.db, 'TASK', 1)?.steps.find((s) => s.name === 'Sign-off') ?? null
  return { ...ctx, decide, reachSignOff, signOff }
}

test('an approval step opens no session: it waits on its approvers, each of whom is asked', async () => {
  const { env, chats, reachSignOff, signOff, told } = approvalSetup()
  await reachSignOff()
  assert.equal(chats.sent.length, 1, "only Development's session opened")
  const step = signOff()
  assert.deepEqual([step?.state, step?.error, step?.agentName, step?.threadRef], ['waiting', null, null, null])
  assert.deepEqual(step?.rounds.map((r) => [r.worker, r.decisions]), [[null, []]])
  assert.deepEqual(told().at(-1), [
    'approval_requested',
    'Sign-off',
    [ALICE, BOB, CAROL].map((p) => ({ kind: 'person', id: p.id, name: p.name })),
    'Dev',
  ])
  assert.equal(activeRunForTask(env.db, 'TASK', 1)?.steps.find((s) => s.name === 'Sign-off')?.rounds[0]?.usage, null)
})

test('while an approval step is open no agent moves the task or finishes the step; a person still can on the board', async () => {
  const { env, task, changeAs, reachSignOff, signOff } = approvalSetup()
  await reachSignOff()
  await assert.rejects(changeAs(DEV).changeStatus({ key: 'TASK-1', status: 4 }), /waits on the approvers of "Sign-off": only people can move it/)
  await assert.rejects(
    finishStep(env, changeAs(REV), { task: task(), transition: 'Approve', actor: REV }),
    /"Sign-off" is an approval step: its approvers decide it from the task, with workflow_step_decide/,
  )
  await assert.rejects(
    finishStep(env, changeAs(PERSON), { task: task(), transition: 'Approve', actor: PERSON }),
    /is an approval step/,
  )
  assert.equal(task().status.name, 'In Review')
  await changeAs(PERSON).changeStatus({ key: 'TASK-1', status: 4 })
  assert.deepEqual([task().status.name, signOff()], ['Done', null], 'the board override ends the run')
})

test('the step passes once every required approver has approved and the approvals reach the number needed', async () => {
  const { env, task, decide, reachSignOff, signOff } = approvalSetup()
  await reachSignOff()
  await decide(BOB, 'approve')
  await decide(CAROL, 'approve', { comment: 'Fine by me' })
  assert.equal(task().status.name, 'In Review', 'two approvals, but the required approver has not approved')
  assert.equal(signOff()?.state, 'waiting')
  await decide(ALICE, 'approve', { comment: 'Ship it' })
  assert.equal(task().status.name, 'Done')
  const run = runsForTask(env.db, 'TASK', 1)[0]!
  assert.equal(run.state, 'finished')
  const step = run.steps.find((s) => s.name === 'Sign-off')!
  assert.deepEqual([step.state, step.outcome, step.summary, step.finishedBy], ['done', 'Done', 'Ship it', 'Alice'])
  const round = step.rounds[0]!
  assert.deepEqual([round.transition, round.gate, round.endedBy], ['Approve', 'pass', 'transition'])
  assert.deepEqual(
    round.decisions.map((d) => [d.approver, d.verdict, d.transition, d.comment]),
    [
      [{ personId: BOB.id, name: 'Bob' }, 'approve', 'Approve', null],
      [{ personId: CAROL.id, name: 'Carol' }, 'approve', 'Approve', 'Fine by me'],
      [{ personId: ALICE.id, name: 'Alice' }, 'approve', 'Approve', 'Ship it'],
    ],
  )
  assert.ok(round.decisions.every((d) => d.at === '2026-09-26T06:00:00.000Z'))
})

test("any one Reject rejects the step, an optional approver's included: the task goes back with the comment as the reason", async () => {
  const { env, chats, task, decide, reachSignOff } = approvalSetup()
  await reachSignOff()
  await decide(ALICE, 'approve')
  await decide(CAROL, 'reject', { comment: 'The login still returns 500' })
  assert.equal(task().status.name, 'In Progress')
  const run = activeRunForTask(env.db, 'TASK', 1)!
  const [dev, signOff] = run.steps
  assert.deepEqual([dev?.state, dev?.attempts], ['active', 2])
  assert.deepEqual([signOff?.state, signOff?.finishedBy, signOff?.rounds[0]?.transition, signOff?.rounds[0]?.gate], ['done', 'Carol', 'Rework', 'fail'])
  assert.match(chats.sent.at(-1)?.message ?? '', /The login still returns 500/, "Development's rework message quotes the reason")
})

test('a step re-entered after rework starts a round with no decisions', async () => {
  const { env, task, changeAs, decide, reachSignOff, signOff } = approvalSetup()
  await reachSignOff()
  await decide(BOB, 'reject')
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'On to Sign-off', actor: DEV })
  const step = signOff()
  assert.deepEqual([step?.state, step?.attempts], ['waiting', 2])
  assert.deepEqual(step?.rounds.map((r) => [r.roundNo, r.decisions.length]), [
    [1, 1],
    [2, 0],
  ])
})

test('an approver may change their decision until the round settles; the changed one counts as made last', async () => {
  const { decide, reachSignOff, signOff, task } = approvalSetup()
  await reachSignOff()
  await decide(BOB, 'approve', { comment: 'ok' })
  await decide(CAROL, 'approve')
  await decide(BOB, 'approve', { comment: 'ok, re-read it' })
  assert.deepEqual(
    signOff()?.rounds[0]?.decisions.map((d) => [d.approver.name, d.comment]),
    [
      ['Carol', null],
      ['Bob', 'ok, re-read it'],
    ],
  )
  assert.equal(task().status.name, 'In Review')
})

test('with several transitions for a verdict the approver chooses one, and the settling decision takes its own choice', async () => {
  const { env, task, decide, reachSignOff } = approvalSetup([{ label: 'Park', status: 1, toStep: 'end', gate: 'fail' }])
  await reachSignOff()
  await assert.rejects(decide(BOB, 'reject'), /"Sign-off" can reject by several transitions: pass "transition" as one of "Rework", "Park"/)
  await assert.rejects(decide(BOB, 'reject', { transition: 'Approve' }), /"Approve" is not a way to reject "Sign-off"; choose one of: "Rework", "Park"/)
  assert.deepEqual(activeRunForTask(env.db, 'TASK', 1)?.steps[1]?.rounds[0]?.decisions, [], 'a refused decision is not recorded')
  await decide(BOB, 'reject', { transition: 'park' })
  assert.equal(task().status.name, 'To Do')
  const run = runsForTask(env.db, 'TASK', 1)[0]!
  assert.deepEqual([run.state, run.steps[1]?.rounds[0]?.transition, run.steps[1]?.rounds[0]?.gate], ['finished', 'Park', 'fail'])
})

test("an agent's restart cannot close an open approval step, in place or by a move; a person's can, and the approval step itself restarts", async () => {
  // Docs shares Sign-off's trigger status, so restarting it re-enters in place and would close Sign-off.
  const docs: WorkflowStepDraft = { name: 'Docs', triggerStatus: 3, worker: { kind: 'assignee' }, instructions: 'Document {{ task.key }}', transitions: [4] }
  const { env, task, changeAs, reachSignOff, signOff, told } = approvalSetup([], [docs])
  await reachSignOff()
  await assert.rejects(
    restartStep(env, changeAs(DEV), { task: task(), step: 'Docs', actor: DEV }),
    /TASK-1 waits on the approvers of "Sign-off": only people can move it on until they decide/,
  )
  await assert.rejects(restartStep(env, changeAs(DEV), { task: task(), step: 'Development', actor: DEV }), /waits on the approvers of "Sign-off"/)
  assert.deepEqual([task().status.name, signOff()?.state, signOff()?.rounds.length], ['In Review', 'waiting', 1])

  await restartStep(env, changeAs(DEV), { task: task(), step: 'Sign-off', actor: DEV })
  assert.deepEqual([signOff()?.state, signOff()?.rounds.length], ['waiting', 1], 'restarted in place, the round continues')
  assert.equal(told().filter(([kind]) => kind === 'approval_requested').length, 2, 'the approvers are asked again')

  await restartStep(env, changeAs(PERSON), { task: task(), step: 'Docs', actor: PERSON })
  assert.deepEqual([signOff()?.state, signOff()?.rounds[0]?.transition], ['done', null], "a person's restart closes it, with no transition taken")
})

test('an agent may cancel a run waiting on its approvers, and the run records who cancelled it', async () => {
  const { env, task, reachSignOff, told } = approvalSetup()
  await reachSignOff()
  await cancelRun(env, { task: task(), actor: DEV })
  const run = runsForTask(env.db, 'TASK', 1)[0]!
  const step = run.steps.find((s) => s.name === 'Sign-off')!
  assert.deepEqual([run.state, step.state, step.outcome, step.finishedBy, step.rounds[0]?.endedBy], ['cancelled', 'done', 'Cancelled', 'Dev', 'cancel'])
  assert.equal(task().status.name, 'In Review', 'cancelling moves nothing')
  assert.deepEqual(told().at(-1), ['workflow_cancelled', 'Standard', [{ kind: 'person', name: 'user' }], 'Dev'])
})

test('a settling decision moves the task only by the transition it chose; one the workflow no longer has is refused, not replaced', async () => {
  const { env, db, wf, task, decide, reachSignOff } = approvalSetup()
  await reachSignOff()
  // The move Alice's Reject settles fails, so her decision stays on the open round.
  const refusing: TaskPort = {
    async changeStatus() {
      throw new Error('the store is read-only')
    },
  }
  await assert.rejects(decideStep(env, refusing, { task: task(), verdict: 'reject', person: ALICE }), /the store is read-only/)
  // Rework is replaced by a new transition to the same place.
  const statuses = db.prepare('SELECT id, name FROM status').all() as Array<{ id: number; name: string }>
  saveWorkflow(
    db,
    normalizeDraft(
      {
        id: wf.id,
        name: wf.name,
        steps: wf.steps.map((s) => (s.name === 'Sign-off' ? { ...s, transitions: [s.transitions[0]!, { label: 'Back to work', status: 2 }] } : s)),
      },
      mintId,
      statuses,
    ),
    '2026-09-26T06:00:00.000Z',
  )
  await assert.rejects(decide(BOB, 'approve'), /"Rework", which Alice chose, is no longer a way to reject "Sign-off": Alice must decide again/)
  assert.equal(task().status.name, 'In Review', 'no other transition was taken in its place')
  await decide(ALICE, 'reject')
  assert.equal(task().status.name, 'In Progress')
  const round = runsForTask(env.db, 'TASK', 1)[0]?.steps.find((s) => s.name === 'Sign-off')?.rounds[0]
  assert.deepEqual([round?.transition, round?.gate], ['Back to work', 'fail'])
})

test('only the approvers decide, only as signed-in people, and only an open approval step', async () => {
  const { env, task, changeAs, decide } = approvalSetup()
  await assert.rejects(decide(ALICE, 'approve'), /TASK-1 is not running a workflow/)
  await startWorkflow(env, changeAs(PERSON), { task: task(), actor: PERSON })
  await assert.rejects(decide(ALICE, 'approve'), /"Development" of TASK-1 is not an approval step/)
  await finishStep(env, changeAs(DEV), { task: task(), transition: 'On to Sign-off', actor: DEV })
  await assert.rejects(decide({ id: 'person-dave', name: 'Dave' }, 'approve'), /You aren't an approver of "Sign-off". Its approvers: Alice, Bob, Carol/)
  await assert.rejects(
    decideStep(env, changeAs(DEV), { task: task(), verdict: 'approve', person: null }),
    /Only a person can approve or reject/,
  )
})
