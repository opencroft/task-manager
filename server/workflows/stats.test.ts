import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { RunsMatch, StepStats } from '../../shared/workflows.ts'
import { allMigrations, type Db, migrate } from '../db.ts'
import { normalizeDraft } from './definition.ts'
import { workflowStats } from './stats.ts'
import { matchingRunIds } from './stats-flow.ts'
import { mintId, roundNeedsAttention, saveWorkflow } from './store.ts'

const NOW = '2026-09-26T12:00:00.000Z'
const MIN = 60_000
/** An ISO time `days` days and `minutes` minutes before NOW. */
const ago = (days: number, minutes = 0) => new Date(Date.parse(NOW) - days * 86_400_000 - minutes * MIN).toISOString()
const after = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MIN).toISOString()

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, allMigrations())
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', '', 1, 'person', 'user', 'a', ?, ?)`,
  ).run(NOW, NOW)
  const wf = saveWorkflow(
    db,
    normalizeDraft(
      {
        name: 'Standard',
        steps: [
          { name: 'Development', triggerStatus: 2, worker: { kind: 'assignee' }, instructions: '', transitions: [3] },
          { name: 'Review', triggerStatus: 3, worker: { kind: 'assignee' }, instructions: '', transitions: [4, 2] },
        ],
      },
      mintId,
      [],
    ),
    NOW,
  )
  const dev = wf.steps[0]
  const review = wf.steps[1]
  let n = 0
  /** A run of the workflow on task 1, started at `start`, ended `minutes` later unless still active. */
  const run = (start: string, state: 'active' | 'finished' | 'cancelled', minutes = 0) => {
    n += 1
    const id = `run-${n}`
    db.prepare(
      `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at, ended_at)
       VALUES (?, 1, ?, 'Standard', ?, 'person', 'user', ?, ?)`,
    ).run(id, wf.id, state, start, state === 'active' ? null : after(start, minutes))
    return id
  }
  /** One round: `minutes` long when it ended, open when `end` is null. */
  const round = (
    runId: string,
    stepId: string,
    no: number,
    worker: [string, string] | null,
    start: string,
    end: { minutes: number; by: 'transition' | 'cancel' } | null,
    attention = 0,
  ) =>
    db
      .prepare(
        `INSERT INTO workflow_run_round (run_id, step_id, round_no, worker_kind, worker_name, started_at, ended_at, ended_by, outcome, attention)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        stepId,
        no,
        worker?.[0] ?? null,
        worker?.[1] ?? null,
        start,
        end ? after(start, end.minutes) : null,
        end?.by ?? null,
        end ? 'x' : null,
        attention,
      )
  return { db: db as Db, wf, dev: dev.id, review: review.id, run, round }
}

const times = (steps: StepStats[]) =>
  steps.map((s) => [s.name, s.entered, s.reworked, s.couldntStart.total, s.time.samples, s.time.median, s.time.p90])

const NO_USAGE = { pending: 0, shared: 0, tokens: { samples: 0, median: null, p90: null, sum: 0 }, cost: [] }

/** Record a round's usage the way the engine does: tokens in total, cost per currency. */
function spent(
  db: Db,
  runId: string,
  stepId: string,
  no: number,
  state: 'pending' | 'settled',
  tokens: number,
  cost: Array<[number, string]>,
) {
  db.prepare(
    `UPDATE workflow_run_round SET thread_ref = 't', usage_state = ?, usage_turns = 1, tokens_input = ?, tokens_output = 0,
       tokens_cache_read = 0, tokens_cache_write = 0, tokens_total = ?, cost = ?
     WHERE run_id = ? AND step_id = ? AND round_no = ?`,
  ).run(
    state,
    tokens,
    tokens,
    JSON.stringify(cost.map(([amount, currency]) => ({ amount, currency }))),
    runId,
    stepId,
    no,
  )
}

test('usage per step, per agent and overall: settled rounds the task left are measured, pending ones counted, the rest left out', () => {
  const { db, wf, dev, review, run, round } = setup()
  // Five settled Development rounds by Dev: 100..500 tokens, 0.1..0.5 USD.
  for (let i = 1; i <= 5; i++) {
    const id = run(ago(1, i * 10), 'finished', 5)
    round(id, dev, 1, ['agent', 'Dev'], ago(1, i * 10), { minutes: 2, by: 'transition' })
    spent(db, id, dev, 1, 'settled', i * 100, [[i / 10, 'USD']])
  }
  const other = run(ago(1, 90), 'active')
  // Still waiting for its finishing turn: counted as pending, not measured.
  round(other, dev, 1, ['agent', 'Dev'], ago(1, 90), { minutes: 2, by: 'transition' })
  spent(db, other, dev, 1, 'pending', 9_000, [[9, 'USD']])
  // A cancelled round is not measured, as for times.
  round(other, review, 1, ['agent', 'Rev'], ago(1, 80), { minutes: 1, by: 'cancel' })
  spent(db, other, review, 1, 'settled', 7_000, [[7, 'USD']])
  // A person's round has no usage at all.
  const byPerson = run(ago(1, 70), 'finished', 5)
  round(byPerson, review, 1, ['person', 'Sam'], ago(1, 70), { minutes: 3, by: 'transition' })
  // A round priced in another currency is a sample of that currency only.
  round(byPerson, dev, 1, ['agent', 'Dev'], ago(1, 75), { minutes: 1, by: 'transition' })
  spent(db, byPerson, dev, 1, 'settled', 50, [[2, 'EUR']])

  const stats = workflowStats(db, wf, 'all', NOW)
  const developmentStep = stats.steps.find((s) => s.name === 'Development')
  assert.ok(developmentStep)
  const development = developmentStep.usage
  assert.equal(development.pending, 1)
  assert.deepEqual(development.tokens, { samples: 6, median: 200, p90: null, sum: 1_550 })
  assert.deepEqual(development.cost, [
    { currency: 'EUR', samples: 1, median: null, p90: null, sum: 2 },
    { currency: 'USD', samples: 5, median: 0.3, p90: null, sum: 1.5 },
  ])
  const reviewStep = stats.steps.find((s) => s.name === 'Review')
  assert.ok(reviewStep)
  assert.deepEqual(reviewStep.usage, NO_USAGE, 'cancelled and person rounds are not measured')
  assert.equal(stats.usage.pending, 1)
  assert.equal(stats.usage.tokens.sum, 1_550)

  const dev_ = stats.agents.find((a) => a.agent.name === 'Dev')
  assert.ok(dev_)
  const devAgentStep = dev_.steps.find((s) => s.name === 'Development')
  assert.ok(devAgentStep)
  assert.equal(devAgentStep.usage.tokens.sum, 1_550)
  const sam = stats.agents.find((a) => a.agent.name === 'Sam')
  assert.ok(sam)
  const samReviewStep = sam.steps.find((s) => s.name === 'Review')
  assert.ok(samReviewStep)
  assert.deepEqual(samReviewStep.usage, NO_USAGE)
})

test('a round that shared a turn with an earlier step is counted as shared, never as a zero sample', () => {
  const { db, wf, dev, review, run, round } = setup()
  const id = run(ago(1, 10), 'finished', 5)
  round(id, dev, 1, ['agent', 'Dev'], ago(1, 10), { minutes: 1, by: 'transition' })
  spent(db, id, dev, 1, 'settled', 400, [[0.4, 'USD']])
  round(id, review, 1, ['agent', 'Dev'], ago(1, 9), { minutes: 1, by: 'transition' })
  spent(db, id, review, 1, 'settled', 0, [])
  db.prepare("UPDATE workflow_run_round SET usage_shared_with = 'Development' WHERE run_id = ? AND step_id = ?").run(
    id,
    review,
  )

  const stats = workflowStats(db, wf, 'all', NOW)
  const reviewStep = stats.steps.find((s) => s.name === 'Review')
  assert.ok(reviewStep)
  assert.deepEqual(reviewStep.usage, { ...NO_USAGE, shared: 1 })
  assert.deepEqual([stats.usage.shared, stats.usage.tokens.samples, stats.usage.tokens.sum], [1, 1, 400])
  const byDev = stats.agents.find((a) => a.agent.name === 'Dev')
  assert.ok(byDev)
  const byDevReviewStep = byDev.steps.find((s) => s.name === 'Review')
  assert.ok(byDevReviewStep)
  assert.deepEqual(byDevReviewStep.usage, { ...NO_USAGE, shared: 1 })
})

test('the range counts runs started inside it, with every round of them, and all counts everything', () => {
  const { db, wf, dev, run, round } = setup()
  const recent = run(ago(2), 'finished', 60)
  round(recent, dev, 1, ['agent', 'Tom'], ago(2), { minutes: 60, by: 'transition' })
  // Started 40 days ago and finished yesterday: outside 30 days, whatever its end.
  const old = run(ago(40), 'finished', 39 * 24 * 60)
  round(old, dev, 1, ['agent', 'Tom'], ago(40), { minutes: 30, by: 'transition' })

  const month = workflowStats(db, wf, '30d', NOW)
  assert.deepEqual(month.runs, { started: 1, finished: 1, cancelled: 0, active: 0 })
  assert.deepEqual(times(month.steps), [
    ['Development', 1, 0, 0, 1, null, null],
    ['Review', 0, 0, 0, 0, null, null],
  ])
  const all = workflowStats(db, wf, 'all', NOW)
  assert.equal(all.runs.started, 2)
  assert.equal(all.steps[0]?.entered, 2)
  assert.equal(workflowStats(db, wf, '7d', NOW).runs.started, 1)
})

test('run time is over finished runs only: no median from 4, the 3rd of 5 from 5, a 90th percentile only from 10', () => {
  const { db, wf, run } = setup()
  for (const minutes of [40, 10, 30, 20]) {
    run(ago(1), 'finished', minutes)
  }
  run(ago(1), 'cancelled', 500)
  run(ago(1), 'active')
  const four = workflowStats(db, wf, '30d', NOW)
  assert.deepEqual(four.runs, { started: 6, finished: 4, cancelled: 1, active: 1 })
  assert.deepEqual(four.runTime, { samples: 4, median: null, p90: null }, 'too few to tell, and the count stays exact')
  assert.deepEqual(four.minSamples, { median: 5, p90: 10 })

  run(ago(1), 'finished', 50)
  assert.deepEqual(workflowStats(db, wf, '30d', NOW).runTime, { samples: 5, median: 30 * MIN, p90: null })
})

test('nearest rank over ten rounds: the median is the 5th, the 90th percentile the 9th', () => {
  const { db, wf, dev, run, round } = setup()
  for (let minutes = 1; minutes <= 10; minutes++) {
    round(run(ago(1), 'finished', minutes), dev, 1, null, ago(1), { minutes, by: 'transition' })
  }
  assert.deepEqual(workflowStats(db, wf, '30d', NOW).steps[0]?.time, { samples: 10, median: 5 * MIN, p90: 9 * MIN })
})

test("a step counts runs that reached it and came back, the times it couldn't start, and times only rounds the task left", () => {
  const { db, wf, dev, review, run, round } = setup()
  const a = run(ago(3), 'finished', 200)
  round(a, dev, 1, ['agent', 'Tom'], ago(3), { minutes: 40, by: 'transition' })
  round(a, review, 1, ['agent', 'Rev'], ago(3), { minutes: 10, by: 'transition' }, 1)
  round(a, dev, 2, ['agent', 'Tom'], ago(3), { minutes: 20, by: 'transition' })
  const b = run(ago(2), 'cancelled', 90)
  round(b, dev, 1, ['agent', 'Max'], ago(2), { minutes: 90, by: 'cancel' }, 2)
  const c = run(ago(1), 'active')
  round(c, dev, 1, null, ago(1), null, 1)

  const stats = workflowStats(db, wf, '30d', NOW)
  assert.deepEqual(times(stats.steps), [
    // Three runs reached it, one came back; a cancelled and an open round are not timed,
    // so 2 samples of 4 rounds, and too few for a median either way.
    ['Development', 3, 1, 3, 2, null, null],
    ['Review', 1, 0, 1, 1, null, null],
  ])
})

test('agents repeat the step figures over their own rounds, agents before people, and only for current steps', () => {
  const { db, wf, dev, review, run, round } = setup()
  const a = run(ago(3), 'finished', 200)
  round(a, dev, 1, ['agent', 'Tom'], ago(3), { minutes: 40, by: 'transition' })
  round(a, review, 1, ['person', 'Sam'], ago(3), { minutes: 300, by: 'transition' })
  round(a, dev, 2, ['agent', 'Max'], ago(3), { minutes: 20, by: 'transition' })
  // A step since removed from the workflow, and a round nobody could work: neither is listed.
  round(a, 'removed-step', 1, ['agent', 'Gone'], ago(3), { minutes: 5, by: 'transition' })
  round(run(ago(1), 'active'), dev, 1, null, ago(1), null, 1)

  const stats = workflowStats(db, wf, '30d', NOW)
  assert.deepEqual(
    stats.agents.map((a) => [a.agent.kind, a.agent.name, times(a.steps)]),
    [
      ['agent', 'Max', [['Development', 1, 1, 0, 1, null, null]]],
      ['agent', 'Tom', [['Development', 1, 0, 0, 1, null, null]]],
      ['person', 'Sam', [['Review', 1, 0, 0, 1, null, null]]],
    ],
  )
  assert.deepEqual(
    stats.steps.map((s) => s.name),
    ['Development', 'Review'],
    'the removed step is not a row',
  )
})

test('a workflow that never ran answers zeros for counts and nothing measured', () => {
  const { db, wf } = setup()
  assert.deepEqual(workflowStats(db, wf, 'all', NOW), {
    range: 'all',
    minSamples: { median: 5, p90: 10 },
    runs: { started: 0, finished: 0, cancelled: 0, active: 0 },
    runTime: { samples: 0, median: null, p90: null },
    firstPass: { finished: 0, firstPass: 0 },
    throughput: { bucket: 'week', points: [] },
    steps: wf.steps.map((s) => ({
      stepId: s.id,
      name: s.name,
      entered: 0,
      reworked: 0,
      rounds: 0,
      exits: { movedOn: 0, sentBack: [], other: 0, cancelled: 0, open: 0 },
      roundsPerRun: [0, 0, 0, 0],
      couldntStart: { total: 0, reasons: [] },
      time: { samples: 0, median: null, p90: null },
      finishedTimeMs: 0,
      usage: NO_USAGE,
      spend: { first: { tokens: 0, cost: [] }, rework: { tokens: 0, cost: [] } },
    })),
    usage: NO_USAGE,
    agents: [],
  })
})

test('runs from before rounds were recorded keep one round per reached step, numbered by its attempts', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // Held back with the later ones that alter the table it creates.
  const later = [
    'wf-0002-rounds',
    'wf-0003-round-usage',
    'wf-0006-shared-thread-rounds',
    'wf-0007-round-shared-turn',
    'wf-0008-step-session-options',
    'wf-0009-transition-edges',
    'wf-0012-round-context',
  ]
  const before = allMigrations().filter((m) => !later.includes(m.id))
  assert.equal(before.length, allMigrations().length - later.length, 'the rounds migrations are the ones held back')
  migrate(db, before)
  db.prepare(
    `INSERT INTO task (number, summary, description, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
     VALUES (1, 'Fix login', '', 1, 'person', 'user', 'a', ?, ?)`,
  ).run(NOW, NOW)
  const insertRun = db.prepare(
    `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at, ended_at)
     VALUES (?, 1, NULL, 'Standard', ?, 'person', 'user', ?, ?)`,
  )
  insertRun.run('done', 'finished', ago(2), ago(1))
  insertRun.run('stopped', 'cancelled', ago(2), ago(1))
  const step = db.prepare(
    `INSERT INTO workflow_run_step (run_id, step_id, position, name, state, agent_node_id, agent_name, started_at, ended_at, outcome, attempts, error)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  step.run('done', 'dev', 'Development', 'done', 'agent_dev', 'Dev', ago(2), ago(2, -30), 'In Review', 3, null)
  step.run('done', 'qa', 'QA', 'pending', null, null, null, null, null, 0, null)
  step.run('stopped', 'dev', 'Development', 'waiting', null, null, ago(2), ago(1), 'Cancelled', 1, 'Nobody is assigned')

  migrate(db, allMigrations())
  const rounds = db
    .prepare(
      'SELECT run_id, step_id, round_no, worker_kind, worker_name, ended_by, outcome, attention FROM workflow_run_round ORDER BY run_id',
    )
    .all()
    .map((r) => ({ ...r }))
  assert.deepEqual(rounds, [
    {
      run_id: 'done',
      step_id: 'dev',
      round_no: 3,
      worker_kind: 'agent',
      worker_name: 'Dev',
      ended_by: 'transition',
      outcome: 'In Review',
      attention: 0,
    },
    {
      run_id: 'stopped',
      step_id: 'dev',
      round_no: 1,
      worker_kind: null,
      worker_name: null,
      ended_by: 'cancel',
      outcome: 'Cancelled',
      attention: 1,
    },
  ])
})

