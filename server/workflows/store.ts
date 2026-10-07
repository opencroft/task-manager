/**
 * Workflow storage over the instance's SQLite database: definitions (a
 * workflow, its ordered steps, each step's allowed transitions) and runs
 * (one per task at a time, with one row per step).
 *
 * Synchronous like the rest of the task model's storage; a caller that needs
 * several writes to land together wraps them in `transaction` from ../db.ts.
 * Nothing here decides whether a definition is valid — that is
 * `definition.ts` — or what a status change means for a run — that is the
 * engine.
 */

import { randomUUID } from 'node:crypto'

import type {
  ApprovalDecision,
  ApprovalVerdict,
  CouldntStartReason,
  RoundCompaction,
  RunRound,
  RunState,
  RunStep,
  RunStepState,
  SessionOptionsOutcome,
  StepApprover,
  StepKind,
  StepSessionOptions,
  StepWorker,
  TransitionGate,
  WorkflowDef,
  WorkflowRun,
  WorkflowStepDef,
  WorkflowTransition,
} from '../../shared/workflows.ts'
import { type Db, transaction } from '../db.ts'
import type { NormalizedWorkflow } from './definition.ts'
import { type RoundUsageColumns, spentOf, storedUsage, sumSpent } from './usage.ts'

export const mintId = (): string => randomUUID()

// ── Definitions ─────────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string
  name: string
  description: string
  is_default: number
  created_at: string
  updated_at: string
}

interface StepRow {
  id: string
  workflow_id: string
  position: number
  name: string
  trigger_status_id: number
  worker_kind: 'assignee' | 'agent'
  worker_agent_id: string | null
  instructions: string
  folder: string
  session_options: string
  kind: StepKind
  approvals_needed: number | null
}

interface ApproverRow {
  step_id: string
  person_id: string
  name: string
  required: number
}

interface TransitionRow {
  id: string
  workflow_id: string
  step_id: string
  position: number
  label: string
  to_step_id: string | null
  status_id: number
  gate: TransitionGate | null
}

function stepsOf(db: Db, workflowIds: string[]): Map<string, WorkflowStepDef[]> {
  const out = new Map<string, WorkflowStepDef[]>(workflowIds.map((id) => [id, []]))
  if (workflowIds.length === 0) {
    return out
  }
  const marks = workflowIds.map(() => '?').join(', ')
  const steps = db
    .prepare(`SELECT * FROM workflow_step WHERE workflow_id IN (${marks}) ORDER BY workflow_id, position`)
    .all(...workflowIds) as unknown as StepRow[]
  const transitions = db
    .prepare(`SELECT * FROM workflow_transition WHERE workflow_id IN (${marks}) ORDER BY step_id, position`)
    .all(...workflowIds) as unknown as TransitionRow[]
  const approvers = db
    .prepare(`SELECT * FROM workflow_step_approver WHERE workflow_id IN (${marks}) ORDER BY step_id, position`)
    .all(...workflowIds) as unknown as ApproverRow[]
  const byStep = new Map<string, WorkflowTransition[]>()
  for (const t of transitions) {
    byStep.set(t.step_id, [
      ...(byStep.get(t.step_id) ?? []),
      { id: t.id, label: t.label, toStep: t.to_step_id, status: t.status_id, gate: t.gate },
    ])
  }
  const approversOf = (stepId: string): StepApprover[] =>
    approvers
      .filter((a) => a.step_id === stepId)
      .map((a) => ({ personId: a.person_id, name: a.name, required: a.required === 1 }))
  for (const s of steps) {
    const worker: StepWorker =
      s.worker_kind === 'agent' ? { kind: 'agent', agentNodeId: s.worker_agent_id ?? '' } : { kind: 'assignee' }
    out.get(s.workflow_id)?.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      approval: s.kind === 'approval' ? { approvers: approversOf(s.id), needed: s.approvals_needed ?? 1 } : null,
      triggerStatus: s.trigger_status_id,
      worker,
      instructions: s.instructions,
      transitions: byStep.get(s.id) ?? [],
      folder: s.folder,
      sessionOptions: JSON.parse(s.session_options) as StepSessionOptions,
    })
  }
  return out
}

