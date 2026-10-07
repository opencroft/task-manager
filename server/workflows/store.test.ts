import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { allMigrations, migrate } from '../db.ts'
import { normalizeDraft } from './definition.ts'
import {
  activeRunForTask,
  createRun,
  defaultWorkflow,
  deleteWorkflow,
  endRun,
  ensureRunStep,
  findWorkflow,
  getRun,
  listRuns,
  listWorkflows,
  mintId,
  runsForTask,
  saveWorkflow,
  updateRunStep,
} from './store.ts'

const NOW = '2026-09-26T06:00:00.000Z'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, allMigrations())
  return db
}

function addTask(db: DatabaseSync, number: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task (number, summary, status_id, reporter_kind, reporter_name, rank, created_at, updated_at)
         VALUES (?, 'A task', 1, 'person', 'user', 'a', ?, ?)`,
      )
      .run(number, NOW, NOW).lastInsertRowid,
  )
}

// Seeded statuses: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Cancelled.
function standard(name = 'Standard', isDefault = false) {
  return normalizeDraft(
    {
      name,
      isDefault,
      steps: [
        {
          name: 'Development',
          triggerStatus: 2,
          worker: { kind: 'assignee' },
          instructions: 'Do {{ task.key }}',
          transitions: [3],
        },
        {
          name: 'Review',
          triggerStatus: 3,
          worker: { kind: 'agent', agentNodeId: 'agent_rev' },
          instructions: 'Review',
          transitions: [4, 2],
        },
      ],
    },
    mintId,
    [],
  )
}

test('the workflow migrations apply after core, in order, and record themselves', () => {
  const db = fresh()
  const ids = (db.prepare('SELECT id FROM schema_migrations ORDER BY rowid').all() as Array<{ id: string }>).map((r) => r.id)
  assert.deepEqual(ids, [
    'core-0001-init',
    'wf-0001-init',
    'wf-0002-rounds',
    'wf-0003-round-usage',
    'wf-0004-space-chat',
    'wf-0005-step-folder',
    'wf-0006-shared-thread-rounds',
    'wf-0007-round-shared-turn',
    'wf-0008-step-session-options',
    'wf-0009-transition-edges',
    'wf-0010-approval-steps',
    'wf-0011-attention-reasons',
    'wf-0012-round-context',
    'inbox-0001-init',
    'inbox-0002-mute',
    'dependencies-0001-init',
    'dependencies-0002-relation-types',
    'views-0001-init',
    'views-0002-columns',
    'views-0003-field-filters',
    'views-0004-status-ids',
    'attachments-0001-init',
    'attachments-0002-files',
    'mentions-0001-init',
    'mentions-0002-space-chat',
    'settings-0001-label-color',
    'versions-0001-init',
    'openproject-0001-init',
    'openproject-0002-refresh',
    'openproject-0003-relations',
    'openproject-0004-attachments',
    'forge-0001-init',
    'boards-0001-init',
    'boards-0002-field-filters',
  ])
})

test('status-only transitions migrate to edges into the step each status starts, and ended rounds get their gate', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // A database from before wf-0009 has none of the workflow migrations after it either.
  const later = ['wf-0009-transition-edges', 'wf-0010-approval-steps', 'wf-0011-attention-reasons']
  migrate(
    db,
    allMigrations().filter((m) => !later.includes(m.id)),
  )
  db.exec(`
    INSERT INTO status (id, name, category, position) VALUES (11, 'QA', 'in_progress', 5), (7, 'Tested', 'in_progress', 6);
    INSERT INTO workflow (id, name, is_default, created_at, updated_at) VALUES ('wf', 'With QA', 1, '${NOW}', '${NOW}');
    INSERT INTO workflow_step (id, workflow_id, position, name, trigger_status_id, worker_kind, instructions) VALUES
      ('dev', 'wf', 0, 'Development', 2, 'assignee', ''),
      ('rev', 'wf', 1, 'Review', 3, 'assignee', ''),
      ('qa', 'wf', 2, 'QA', 11, 'assignee', '');
    INSERT INTO workflow_step_transition (step_id, to_status_id, position) VALUES
      ('dev', 3, 0), ('rev', 11, 0), ('rev', 2, 1), ('qa', 7, 0), ('qa', 2, 1);
  `)
  addTask(db, 1)
  db.exec(`
    INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at)
      VALUES ('run', 1, 'wf', 'With QA', 'active', 'person', 'user', '${NOW}');
    INSERT INTO workflow_run_round (run_id, step_id, round_no, started_at, ended_at, ended_by, outcome) VALUES
      ('run', 'qa', 1, '${NOW}', '${NOW}', 'transition', 'In Progress'),
      ('run', 'qa', 2, '${NOW}', '${NOW}', 'transition', 'Tested'),
      ('run', 'qa', 3, '${NOW}', '${NOW}', 'cancel', 'Cancelled'),
      ('run', 'dev', 1, '${NOW}', NULL, NULL, NULL);
  `)
  migrate(db, allMigrations())

  const wf = getWorkflowOrThrow(db, 'wf')
  assert.deepEqual(
    wf.steps.map((s) => [s.name, s.transitions.map((t) => [t.label, t.toStep, t.status, t.gate])]),
    [
      ['Development', [['On to Review', 'rev', 3, null]]],
      [
        'Review',
        [
          ['On to QA', 'qa', 11, null],
          ['Back to Development', 'dev', 2, null],
        ],
      ],
      [
        'QA',
        [
          ['Finish: Tested', null, 7, null],
          ['Back to Development', 'dev', 2, null],
        ],
      ],
    ],
  )
  const rounds = db
    .prepare('SELECT step_id, round_no, transition_label, gate FROM workflow_run_round ORDER BY step_id, round_no')
    .all()
    .map((r: unknown) => ({ ...(r as object) }))
  assert.deepEqual(rounds, [
    { step_id: 'dev', round_no: 1, transition_label: null, gate: null },
    { step_id: 'qa', round_no: 1, transition_label: 'Back to Development', gate: 'fail' },
    { step_id: 'qa', round_no: 2, transition_label: 'Finish: Tested', gate: 'pass' },
    { step_id: 'qa', round_no: 3, transition_label: null, gate: null },
  ])
  // Steps may now share a trigger status.
  const shared = saveWorkflow(
    db,
    normalizeDraft(
      { id: 'wf', name: 'With QA', steps: [...wf.steps, { name: 'Design', triggerStatus: 2, worker: { kind: 'assignee' }, transitions: [3] }] },
      mintId,
      [],
    ),
    NOW,
  )
  assert.deepEqual(
    shared.steps.map((s) => s.triggerStatus),
    [2, 3, 11, 2],
  )
})

function getWorkflowOrThrow(db: DatabaseSync, id: string) {
  const wf = findWorkflow(db, id)
  assert.ok(wf, `workflow ${id}`)
  return wf
}

test('saving round-trips steps, workers and ordered transitions; the first workflow becomes the default', () => {
  const db = fresh()
  const draft = standard()
  const saved = saveWorkflow(db, draft, NOW)
  assert.equal(saved.isDefault, true)
  assert.deepEqual(
    saved.steps.map((s) => s.transitions.map((t) => t.id)),
    draft.steps.map((s) => s.transitions.map((t) => t.id)),
    'transition ids are kept',
  )
  assert.deepEqual(
    saved.steps.map((s) => [s.name, s.triggerStatus, s.worker, s.transitions.map(({ id: _id, ...t }) => t)]),
    [
      ['Development', 2, { kind: 'assignee' }, [{ label: 'On to Review', toStep: saved.steps[1]?.id, status: 3, gate: null }]],
      [
        'Review',
        3,
        { kind: 'agent', agentNodeId: 'agent_rev' },
        [
          { label: 'Finish: #4', toStep: null, status: 4, gate: null },
          { label: 'Back to Development', toStep: saved.steps[0]?.id, status: 2, gate: null },
        ],
      ],
    ],
  )
  assert.equal(findWorkflow(db, 'standard')?.id, saved.id, 'found by name, case-insensitively')
})

test('re-saving keeps step ids, deletes dropped steps, and lets two steps swap statuses', () => {
  const db = fresh()
  const saved = saveWorkflow(db, standard(), NOW)
  const [dev, review] = saved.steps
  assert.ok(dev && review)
  const swapped = saveWorkflow(
    db,
    normalizeDraft(
      {
        id: saved.id,
        name: saved.name,
        steps: [
          { ...review, triggerStatus: 2, transitions: [4] },
          { ...dev, triggerStatus: 3, transitions: [2] },
        ],
      },
      mintId,
      [],
    ),
    NOW,
  )
  assert.deepEqual(
    swapped.steps.map((s) => [s.id, s.triggerStatus]),
    [
      [review.id, 2],
      [dev.id, 3],
    ],
  )
  const trimmed = saveWorkflow(
    db,
    normalizeDraft({ id: saved.id, name: saved.name, steps: [swapped.steps[0]!] }, mintId, []),
    NOW,
  )
  assert.equal(trimmed.steps.length, 1)
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM workflow_transition').get() as { n: number }).n,
    1,
    'the dropped step took its transitions with it',
  )
})

test('only one default: making another the default moves it, deleting the default hands it on', () => {
  const db = fresh()
  const a = saveWorkflow(db, standard('A'), NOW)
  const b = saveWorkflow(db, standard('B', true), NOW)
  assert.equal(defaultWorkflow(db)?.id, b.id)
  assert.deepEqual(
    listWorkflows(db).map((w) => [w.name, w.isDefault]),
    [
      ['B', true],
      ['A', false],
    ],
  )
  deleteWorkflow(db, b.id)
  assert.equal(defaultWorkflow(db)?.id, a.id)
})

test('a run snapshots the steps as pending; one active run per task; deleting its workflow is refused', () => {
  const db = fresh()
  const wf = saveWorkflow(db, standard(), NOW)
  const taskId = addTask(db, 7)
  const runId = createRun(db, { taskId, workflow: wf, startedBy: { kind: 'person', name: 'user' }, now: NOW })
  const run = activeRunForTask(db, 'TASK', taskId)
  assert.equal(run?.id, runId)
  assert.equal(run?.taskKey, 'TASK-7')
  assert.deepEqual(
    run?.steps.map((s) => [s.name, s.state, s.attempts]),
    [
      ['Development', 'pending', 0],
      ['Review', 'pending', 0],
    ],
  )
  assert.throws(
    () => createRun(db, { taskId, workflow: wf, startedBy: { kind: 'person', name: 'user' }, now: NOW }),
    /already running/,
  )
  assert.throws(() => deleteWorkflow(db, wf.id), /still running this workflow/)
})

test('run steps take patches; ending a run frees the task for another and keeps its history', () => {
  const db = fresh()
  const wf = saveWorkflow(db, standard(), NOW)
  const taskId = addTask(db, 1)
  const runId = createRun(db, { taskId, workflow: wf, startedBy: { kind: 'agent', name: 'Rev' }, now: NOW })
  const devId = wf.steps[0]!.id
  updateRunStep(db, runId, devId, {
    state: 'active',
    agentNodeId: 'agent_dev',
    chatSlug: 'dev',
    threadRef: 'dev.dev-agent.task-1-development',
    threadId: 'thread-1',
    startedAt: NOW,
    attempts: 1,
  })
  const step = getRun(db, 'TASK', runId)?.steps[0]
  assert.equal(step?.state, 'active')
  assert.equal(step?.threadRef, 'dev.dev-agent.task-1-development')

  ensureRunStep(db, runId, { id: 'later', name: 'QA' }, 2)
  ensureRunStep(db, runId, { id: 'later', name: 'QA' }, 2)
  assert.equal(getRun(db, 'TASK', runId)?.steps.length, 3, 'a step added later is added once')

  endRun(db, runId, 'finished', NOW)
  assert.equal(activeRunForTask(db, 'TASK', taskId), null)
  createRun(db, { taskId, workflow: wf, startedBy: { kind: 'person', name: 'user' }, now: '2026-09-26T07:00:00.000Z' })
  assert.deepEqual(
    runsForTask(db, 'TASK', taskId).map((r) => r.state),
    ['active', 'finished'],
  )
  assert.equal(listRuns(db, 'TASK', { state: 'finished' }).length, 1)
})

test('deleting a task deletes its runs', () => {
  const db = fresh()
  const wf = saveWorkflow(db, standard(), NOW)
  const taskId = addTask(db, 3)
  createRun(db, { taskId, workflow: wf, startedBy: { kind: 'person', name: 'user' }, now: NOW })
  db.prepare('DELETE FROM task WHERE id = ?').run(taskId)
  assert.equal((db.prepare('SELECT count(*) AS n FROM workflow_run').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM workflow_run_step').get() as { n: number }).n, 0)
})