/** A round left by a transition, as the engine records it: its label and gate. */
function leftBy(db: Db, runId: string, stepId: string, no: number, label: string, gate: 'pass' | 'fail') {
  db.prepare(
    'UPDATE workflow_run_round SET transition_label = ?, gate = ? WHERE run_id = ? AND step_id = ? AND round_no = ?',
  ).run(label, gate, runId, stepId, no)
}

/**
 * Five runs over two steps: `a` sent back once from Review, `b` straight
 * through, `c` cancelled in Development, `d` still in Development, `e` moved
 * on by a status change that was none of Development's transitions.
 */
function closingScenario() {
  const s = setup()
  const { db, dev, review, run, round } = s
  const worker: [string, string] = ['agent', 'agent-a']
  const a = run(ago(3), 'finished', 200)
  round(a, dev, 1, worker, ago(3), { minutes: 40, by: 'transition' })
  leftBy(db, a, dev, 1, 'Ready for review', 'pass')
  round(a, review, 1, worker, ago(3), { minutes: 10, by: 'transition' })
  leftBy(db, a, review, 1, 'Back to Development', 'fail')
  round(a, dev, 2, worker, ago(3), { minutes: 20, by: 'transition' })
  leftBy(db, a, dev, 2, 'Ready for review', 'pass')
  round(a, review, 2, worker, ago(3), { minutes: 15, by: 'transition' })
  leftBy(db, a, review, 2, 'Approve', 'pass')
  const b = run(ago(2), 'finished', 60)
  round(b, dev, 1, worker, ago(2), { minutes: 30, by: 'transition' })
  leftBy(db, b, dev, 1, 'Ready for review', 'pass')
  round(b, review, 1, worker, ago(2), { minutes: 5, by: 'transition' })
  leftBy(db, b, review, 1, 'Approve', 'pass')
  const c = run(ago(2), 'cancelled', 90)
  round(c, dev, 1, worker, ago(2), { minutes: 90, by: 'cancel' })
  const d = run(ago(1), 'active')
  round(d, dev, 1, worker, ago(1), null)
  const e = run(ago(1), 'finished', 10)
  round(e, dev, 1, worker, ago(1), { minutes: 10, by: 'transition' })
  return { ...s, runs: { a, b, c, d, e } }
}