function toWorkflow(row: WorkflowRow, steps: WorkflowStepDef[]): WorkflowDef {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default === 1,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Every workflow, the default first, then by name. */
export function listWorkflows(db: Db): WorkflowDef[] {
  const rows = db
    .prepare('SELECT * FROM workflow ORDER BY is_default DESC, name COLLATE NOCASE')
    .all() as unknown as WorkflowRow[]
  const steps = stepsOf(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => toWorkflow(r, steps.get(r.id) ?? []))
}

export function getWorkflow(db: Db, id: string): WorkflowDef | null {
  const row = db.prepare('SELECT * FROM workflow WHERE id = ?').get(id) as unknown as WorkflowRow | undefined
  return row ? toWorkflow(row, stepsOf(db, [row.id]).get(row.id) ?? []) : null
}

/** Find by id, or by name (case-insensitive) — what an agent is likely to have in hand. */
export function findWorkflow(db: Db, ref: string): WorkflowDef | null {
  const byId = getWorkflow(db, ref)
  if (byId) {
    return byId
  }
  const row = db.prepare('SELECT id FROM workflow WHERE name = ? COLLATE NOCASE').get(ref.trim()) as
    | { id: string }
    | undefined
  return row ? getWorkflow(db, row.id) : null
}

export function defaultWorkflow(db: Db): WorkflowDef | null {
  const row = db.prepare('SELECT id FROM workflow WHERE is_default = 1').get() as { id: string } | undefined
  return row ? getWorkflow(db, row.id) : null
}

/**
 * Create or replace a workflow and its steps. Steps keep their ids across a
 * save, so a running task's run steps still match them; a step left out of
 * the new list is deleted. The first workflow of a project becomes its
 * default whatever it asked for; making another the default clears the old one.
 */
export function saveWorkflow(db: Db, wf: NormalizedWorkflow, now: string): WorkflowDef {
  transaction(db, () => {
    const existing = db.prepare('SELECT id FROM workflow WHERE id = ?').get(wf.id)
    const others = (db.prepare('SELECT count(*) AS n FROM workflow WHERE id <> ?').get(wf.id) as { n: number }).n
    const isDefault = wf.isDefault || others === 0
    if (isDefault) {
      db.prepare('UPDATE workflow SET is_default = 0 WHERE is_default = 1 AND id <> ?').run(wf.id)
    }
    if (existing) {
      db.prepare('UPDATE workflow SET name = ?, description = ?, is_default = ?, updated_at = ? WHERE id = ?').run(
        wf.name,
        wf.description,
        isDefault ? 1 : 0,
        now,
        wf.id,
      )
    } else {
      db.prepare(
        'INSERT INTO workflow (id, name, description, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(wf.id, wf.name, wf.description, isDefault ? 1 : 0, now, now)
    }

    const keep = new Set(wf.steps.map((s) => s.id))
    const current = db.prepare('SELECT id FROM workflow_step WHERE workflow_id = ?').all(wf.id) as Array<{
      id: string
    }>
    for (const { id } of current) {
      if (!keep.has(id)) {
        db.prepare('DELETE FROM workflow_step WHERE id = ?').run(id)
      }
    }
    db.prepare('DELETE FROM workflow_transition WHERE workflow_id = ?').run(wf.id)
    db.prepare('DELETE FROM workflow_step_approver WHERE workflow_id = ?').run(wf.id)
    const upsert = db.prepare(
      `INSERT INTO workflow_step
         (id, workflow_id, position, name, trigger_status_id, worker_kind, worker_agent_id, instructions, folder, session_options,
          kind, approvals_needed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         position = excluded.position, name = excluded.name, trigger_status_id = excluded.trigger_status_id,
         worker_kind = excluded.worker_kind, worker_agent_id = excluded.worker_agent_id,
         instructions = excluded.instructions, folder = excluded.folder, session_options = excluded.session_options,
         kind = excluded.kind, approvals_needed = excluded.approvals_needed`,
    )
    const addTransition = db.prepare(
      `INSERT INTO workflow_transition (id, workflow_id, step_id, position, label, to_step_id, status_id, gate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const addApprover = db.prepare(
      'INSERT INTO workflow_step_approver (workflow_id, step_id, position, person_id, name, required) VALUES (?, ?, ?, ?, ?, ?)',
    )
    wf.steps.forEach((step, position) => {
      upsert.run(
        step.id,
        wf.id,
        position,
        step.name,
        step.triggerStatus,
        step.worker.kind,
        step.worker.kind === 'agent' ? step.worker.agentNodeId : null,
        step.instructions,
        step.folder,
        JSON.stringify(step.sessionOptions),
        step.kind,
        step.approval?.needed ?? null,
      )
      step.transitions.forEach((t, i) => {
        addTransition.run(t.id, wf.id, step.id, i, t.label, t.toStep, t.status, t.gate)
      })
      step.approval?.approvers.forEach((a, i) => {
        addApprover.run(wf.id, step.id, i, a.personId, a.name, a.required ? 1 : 0)
      })
    })
  })
  const saved = getWorkflow(db, wf.id)
  if (!saved) {
    throw new Error('The workflow was saved but cannot be read back')
  }
  return saved
}

/** Delete a workflow. Refused while a task is running it: cancel those runs first. */
export function deleteWorkflow(db: Db, id: string): void {
  const active = (
    db.prepare("SELECT count(*) AS n FROM workflow_run WHERE workflow_id = ? AND state = 'active'").get(id) as {
      n: number
    }
  ).n
  if (active > 0) {
    throw new Error(
      `${active} task${active === 1 ? ' is' : 's are'} still running this workflow; cancel ${active === 1 ? 'that run' : 'those runs'} first`,
    )
  }
  transaction(db, () => {
    const wasDefault = (db.prepare('SELECT is_default FROM workflow WHERE id = ?').get(id) as
      | { is_default: number }
      | undefined)?.is_default
    db.prepare('DELETE FROM workflow WHERE id = ?').run(id)
    if (wasDefault === 1) {
      // Keep "a project with workflows has a default" true: the oldest remaining one takes over.
      db.prepare(
        'UPDATE workflow SET is_default = 1 WHERE id = (SELECT id FROM workflow ORDER BY created_at LIMIT 1)',
      ).run()
    }
  })
}

// ── Runs ────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string
  task_id: number
  task_number: number
  workflow_id: string | null
  workflow_name: string
  state: RunState
  started_by_kind: 'agent' | 'person'
  started_by_name: string
  started_at: string
  ended_at: string | null
}

interface RunStepRow {
  run_id: string
  step_id: string
  position: number
  name: string
  state: RunStepState
  agent_node_id: string | null
  agent_name: string | null
  chat_ref: string | null
  chat_slug: string | null
  thread_ref: string | null
  thread_id: string | null
  started_at: string | null
  ended_at: string | null
  outcome: string | null
  summary: string | null
  finished_by: string | null
  attempts: number
  error: string | null
}

const RUN_SELECT = `SELECT r.*, t.number AS task_number FROM workflow_run r JOIN task t ON t.id = r.task_id`

interface RoundRow extends RoundUsageColumns {
  run_id: string
  step_id: string
  round_no: number
  worker_kind: 'agent' | 'person' | null
  worker_name: string | null
  started_at: string
  ended_at: string | null
  ended_by: 'transition' | 'cancel' | null
  outcome: string | null
  transition_label: string | null
  gate: TransitionGate | null
  session_options: string | null
  context_tokens: number | null
  compaction: string | null
}

interface VoteRow {
  run_id: string
  step_id: string
  round_no: number
  person_id: string
  person_name: string
  verdict: ApprovalVerdict
  transition_id: string
  transition_label: string
  comment: string | null
  at: string
}

function toDecision(v: VoteRow): ApprovalDecision {
  return {
    approver: { personId: v.person_id, name: v.person_name },
    verdict: v.verdict,
    transitionId: v.transition_id,
    transition: v.transition_label,
    comment: v.comment,
    at: v.at,
  }
}

const roundKey = (runId: string, stepId: string, roundNo?: number) => `${runId}\u001f${stepId}\u001f${roundNo ?? ''}`

function toRunRound(r: RoundRow, now: number, decisions: ApprovalDecision[]): RunRound {
  return {
    roundNo: r.round_no,
    worker: r.worker_kind && r.worker_name ? { kind: r.worker_kind, name: r.worker_name } : null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    outcome: r.outcome,
    transition: r.transition_label,
    gate: r.gate,
    decisions,
    timeMs: Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Date.parse(r.started_at)),
    usage: storedUsage(r),
    sessionOptions: r.session_options === null ? null : (JSON.parse(r.session_options) as SessionOptionsOutcome),
    contextTokens: r.context_tokens,
    compaction: r.compaction === null ? null : (JSON.parse(r.compaction) as RoundCompaction),
  }
}

function toRunStep(r: RunStepRow, rounds: RunRound[]): RunStep {
  return {
    stepId: r.step_id,
    name: r.name,
    position: r.position,
    state: r.state,
    agentNodeId: r.agent_node_id,
    agentName: r.agent_name,
    chatRef: r.chat_ref,
    chatSlug: r.chat_slug,
    threadRef: r.thread_ref,
    threadId: r.thread_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    summary: r.summary,
    finishedBy: r.finished_by,
    attempts: r.attempts,
    error: r.error,
    rounds,
    spent: spentOf(rounds),
  }
}

function hydrateRuns(db: Db, projectKey: string, rows: RunRow[]): WorkflowRun[] {
  if (rows.length === 0) {
    return []
  }
  const marks = rows.map(() => '?').join(', ')
  const ids = rows.map((r) => r.id)
  const steps = db
    .prepare(`SELECT * FROM workflow_run_step WHERE run_id IN (${marks}) ORDER BY run_id, position`)
    .all(...ids) as unknown as RunStepRow[]
  const roundRows = db
    .prepare(`SELECT * FROM workflow_run_round WHERE run_id IN (${marks}) ORDER BY run_id, step_id, round_no`)
    .all(...ids) as unknown as RoundRow[]
  const voteRows = db
    .prepare(`SELECT * FROM workflow_run_vote WHERE run_id IN (${marks}) ORDER BY rowid`)
    .all(...ids) as unknown as VoteRow[]
  const votes = new Map<string, ApprovalDecision[]>()
  for (const v of voteRows) {
    const key = roundKey(v.run_id, v.step_id, v.round_no)
    votes.set(key, [...(votes.get(key) ?? []), toDecision(v)])
  }
  const now = Date.now()
  const rounds = new Map<string, RunRound[]>()
  for (const round of roundRows) {
    const key = roundKey(round.run_id, round.step_id)
    const decisions = votes.get(roundKey(round.run_id, round.step_id, round.round_no)) ?? []
    rounds.set(key, [...(rounds.get(key) ?? []), toRunRound(round, now, decisions)])
  }
  const byRun = new Map<string, RunStep[]>()
  for (const s of steps) {
    byRun.set(s.run_id, [...(byRun.get(s.run_id) ?? []), toRunStep(s, rounds.get(roundKey(s.run_id, s.step_id)) ?? [])])
  }
  return rows.map((r) => {
    const runSteps = byRun.get(r.id) ?? []
    return {
      id: r.id,
      taskKey: `${projectKey}-${r.task_number}`,
      workflowId: r.workflow_id ?? '',
      workflowName: r.workflow_name,
      state: r.state,
      startedBy: { kind: r.started_by_kind, name: r.started_by_name },
      startedAt: r.started_at,
      endedAt: r.ended_at,
      steps: runSteps,
      spent: sumSpent(runSteps.map((step) => step.spent)),
    }
  })
}

export function getRun(db: Db, projectKey: string, runId: string): WorkflowRun | null {
  const row = db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as unknown as RunRow | undefined
  return row ? (hydrateRuns(db, projectKey, [row])[0] ?? null) : null
}

export function activeRunForTask(db: Db, projectKey: string, taskId: number): WorkflowRun | null {
  const row = db.prepare(`${RUN_SELECT} WHERE r.task_id = ? AND r.state = 'active'`).get(taskId) as unknown as
    | RunRow
    | undefined
  return row ? (hydrateRuns(db, projectKey, [row])[0] ?? null) : null
}

/** A task's runs, newest first — the active one, if any, among them. */
export function runsForTask(db: Db, projectKey: string, taskId: number): WorkflowRun[] {
  const rows = db
    .prepare(`${RUN_SELECT} WHERE r.task_id = ? ORDER BY r.started_at DESC`)
    .all(taskId) as unknown as RunRow[]
  return hydrateRuns(db, projectKey, rows)
}

export function listRuns(
  db: Db,
  projectKey: string,
  opts: { state?: RunState; workflowId?: string; limit?: number; ids?: string[] } = {},
): WorkflowRun[] {
  const where: string[] = []
  const args: Array<string | number> = []
  if (opts.ids) {
    where.push(`r.id IN (SELECT value FROM json_each(?))`)
    args.push(JSON.stringify(opts.ids))
  }
  if (opts.state) {
    where.push('r.state = ?')
    args.push(opts.state)
  }
  if (opts.workflowId) {
    where.push('r.workflow_id = ?')
    args.push(opts.workflowId)
  }
  const sql = `${RUN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.started_at DESC LIMIT ?`
  const rows = db.prepare(sql).all(...args, Math.min(Math.max(opts.limit ?? 200, 1), 1000)) as unknown as RunRow[]
  return hydrateRuns(db, projectKey, rows)
}

/** Start a run of `workflow` on a task: one pending row per step. Refused while the task has an active run. */
export function createRun(
  db: Db,
  input: { taskId: number; workflow: WorkflowDef; startedBy: { kind: 'agent' | 'person'; name: string }; now: string },
): string {
  const id = mintId()
  transaction(db, () => {
    const active = db.prepare("SELECT id FROM workflow_run WHERE task_id = ? AND state = 'active'").get(input.taskId)
    if (active) {
      throw new Error('This task is already running a workflow; cancel that run first')
    }
    db.prepare(
      `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      id,
      input.taskId,
      input.workflow.id,
      input.workflow.name,
      input.startedBy.kind,
      input.startedBy.name,
      input.now,
    )
    const addStep = db.prepare('INSERT INTO workflow_run_step (run_id, step_id, position, name) VALUES (?, ?, ?, ?)')
    input.workflow.steps.forEach((step, position) => {
      addStep.run(id, step.id, position, step.name)
    })
  })
  return id
}

/** Make sure a run has a row for a step the definition gained after the run started. */
export function ensureRunStep(db: Db, runId: string, step: { id: string; name: string }, position: number): void {
  db.prepare(
    'INSERT INTO workflow_run_step (run_id, step_id, position, name) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  ).run(runId, step.id, position, step.name)
}

export type RunStepPatch = Partial<{
  name: string
  state: RunStepState
  agentNodeId: string | null
  agentName: string | null
  chatRef: string | null
  chatSlug: string | null
  threadRef: string | null
  threadId: string | null
  startedAt: string | null
  endedAt: string | null
  outcome: string | null
  summary: string | null
  finishedBy: string | null
  attempts: number
  error: string | null
}>

const PATCH_COLUMNS: Record<keyof RunStepPatch, string> = {
  name: 'name',
  state: 'state',
  agentNodeId: 'agent_node_id',
  agentName: 'agent_name',
  chatRef: 'chat_ref',
  chatSlug: 'chat_slug',
  threadRef: 'thread_ref',
  threadId: 'thread_id',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  outcome: 'outcome',
  summary: 'summary',
  finishedBy: 'finished_by',
  attempts: 'attempts',
  error: 'error',
}

export function updateRunStep(db: Db, runId: string, stepId: string, patch: RunStepPatch): void {
  const keys = (Object.keys(patch) as Array<keyof RunStepPatch>).filter((k) => patch[k] !== undefined)
  if (keys.length === 0) {
    return
  }
  const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')
  db.prepare(`UPDATE workflow_run_step SET ${sets} WHERE run_id = ? AND step_id = ?`).run(
    ...keys.map((k) => patch[k] as string | number | null),
    runId,
    stepId,
  )
}

export function endRun(db: Db, runId: string, state: Exclude<RunState, 'active'>, now: string): void {
  db.prepare("UPDATE workflow_run SET state = ?, ended_at = ? WHERE id = ? AND state = 'active'").run(state, now, runId)
}

/** Who works a round: the step's agent, or the person it waits on. */
export interface RoundWorker {
  kind: 'agent' | 'person'
  name: string
}

/**
 * A step was entered: a new round, numbered after the step's earlier ones in
 * this run. When the step's last round is still open — a restart in place —
 * that round continues, worked by `worker` from now on.
 */
export function enterRound(db: Db, runId: string, stepId: string, worker: RoundWorker | null, now: string): void {
  const kind = worker?.kind ?? null
  const name = worker?.name ?? null
  const continued = db
    .prepare('UPDATE workflow_run_round SET worker_kind = ?, worker_name = ? WHERE run_id = ? AND step_id = ? AND ended_at IS NULL')
    .run(kind, name, runId, stepId)
  if (Number(continued.changes) > 0) {
    return
  }
  db.prepare(
    `INSERT INTO workflow_run_round (run_id, step_id, round_no, worker_kind, worker_name, started_at)
     SELECT ?, ?, coalesce(max(round_no), 0) + 1, ?, ?, ? FROM workflow_run_round WHERE run_id = ? AND step_id = ?`,
  ).run(runId, stepId, kind, name, now, runId, stepId)
}

/** The thread the open round of a step is worked in: what its usage is read from, and what orders it among the thread's rounds. */
export function setRoundThread(db: Db, runId: string, stepId: string, threadRef: string): void {
  db.prepare('UPDATE workflow_run_round SET thread_ref = ? WHERE run_id = ? AND step_id = ? AND ended_at IS NULL').run(
    threadRef,
    runId,
    stepId,
  )
}

/** What became of the session options the open round of a step sent its message with. */
export function setRoundSessionOptions(db: Db, runId: string, stepId: string, outcome: SessionOptionsOutcome): void {
  db.prepare('UPDATE workflow_run_round SET session_options = ? WHERE run_id = ? AND step_id = ? AND ended_at IS NULL').run(
    JSON.stringify(outcome),
    runId,
    stepId,
  )
}

/**
 * A compaction of the session starts before the open round of a step's
 * message, run by the process `mark` names. Answers that round's number,
 * which `endRoundCompaction` records its end on; null when the step has no
 * open round.
 */
export function startRoundCompaction(db: Db, runId: string, stepId: string, compaction: RoundCompaction, mark: string): number | null {
  const row = db
    .prepare(
      `UPDATE workflow_run_round SET compaction = ?, compaction_process = ?
       WHERE run_id = ? AND step_id = ? AND ended_at IS NULL RETURNING round_no`,
    )
    .get(JSON.stringify(compaction), mark, runId, stepId) as { round_no: number } | undefined
  return row?.round_no ?? null
}

/**
 * How the compaction before round `roundNo` ended, recorded whether or not
 * the round is still open, and only over a compaction still `running`: one
 * already recorded as ended (cut off by a restart) stays as it is. Answers
 * whether the round's message is still to be sent: the compaction was
 * running, and the round is open.
 */
export function endRoundCompaction(db: Db, runId: string, stepId: string, roundNo: number, compaction: RoundCompaction): boolean {
  const row = db
    .prepare(
      `UPDATE workflow_run_round SET compaction = ?
       WHERE run_id = ? AND step_id = ? AND round_no = ? AND json_extract(compaction, '$.outcome') = 'running'
       RETURNING ended_at`,
    )
    .get(JSON.stringify(compaction), runId, stepId, roundNo) as { ended_at: string | null } | undefined
  return row !== undefined && row.ended_at === null
}

/** Round `roundNo`'s message was not sent after its compaction ended: its record says so. */
export function markCompactionUnsent(db: Db, runId: string, stepId: string, roundNo: number): void {
  db.prepare(
    `UPDATE workflow_run_round SET compaction = json_set(compaction, '$.unsent', json('true'))
     WHERE run_id = ? AND step_id = ? AND round_no = ? AND compaction IS NOT NULL`,
  ).run(runId, stepId, roundNo)
}

/** A compaction recorded as running by a process other than the one `mark` names. */
export interface OrphanedCompaction {
  runId: string
  stepId: string
  roundNo: number
  compaction: RoundCompaction
}

/**
 * Compactions still recorded as `running` that no process of this mark
 * started: the process that ran them is gone, and nothing will end them.
 */
export function orphanedCompactions(db: Db, mark: string): OrphanedCompaction[] {
  const rows = db
    .prepare(
      `SELECT run_id, step_id, round_no, compaction FROM workflow_run_round
       WHERE json_extract(compaction, '$.outcome') = 'running' AND (compaction_process IS NULL OR compaction_process <> ?)
       ORDER BY started_at`,
    )
    .all(mark) as Array<{ run_id: string; step_id: string; round_no: number; compaction: string }>
  return rows.map((r) => ({
    runId: r.run_id,
    stepId: r.step_id,
    roundNo: r.round_no,
    compaction: JSON.parse(r.compaction) as RoundCompaction,
  }))
}

/** The open round of a step couldn't start, for `reason`; `message` says what to fix. */
export function roundNeedsAttention(
  db: Db,
  runId: string,
  stepId: string,
  why: { reason: CouldntStartReason; message: string; at: string },
): void {
  transaction(db, () => {
    db.prepare('UPDATE workflow_run_round SET attention = attention + 1 WHERE run_id = ? AND step_id = ? AND ended_at IS NULL').run(
      runId,
      stepId,
    )
    db.prepare(
      `INSERT INTO workflow_run_attention (run_id, step_id, round_no, reason, message, at)
       SELECT run_id, step_id, round_no, ?, ?, ? FROM workflow_run_round WHERE run_id = ? AND step_id = ? AND ended_at IS NULL`,
    ).run(why.reason, why.message, why.at, runId, stepId)
  })
}

/**
 * The open round of a step ended: the task left the step, or the run was
 * cancelled. `transition` is the step's transition it left by, when one did.
 */
export function endRound(
  db: Db,
  runId: string,
  stepId: string,
  end: { at: string; by: 'transition' | 'cancel'; outcome: string; transition?: { label: string; gate: TransitionGate } | null },
): void {
  db.prepare(
    `UPDATE workflow_run_round SET ended_at = ?, ended_by = ?, outcome = ?, transition_label = ?, gate = ?
     WHERE run_id = ? AND step_id = ? AND ended_at IS NULL`,
  ).run(end.at, end.by, end.outcome, end.transition?.label ?? null, end.transition?.gate ?? null, runId, stepId)
}

/**
 * An approver's decision in the open round of an approval step. A second
 * decision by the same approver in that round replaces the first.
 */
export function recordDecision(
  db: Db,
  runId: string,
  stepId: string,
  vote: { approver: { personId: string; name: string }; verdict: ApprovalVerdict; transition: WorkflowTransition; comment: string | null; at: string },
): void {
  const open = db
    .prepare('SELECT round_no FROM workflow_run_round WHERE run_id = ? AND step_id = ? AND ended_at IS NULL ORDER BY round_no DESC LIMIT 1')
    .get(runId, stepId) as { round_no: number } | undefined
  if (!open) {
    throw new Error('The step has no open round to decide')
  }
  // REPLACE re-inserts a changed decision, so rowid order is the order decisions were last made in.
  db.prepare(
    `INSERT OR REPLACE INTO workflow_run_vote
       (run_id, step_id, round_no, person_id, person_name, verdict, transition_id, transition_label, comment, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    stepId,
    open.round_no,
    vote.approver.personId,
    vote.approver.name,
    vote.verdict,
    vote.transition.id,
    vote.transition.label,
    vote.comment,
    vote.at,
  )
}

/** Whether a move the workflow asked for is still on its way: the status change it makes has not arrived. */
export function hasPendingMove(db: Db, runId: string): boolean {
  const row = db.prepare('SELECT pending_status_id FROM workflow_run WHERE id = ?').get(runId) as { pending_status_id: number | null } | undefined
  return row?.pending_status_id != null
}

/**
 * A move the workflow itself asked for, held on the run until the status
 * change it makes arrives: the transition a finishing agent chose, or the
 * step a restart reaches. A status alone cannot say which of the steps
 * sharing it opens, or which of a step's transitions into it was taken.
 */
export type PendingMove = { status: number } & ({ transition: string } | { step: string })

export function setPendingMove(db: Db, runId: string, move: PendingMove | null): void {
  db.prepare('UPDATE workflow_run SET pending_status_id = ?, pending_transition_id = ?, pending_step_id = ? WHERE id = ?').run(
    move?.status ?? null,
    move && 'transition' in move ? move.transition : null,
    move && 'step' in move ? move.step : null,
    runId,
  )
}

/** Read and clear a run's pending move. */
export function takePendingMove(db: Db, runId: string): PendingMove | null {
  const row = db
    .prepare('SELECT pending_status_id, pending_transition_id, pending_step_id FROM workflow_run WHERE id = ?')
    .get(runId) as { pending_status_id: number | null; pending_transition_id: string | null; pending_step_id: string | null } | undefined
  if (!row || row.pending_status_id === null) {
    return null
  }
  setPendingMove(db, runId, null)
  if (row.pending_transition_id !== null) {
    return { status: row.pending_status_id, transition: row.pending_transition_id }
  }
  return row.pending_step_id === null ? null : { status: row.pending_status_id, step: row.pending_step_id }
}
