import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { migrate } from '../db.ts'
import { changeStatus, createTask, requireRow, type Scope } from '../service.ts'
import { myWork, type Viewer } from './store.ts'

const ADA: Viewer = { kind: 'person', id: 'u-ada', name: 'Ada Lovelace' }
const BOB: Viewer = { kind: 'agent', id: 'n-bob', name: 'Bob' }
const NOW = new Date('2026-09-26T10:00:00Z')

function makeScope(): Scope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return {
    db,
    instanceId: 'inst-1',
    projectKey: 'TASK',
    inv: { ctx: {} as never, actor: { kind: 'person', name: 'Grace' } },
    notify: () => {},
    agents: async () => [{ id: 'n-bob', name: 'Bob' }],
    people: async () => [
      { id: 'u-ada', name: 'Ada Lovelace' },
      { id: 'u-grace', name: 'Grace' },
    ],
  }
}

async function task(scope: Scope, summary: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await createTask(scope, { summary, ...extra })).result.key
}

let runs = 0

/** An active run on `key` whose one step is open in `state`, its open round worked by `worker`. */
function openStep(
  scope: Scope,
  key: string,
  step: {
    state: 'active' | 'waiting'
    worker: 'agent' | 'person' | null
    agentNodeId?: string
    agentName?: string
    error?: string
  },
  startedBy: { kind: 'agent' | 'person'; name: string } = { kind: 'person', name: 'Grace' },
  at = '2026-09-26T08:00:00.000Z',
): string {
  const run = `run-${++runs}`
  scope.db
    .prepare(
      `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at)
       VALUES (?, ?, NULL, 'Development', 'active', ?, ?, ?)`,
    )
    .run(run, requireRow(scope, key).id, startedBy.kind, startedBy.name, at)
  scope.db
    .prepare(
      `INSERT INTO workflow_run_step (run_id, step_id, position, name, state, agent_node_id, agent_name, chat_ref, thread_id, started_at, error)
       VALUES (?, 'st-1', 0, 'Implement', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run,
      step.state,
      step.agentNodeId ?? null,
      step.agentName ?? null,
      step.agentNodeId ? 'dev-chat' : null,
      step.agentNodeId ? 'th-1' : null,
      at,
      step.error ?? null,
    )
  scope.db
    .prepare(
      `INSERT INTO workflow_run_round (run_id, step_id, round_no, worker_kind, worker_name, started_at)
       VALUES (?, 'st-1', 1, ?, ?, ?)`,
    )
    .run(run, step.worker, step.worker ? (step.agentName ?? 'Ada Lovelace') : null, at)
  return run
}

test('assigned lists the viewer’s tasks that are not done, by id or by name where no id was kept', async () => {
  const scope = makeScope()
  const late = await task(scope, 'Ends first', {
    assignee: { kind: 'person', id: 'u-ada' },
    startDate: '2026-09-18',
    endDate: '2026-09-20',
  })
  const undated = await task(scope, 'No end date', { assignee: { kind: 'person', id: 'u-ada' } })
  const soon = await task(scope, 'Ends later', {
    assignee: { kind: 'person', id: 'u-ada' },
    startDate: '2026-09-29',
    endDate: '2026-10-01',
  })
  const byName = await task(scope, 'Assigned by name', { assignee: { kind: 'person', name: 'ada lovelace' } })
  scope.db.prepare('UPDATE task SET assignee_id = NULL WHERE number = ?').run(requireRow(scope, byName).number)
  const done = await task(scope, 'Finished', { assignee: { kind: 'person', id: 'u-ada' } })
  await changeStatus(scope, { key: done, status: 'Done' })
  await task(scope, 'Someone else’s', { assignee: { kind: 'person', id: 'u-grace' } })
  await task(scope, 'The agent’s', { assignee: { kind: 'agent', id: 'n-bob' } })

  const result = myWork(scope, ADA, {}, NOW)
  assert.deepEqual(
    result.assigned.map((t) => t.key),
    [late, soon, undated, byName],
  )
  assert.deepEqual(result.viewer, { kind: 'person', id: 'u-ada', name: 'Ada Lovelace' })
  assert.equal(result.today, '2026-09-26')
  assert.deepEqual(
    myWork(scope, BOB, {}, NOW).assigned.map((t) => t.summary),
    ['The agent’s'],
  )
})

test('starting soon is the next 7 days from the caller’s today, both ends included', async () => {
  const scope = makeScope()
  const me = { kind: 'person', id: 'u-ada' }
  await task(scope, 'Started yesterday', { assignee: me, startDate: '2026-09-25', endDate: '2026-09-30' })
  const today = await task(scope, 'Starts today', { assignee: me, startDate: '2026-09-26', endDate: '2026-09-27' })
  const last = await task(scope, 'Starts on day 7', { assignee: me, startDate: '2026-10-02', endDate: '2026-10-03' })
  const mid = await task(scope, 'Starts on day 3', { assignee: me, startDate: '2026-09-28', endDate: '2026-09-28' })
  await task(scope, 'Starts on day 8', { assignee: me, startDate: '2026-10-03', endDate: '2026-10-04' })
  await task(scope, 'Not mine', {
    assignee: { kind: 'person', id: 'u-grace' },
    startDate: '2026-09-27',
    endDate: '2026-09-27',
  })

  assert.deepEqual(
    myWork(scope, ADA, {}, NOW).startingSoon.map((t) => t.key),
    [today, mid, last],
  )
  // The caller's own today moves the window: late on the 25th in UTC is already the 26th somewhere.
  assert.deepEqual(
    myWork(scope, ADA, { today: '2026-09-25' }, NOW).startingSoon.map((t) => t.summary),
    ['Started yesterday', 'Starts today', 'Starts on day 3'],
  )
  assert.throws(() => myWork(scope, ADA, { today: '26.09.2026' }, NOW), /today "26.09.2026" is not a date/)
})

test('waiting holds the open steps that need the viewer, as the engine addresses them', async () => {
  const scope = makeScope()
  const agentStep = await task(scope, 'Session open for Bob', { assignee: { kind: 'agent', id: 'n-bob' } })
  openStep(scope, agentStep, { state: 'active', worker: 'agent', agentNodeId: 'n-bob', agentName: 'Bob' })
  const personStep = await task(scope, 'Waits on Ada', { assignee: { kind: 'person', id: 'u-ada' } })
  openStep(scope, personStep, { state: 'waiting', worker: 'person' }, undefined, '2026-09-26T07:00:00.000Z')
  const stuck = await task(scope, 'Nobody assigned')
  openStep(
    scope,
    stuck,
    { state: 'waiting', worker: null, error: 'Nobody is assigned: assign an agent, then restart the step' },
    {
      kind: 'person',
      name: 'Ada Lovelace',
    },
  )
  const othersRun = await task(scope, 'Grace’s run, stuck')
  openStep(scope, othersRun, { state: 'waiting', worker: null, error: 'No agent' })
  const finished = await task(scope, 'Finished run', { assignee: { kind: 'person', id: 'u-ada' } })
  const run = openStep(scope, finished, { state: 'waiting', worker: 'person' })
  scope.db.prepare("UPDATE workflow_run SET state = 'finished' WHERE id = ?").run(run)

  const ada = myWork(scope, ADA, {}, NOW).waiting
  assert.deepEqual(
    ada.map((s) => [s.task.key, s.state, s.reason ?? null]),
    [
      [personStep, 'waiting', null],
      [stuck, 'attention', 'Nobody is assigned: assign an agent, then restart the step'],
    ],
  )

  const bob = myWork(scope, BOB, {}, NOW).waiting
  assert.equal(bob.length, 1)
  assert.equal(bob[0].state, 'open')
  assert.equal(bob[0].sessionHref, '/group-chats/dev-chat/th-1')
  assert.deepEqual(bob[0].task, { key: agentStep, summary: 'Session open for Bob', type: 'task' })

  // Grace started the other runs and reported every task: the stuck ones need her.
  const grace = myWork(scope, { kind: 'person', id: 'u-grace', name: 'Grace' }, {}, NOW).waiting
  assert.deepEqual(grace.map((s) => s.task.key).sort(), [othersRun, stuck].sort())
})

test('waiting holds an open approval step for each approver who has not decided in its open round, and no one else', async () => {
  const scope = makeScope()
  const key = await task(scope, 'Needs sign-off')
  const db = scope.db
  db.exec(`
    INSERT INTO workflow (id, name, is_default, created_at, updated_at) VALUES ('wf-1', 'Release', 1, '2026-09-26T08:00:00.000Z', '2026-09-26T08:00:00.000Z');
    INSERT INTO workflow_step (id, workflow_id, position, name, trigger_status_id, worker_kind, kind, approvals_needed)
      VALUES ('sign-off', 'wf-1', 0, 'Sign-off', 3, 'assignee', 'approval', 2);
    INSERT INTO workflow_step_approver (workflow_id, step_id, position, person_id, name, required) VALUES
      ('wf-1', 'sign-off', 0, 'u-ada', 'Ada Lovelace', 1), ('wf-1', 'sign-off', 1, 'u-grace', 'Grace', 0);
  `)
  db.prepare(
    `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at)
     VALUES ('run-a', ?, 'wf-1', 'Release', 'active', 'person', 'Grace', '2026-09-26T08:00:00.000Z')`,
  ).run(requireRow(scope, key).id)
  db.exec(`
    INSERT INTO workflow_run_step (run_id, step_id, position, name, state, started_at) VALUES ('run-a', 'sign-off', 0, 'Sign-off', 'waiting', '2026-09-26T08:00:00.000Z');
    INSERT INTO workflow_run_round (run_id, step_id, round_no, started_at, ended_at, ended_by, outcome) VALUES
      ('run-a', 'sign-off', 1, '2026-09-26T08:00:00.000Z', '2026-09-26T08:30:00.000Z', 'transition', 'In Progress');
    INSERT INTO workflow_run_round (run_id, step_id, round_no, started_at) VALUES ('run-a', 'sign-off', 2, '2026-09-26T09:00:00.000Z');
    -- Ada decided in the earlier round only; Grace has decided in the open one.
    INSERT INTO workflow_run_vote (run_id, step_id, round_no, person_id, person_name, verdict, transition_id, transition_label, at) VALUES
      ('run-a', 'sign-off', 1, 'u-ada', 'Ada Lovelace', 'reject', 't-1', 'Rework', '2026-09-26T08:30:00.000Z'),
      ('run-a', 'sign-off', 2, 'u-grace', 'Grace', 'approve', 't-2', 'Ship', '2026-09-26T09:10:00.000Z');
  `)
  const waitingFor = (viewer: Viewer) =>
    myWork(scope, viewer, {}, NOW).waiting.map((s) => [s.task.key, s.state, s.step])
  assert.deepEqual(waitingFor(ADA), [[key, 'waiting', 'Sign-off']])
  assert.deepEqual(
    waitingFor({ kind: 'person', id: 'u-grace', name: 'Grace' }),
    [],
    'Grace decided already, and an approval step is no attention case for its starter',
  )
  assert.deepEqual(waitingFor(BOB), [], 'an agent never approves')
})

test('recent is the viewer’s own inbox, newest first, up to the limit; an agent no directory lists has none', async () => {
  const scope = makeScope()
  const key = await task(scope, 'Talked about')
  const id = requireRow(scope, key).id
  const insert = scope.db.prepare(
    `INSERT INTO inbox (recipient, kind, task_id, actor_kind, actor_name, detail, created_at) VALUES (?, ?, ?, 'person', 'Grace', '{}', ?)`,
  )
  insert.run('person:u-ada', 'assigned', id, '2026-09-25T09:00:00.000Z')
  insert.run('person:u-ada', 'mentioned', id, '2026-09-26T09:00:00.000Z')
  insert.run('person:u-grace', 'status_changed', id, '2026-09-26T09:30:00.000Z')

  assert.deepEqual(
    myWork(scope, ADA, {}, NOW).recent.map((n) => n.kind),
    ['mentioned', 'assigned'],
  )
  assert.deepEqual(
    myWork(scope, ADA, { recentLimit: 1 }, NOW).recent.map((n) => n.kind),
    ['mentioned'],
  )
  assert.deepEqual(myWork(scope, { kind: 'agent', id: null, name: 'Unlisted' }, {}, NOW).recent, [])
  assert.throws(() => myWork(scope, ADA, { recentLimit: 0 }, NOW), /recentLimit is a whole number/)
})