test("how a step's rounds ended, the rounds runs took there, and first-pass runs", () => {
  const { db, wf } = closingScenario()
  const stats = workflowStats(db, wf, '30d', NOW)
  assert.deepEqual(
    stats.steps.map((s) => [s.name, s.rounds, s.exits, s.roundsPerRun]),
    [
      ['Development', 6, { movedOn: 3, sentBack: [], other: 1, cancelled: 1, open: 1 }, [4, 1, 0, 0]],
      [
        'Review',
        3,
        { movedOn: 2, sentBack: [{ transition: 'Back to Development', count: 1 }], other: 0, cancelled: 0, open: 0 },
        [1, 1, 0, 0],
      ],
    ],
  )
  assert.deepEqual(stats.firstPass, { finished: 3, firstPass: 2 }, 'a went through Development twice')
})

test("a step's part of finished runs' time counts only rounds of finished runs", () => {
  const { db, wf } = closingScenario()
  const stats = workflowStats(db, wf, '30d', NOW)
  // Development: a 40 + 20, b 30, e 10; the cancelled and the open round are left out.
  assert.deepEqual(
    stats.steps.map((s) => [s.name, s.finishedTimeMs]),
    [
      ['Development', 100 * MIN],
      ['Review', 30 * MIN],
    ],
  )
})

test('spend splits settled rounds into first rounds and rework, per currency', () => {
  const { db, wf, dev, runs } = closingScenario()
  spent(db, runs.a, dev, 1, 'settled', 1000, [[0.5, 'USD']])
  spent(db, runs.a, dev, 2, 'settled', 400, [[0.25, 'USD']])
  spent(db, runs.b, dev, 1, 'settled', 600, [
    [0.3, 'USD'],
    [0.2, 'EUR'],
  ])
  // Pending usage is no figure yet.
  spent(db, runs.e, dev, 1, 'pending', 9999, [[9, 'USD']])
  const devStats = workflowStats(db, wf, '30d', NOW).steps[0]
  assert.deepEqual(devStats.spend, {
    first: {
      tokens: 1600,
      cost: [
        { currency: 'EUR', amount: 0.2 },
        { currency: 'USD', amount: 0.8 },
      ],
    },
    rework: { tokens: 400, cost: [{ currency: 'USD', amount: 0.25 }] },
  })
})

test("couldn't start counts recorded reasons, and times from before reasons were kept as unrecorded", () => {
  const { db, wf, dev, run, round } = setup()
  const f = run(ago(1), 'active')
  // One time counted before reasons were recorded.
  round(f, dev, 1, null, ago(1), null, 1)
  roundNeedsAttention(db, f, dev, { reason: 'unassigned', message: 'Nobody is assigned', at: ago(1) })
  roundNeedsAttention(db, f, dev, { reason: 'unassigned', message: 'Nobody is assigned', at: ago(1) })
  roundNeedsAttention(db, f, dev, { reason: 'not_in_chat', message: 'Not in the chat', at: ago(1) })
  assert.deepEqual(workflowStats(db, wf, '30d', NOW).steps[0]?.couldntStart, {
    total: 4,
    reasons: [
      { reason: 'unassigned', count: 2 },
      { reason: 'not_in_chat', count: 1 },
      { reason: 'unrecorded', count: 1 },
    ],
  })
  assert.deepEqual(matchingRunIds(db, wf.id, { range: '30d', step: dev, couldntStart: 'unrecorded' }, NOW), [f])
  assert.deepEqual(matchingRunIds(db, wf.id, { range: '30d', step: dev, couldntStart: 'not_in_chat' }, NOW), [f])
  assert.deepEqual(matchingRunIds(db, wf.id, { range: '30d', step: dev, couldntStart: 'session_failed' }, NOW), [])
})

test('the runs a step figure opens are the runs it counted', () => {
  const { db, wf, dev, review, runs } = closingScenario()
  const ids = (match: Omit<RunsMatch, 'range'>) => matchingRunIds(db, wf.id, { range: '30d', ...match }, NOW).sort()
  assert.deepEqual(ids({ step: review, exit: 'sent_back' }), [runs.a])
  assert.deepEqual(ids({ step: review, exit: 'sent_back', transition: 'Back to Development' }), [runs.a])
  assert.deepEqual(ids({ step: review, exit: 'sent_back', transition: 'Approve' }), [])
  assert.deepEqual(ids({ step: dev, exit: 'moved_on' }), [runs.a, runs.b].sort())
  assert.deepEqual(ids({ step: dev, exit: 'other' }), [runs.e])
  assert.deepEqual(ids({ step: dev, exit: 'cancelled' }), [runs.c])
  assert.deepEqual(ids({ step: dev, exit: 'open' }), [runs.d])
  assert.deepEqual(ids({ step: dev, rounds: 2 }), [runs.a])
  assert.deepEqual(ids({ step: dev, rounds: 1 }), [runs.b, runs.c, runs.d, runs.e].sort())
  assert.deepEqual(ids({ step: review, rounds: 4 }), [])
})

test('throughput has every day of a short range and every week of all time, runs counted where they started and ended', () => {
  const { db, wf, run } = setup()
  // NOW is Saturday 2026-09-26, noon UTC.
  run(ago(3), 'finished', 200) // started and finished Wednesday 09-23
  run(ago(2, 1380), 'cancelled', 1440) // started Wednesday 09-23 at 13:00, cancelled a day later
  run(ago(10), 'active') // Wednesday 09-16: outside 7 days, inside all time
  const week = workflowStats(db, wf, '7d', NOW).throughput
  assert.equal(week.bucket, 'day')
  assert.deepEqual(
    week.points.map((p) => p.start),
    ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'],
  )
  assert.deepEqual(
    week.points.filter((p) => p.started + p.finished + p.cancelled > 0),
    [
      { start: '2026-09-23', started: 2, finished: 1, cancelled: 0 },
      { start: '2026-09-24', started: 0, finished: 0, cancelled: 1 },
    ],
  )
  assert.deepEqual(workflowStats(db, wf, 'all', NOW).throughput, {
    bucket: 'week',
    points: [
      { start: '2026-09-14', started: 1, finished: 0, cancelled: 0 },
      { start: '2026-09-21', started: 2, finished: 1, cancelled: 1 },
    ],
  })
})
