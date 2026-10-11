/**
 * The workflow engine: what a task's status change means for its run.
 *
 * ONE PATH. Nothing here moves a task. A run advances only when the task
 * model's status-change hook reports a transition, so a person dragging a
 * card, an agent calling `task_change_status` and an agent finishing its step
 * all arrive through `afterStatusChange` and behave the same. Starting a
 * workflow and finishing a step end in a status change made through the task
 * model's own `changeStatus`, which is handed in (see `TaskPort`).
 *
 * A status alone does not say everything a step's transition does: which of
 * the steps sharing that status opens, and whether the move passed the gate.
 * So a move the workflow asks for is held on the run first (`PendingMove`)
 * and read back when its status change arrives; one that keeps the status,
 * which the hook never hears, is advanced the same way by the engine itself.
 *
 * Sessions are opened as the extension itself (the host's `groupChats`,
 * acting as its system identity), never as whichever agent happened to cause
 * the transition: the workflow opens a session, not the agent finishing the
 * previous step, and one sender keeps a person's move and an agent's finish
 * identical. The finishing agent's own words travel inside the message.
 */

import type { Actor, Status, TaskSummary } from '../../shared/types.ts'
import {
  APPROVAL_VERDICTS,
  type ApprovalDecision,
  type ApprovalVerdict,
  approvalOutcome,
  type CouldntStartReason,
  type RunStep,
  type SessionOptionsOutcome,
  type StepSessionOptions,
  stepStartedBy,
  type TransitionGate,
  transitionGate,
  VERDICT_GATE,
  verdictTransitions,
  type WorkflowDef,
  type WorkflowRun,
  type WorkflowStepDef,
  type WorkflowTransition,
} from '../../shared/workflows.ts'
import { type Db, transaction } from '../db.ts'
import type { Addressee, NotificationDraft, Party } from '../inbox/store.ts'
import {
  findSpaceChat,
  NO_GROUP_CHATS,
  notInSpaceChat,
  type SpaceChatProblemKind,
  spaceChatFor,
} from '../space-chat.ts'
import { agentTaskThread, isUnreachable, oneThreadAtATime, openTaskThread, reopenTaskThread } from '../task-threads.ts'
import {
  type CompactPort,
  compactSession,
  contextOverThreshold,
  INTERRUPTED_COMPACTION,
  INTERRUPTED_ROUND,
  processMark,
} from './compaction.ts'
import { cancelledMessage, openingMessage, reworkMessage } from './messages.ts'
import {
  activeRunForTask,
  createRun,
  defaultWorkflow,
  endRound,
  endRoundCompaction,
  endRun,
  ensureRunStep,
  enterRound,
  findWorkflow,
  getRun,
  getWorkflow,
  hasPendingMove,
  markCompactionUnsent,
  orphanedCompactions,
  type PendingMove,
  recordDecision,
  roundNeedsAttention,
  runsForTask,
  setPendingMove,
  setRoundSessionOptions,
  setRoundThread,
  startRoundCompaction,
  takePendingMove,
  updateRunStep,
} from './store.ts'
import { renderTemplate, stepSlug, type TemplateContext } from './template.ts'
import { recordRoundUsage, type UsagePort } from './usage.ts'

/** The part of the host's group-chat API the engine uses. `usage` and `compact` are absent on a host without them. */
export interface ChatsPort extends UsagePort, CompactPort {
  list(): Promise<Array<{ ref: string; slug: string; name: string; agents: Array<{ nodeId: string; name: string }> }>>
  startThread(input: {
    chat: string
    agentNodeId: string
    message: string
    title?: string
    /** The thread-list folder to file the thread in, by name; made when the chat has none. Omitted: the top level. */
    folder?: string
    /** Applied to the thread's session before `message` is delivered. A host without them ignores them. */
    sessionOptions?: StepSessionOptions
  }): Promise<{
    thread: { ref: string; threadId: string; chat: { ref: string; slug: string } }
    /** What became of `sessionOptions`; absent when none were given, or the host does not apply them. */
    sessionOptions?: SessionOptionsOutcome
  }>
  send(input: {
    thread: string
    message: string
    queue?: 'wait' | 'push'
    sessionOptions?: StepSessionOptions
  }): Promise<{ sessionOptions?: SessionOptionsOutcome } | undefined>
  /** A thread of a chat the extension is in, refused as "Not available" when it cannot reach it; absent on an older host. */
  thread?(ref: string): Promise<{ archived: boolean }>
  /** Archive a thread the extension opened; absent on a host without archiving. */
  archive?(ref: string): Promise<unknown>
  /** Bring an archived thread back; absent on a host without archiving. */
  unarchive?(ref: string): Promise<unknown>
}

/** The part of the task model the engine uses. `changeStatus` is its single writer of status. */
export interface TaskPort {
  changeStatus(input: { key: string; status: number; comment?: string }): Promise<unknown>
}

export interface EngineEnv {
  db: Db
  projectKey: string
  /** `<space>.<app>`, for the `app_call` an agent is told to make. */
  app: string
  /** Null when the host offers no group chats: steps then record why they could not open. */
  chats: ChatsPort | null
  /** The App's space: every step's session opens in that space's chat (see ../space-chat.ts). */
  spaceSlug: string
  /** The host's agents, to name a step's agent who is not in the space's chat. Absent in tests that do not look. */
  agents?: () => Promise<Array<{ id: string; name: string }>>
  now: () => string
  /**
   * The inbox: told when a step opens, waits on a person or
   * needs attention, and when a run ends. Absent in tests that do not look.
   * Never throws: a lost notification must not fail the run.
   */
  inbox?: (draft: NotificationDraft) => Promise<void>
}

export interface StatusChange {
  task: TaskSummary
  from: Status
  to: Status
  actor: Actor
}

function taskId(db: Db, number: number): number {
  const row = db.prepare('SELECT id FROM task WHERE number = ?').get(number) as { id: number } | undefined
  if (!row) {
    throw new Error(`Task #${number} does not exist`)
  }
  return row.id
}

function statuses(db: Db): Status[] {
  return db
    .prepare('SELECT id, name, category, color, position FROM status ORDER BY position')
    .all() as unknown as Status[]
}

function statusName(all: Status[], id: number): string {
  return all.find((s) => s.id === id)?.name ?? `#${id}`
}

/** Who started a run, as an inbox addressee. */
function starterOf(run: WorkflowRun): Party {
  return { kind: run.startedBy.kind, name: run.startedBy.name }
}

async function tell(env: EngineEnv, draft: NotificationDraft): Promise<void> {
  try {
    await env.inbox?.(draft)
  } catch (error) {
    console.error('[task-pipelines] inbox notification failed', error)
  }
}

/** The step of a run something is said about: an entry's input, or a step found later. */
interface StepOfRun {
  run: WorkflowRun
  workflow: { name: string }
  step: { id: string; name: string }
  task: { number: number }
}

/** A step couldn't start: its round records why, and the run's starter and the task's reporter hear it. */
function attention(env: EngineEnv, input: StepOfRun, why: CouldntStartReason, reason: string): Promise<void> {
  roundNeedsAttention(env.db, input.run.id, input.step.id, { reason: why, message: reason, at: env.now() })
  const recipients: Addressee[] = [starterOf(input.run), 'reporter']
  return tell(env, {
    kind: 'step_attention',
    taskNumber: input.task.number,
    recipients,
    actor: null,
    workflow: { name: input.workflow.name },
    step: { name: input.step.name },
    excerpt: reason,
  })
}

/** The step of a run that is currently open — at most one, since only one status is current. */
function openStepOf(run: WorkflowRun): RunStep | undefined {
  return run.steps.find((s) => s.state === 'active' || s.state === 'waiting')
}

/**
 * Inside the status transaction (synchronous; a throw refuses the change):
 * the agent working the open step may only move the task to that step's
 * allowed transitions, and while an approval step is open no agent moves it
 * at all: its approvers decide. People are not bound by either: a step's
 * list describes what its worker may decide, and a person overriding it on
 * the board is the point of a board.
 */
export function beforeStatusChange(db: Db, projectKey: string, change: StatusChange): void {
  if (change.actor.kind !== 'agent') {
    return
  }
  const run = activeRunForTask(db, projectKey, taskId(db, change.task.number))
  const open = run ? openStepOf(run) : undefined
  const step = run && open ? getWorkflow(db, run.workflowId)?.steps.find((s) => s.id === open.stepId) : undefined
  if (!open || !step) {
    return
  }
  if (step.kind === 'approval') {
    throw new Error(
      `${change.task.key} waits on the approvers of "${open.name}": only people can move it until they decide`,
    )
  }
  if (open.agentName !== change.actor.name || step.transitions.some((t) => t.status === change.to.id)) {
    return
  }
  throw new Error(
    `You are working the "${open.name}" step, which can finish by: ${transitionList(step)}. ` +
      'Use workflow_step_finish with one of those.',
  )
}

/** A step's transitions as an agent is offered them. */
function transitionList(step: WorkflowStepDef): string {
  return step.transitions.map((t) => `"${t.label}"`).join(', ')
}

/**
 * After the status change committed: close the open step, open the next, or
 * finish the run. A task that reached a done status then has its sessions
 * archived.
 */
export async function afterStatusChange(env: EngineEnv, change: StatusChange): Promise<void> {
  await advanceRun(env, change)
  if (change.to.category === 'done') {
    await archiveTaskThreads(env, change.task.number)
  }
}

/**
 * A closed task's sessions go to the archive: every thread its workflow runs
 * opened, each keeping its folder, read-only until unarchived. Every run
 * counts, not only the one that just ended, so a task closed with no run
 * active still has its earlier runs' threads archived.
 *
 * The thread of a step open NOW is left alone: a done status can itself be a
 * step's trigger, and that step has just been handed the task.
 *
 * Never throws: the task is closed either way, and a thread left active is a
 * tidiness miss, not a failed status change. A host without archiving is
 * skipped.
 */
async function archiveTaskThreads(env: EngineEnv, taskNumber: number): Promise<void> {
  const chats = env.chats
  if (!chats?.archive) {
    return
  }
  const runs = runsForTask(env.db, env.projectKey, taskId(env.db, taskNumber))
  const open = new Set(runs.flatMap((run) => (run.state === 'active' ? [openStepOf(run)?.threadRef] : [])))
  const refs = new Set(
    runs.flatMap((run) => run.steps.flatMap((s) => (s.threadRef && !open.has(s.threadRef) ? [s.threadRef] : []))),
  )
  for (const ref of refs) {
    try {
      await chats.archive(ref)
    } catch (error) {
      console.error('[task-pipelines] could not archive a closed task thread', ref, error)
    }
  }
}

/** Where a status change takes a run: the step that opens, whether the run ends, and the transition it was. */
interface Move {
  next: WorkflowStepDef | undefined
  ends: boolean
  taken: { label: string; gate: TransitionGate } | null
}

/**
 * The move a status change makes. A move the workflow asked for into this
 * status (a finishing agent's transition, a restart's step) is followed as
 * asked. Any other move opens the first step the status starts, and counts as
 * the open step's transition into that status and step when it has one.
 */
function moveFor(
  workflow: WorkflowDef | null,
  from: WorkflowStepDef | undefined,
  pending: PendingMove | null,
  to: Status,
): Move {
  const steps = workflow?.steps ?? []
  const taken = (t: WorkflowTransition) => (from ? { label: t.label, gate: transitionGate(steps, from.id, t) } : null)
  if (pending?.status === to.id) {
    if ('step' in pending) {
      return { next: steps.find((s) => s.id === pending.step), ends: false, taken: null }
    }
    const t = from?.transitions.find((x) => x.id === pending.transition)
    if (t) {
      return { next: steps.find((s) => s.id === t.toStep), ends: t.toStep === null, taken: taken(t) }
    }
  }
  const next = stepStartedBy(steps, to.id)
  const t = from?.transitions.find((x) => x.status === to.id && x.toStep === (next?.id ?? null))
  return { next, ends: t?.toStep === null || (!next && to.category === 'done'), taken: t ? taken(t) : null }
}

/** Close a run's open step: its round ends, and what its session spent is recorded. */
async function closeStep(
  env: EngineEnv,
  run: WorkflowRun,
  open: RunStep,
  end: { outcome: string; finishedBy: string; taken: Move['taken'] },
): Promise<void> {
  const now = env.now()
  updateRunStep(env.db, run.id, open.stepId, {
    state: 'done',
    endedAt: now,
    outcome: end.outcome,
    finishedBy: open.finishedBy ?? end.finishedBy,
  })
  endRound(env.db, run.id, open.stepId, { at: now, by: 'transition', outcome: end.outcome, transition: end.taken })
  // Before the next step opens, possibly in the same thread: whether a turn
  // is still running is read while it can only be this round's. Never throws.
  await recordRoundUsage(env.db, env.chats, { runId: run.id, stepId: open.stepId, threadRef: open.threadRef })
}

async function advanceRun(env: EngineEnv, change: StatusChange): Promise<void> {
  const { db, projectKey } = env
  const run = activeRunForTask(db, projectKey, taskId(db, change.task.number))
  if (!run) {
    return
  }
  const workflow = getWorkflow(db, run.workflowId)
  const open = openStepOf(run)
  const from = workflow?.steps.find((s) => s.id === open?.stepId)
  const { next, ends, taken } = moveFor(workflow, from, takePendingMove(db, run.id), change.to)
  if (open && open.stepId !== next?.id) {
    await closeStep(env, run, open, { outcome: change.to.name, finishedBy: change.actor.name, taken })
  }
  if (workflow && next) {
    const reason = open && open.stepId !== next.id ? open.summary : null
    await enterStep(env, { run, workflow, step: next, task: change.task, cause: change, reason })
    return
  }
  if (ends) {
    endRun(db, run.id, 'finished', env.now())
    await tell(env, {
      kind: 'workflow_finished',
      taskNumber: change.task.number,
      recipients: [starterOf(run)],
      actor: change.actor,
      workflow: { name: run.workflowName },
      to: { name: change.to.name, category: change.to.category, color: change.to.color },
    })
  }
}

interface EnterInput {
  run: WorkflowRun
  workflow: WorkflowDef
  step: WorkflowStepDef
  task: TaskSummary
  /** The transition that brought the task here; absent when a run starts on the step's status or a step is restarted. */
  cause?: StatusChange
  /** What the step that handed the task over said about it, quoted to a step that gets it back. */
  reason?: string | null
}

/** A thread that cannot open in the space's chat, with the reason as it is shown and as the statistics count it. */
class SpaceChatProblem extends Error {
  readonly reason: CouldntStartReason

  constructor(problem: string, kind: SpaceChatProblemKind) {
    super(problem)
    // An agent missing from the chat is the session failing to open; the rest is the task manager's own access.
    this.reason = kind === 'agent_not_in_chat' ? 'session_failed' : 'not_in_chat'
  }
}

/** Who works a step for this task, or why nobody can. */
async function workerFor(
  env: EngineEnv,
  step: WorkflowStepDef,
  task: TaskSummary,
): Promise<{ nodeId: string; name: string } | { waiting: string }> {
  if (step.worker.kind === 'agent') {
    const agentNodeId = step.worker.agentNodeId
    let name = agentNodeId
    try {
      const chat = env.chats ? await findSpaceChat(env.chats, env.spaceSlug) : null
      // An agent outside the chat is named from the directory, so the reason it waits reads as a name.
      name =
        chat?.agents.find((a) => a.nodeId === agentNodeId)?.name ??
        (await env.agents?.())?.find((a) => a.id === agentNodeId)?.name ??
        agentNodeId
    } catch {
      // The name is for display and attribution checks; the thread start below reports a real failure.
    }
    return { nodeId: agentNodeId, name }
  }
  if (task.assignee?.kind === 'agent') {
    return { nodeId: task.assignee.id, name: task.assignee.name }
  }
  if (task.assignee?.kind === 'person') {
    return { waiting: `Assigned to ${task.assignee.name}, a person: there is no agent session to open` }
  }
  return { waiting: 'Nobody is assigned: assign an agent, then restart the step' }
}

function templateContext(env: EngineEnv, input: EnterInput): TemplateContext {
  const description =
    (
      env.db.prepare('SELECT description FROM task WHERE number = ?').get(input.task.number) as
        | { description: string }
        | undefined
    )?.description ?? ''
  const run = getRun(env.db, env.projectKey, input.run.id) ?? input.run
  const steps: TemplateContext['steps'] = {}
  for (const s of run.steps) {
    if (s.state === 'pending') {
      continue
    }
    steps[stepSlug(s.name)] = {
      outcome: s.outcome,
      summary: s.summary,
      agent: s.agentName,
      thread: s.threadRef,
    }
  }
  return {
    task: {
      key: input.task.key,
      summary: input.task.summary,
      description,
      status: input.task.status.name,
      type: input.task.type,
      priority: input.task.priority,
      assignee: input.task.assignee?.name ?? '',
      // The task's page, relative to the App's own address.
      url: `/task/${input.task.key}`,
    },
    step: { name: input.step.name },
    workflow: { name: input.workflow.name },
    steps,
  }
}

/**
 * Enter a step: open its session, or send the task back into the session it
 * already has. A failure to reach the chat is recorded on the step (and
 * rethrown, so the status change reports it as a warning) — the status change
 * itself stands, and "Restart step" retries once the cause is fixed.
 */
export async function enterStep(env: EngineEnv, input: EnterInput): Promise<void> {
  const { db, projectKey } = env
  const { run, workflow, step, task } = input
  const position = workflow.steps.findIndex((s) => s.id === step.id)
  ensureRunStep(db, run.id, step, position)
  const previous = getRun(db, projectKey, run.id)?.steps.find((s) => s.stepId === step.id)
  const attempts = (previous?.attempts ?? 0) + 1
  const now = env.now()
  if (step.kind === 'approval') {
    await awaitApproval(env, input, { attempts, now })
    return
  }
  const worker = await workerFor(env, step, task)

  if ('waiting' in worker) {
    updateRunStep(db, run.id, step.id, {
      name: step.name,
      state: 'waiting',
      startedAt: now,
      endedAt: null,
      outcome: null,
      finishedBy: null,
      attempts,
      error: worker.waiting,
    })
    const person = task.assignee?.kind === 'person' ? { kind: 'person' as const, name: task.assignee.name } : null
    enterRound(db, run.id, step.id, person, now)
    if (person) {
      await tell(env, {
        kind: 'step_waiting',
        taskNumber: task.number,
        recipients: ['assignee'],
        actor: input.cause?.actor ?? null,
        workflow: { name: workflow.name },
        step: { name: step.name },
      })
    } else {
      await attention(env, input, 'unassigned', worker.waiting)
    }
    return
  }

  updateRunStep(db, run.id, step.id, {
    name: step.name,
    state: 'active',
    agentNodeId: worker.nodeId,
    agentName: worker.name,
    startedAt: now,
    endedAt: null,
    outcome: null,
    summary: null,
    finishedBy: null,
    attempts,
    error: null,
  })
  enterRound(db, run.id, step.id, { kind: 'agent', name: worker.name }, now)

  const message = {
    app: env.app,
    taskKey: task.key,
    stepName: step.name,
    instructions: renderTemplate(step.instructions, templateContext(env, input)),
    transitions: step.transitions.map((t) => t.label),
  }
  // Sent on every entry, a reused thread's included: the session may be shared
  // with the agent's other steps on the task, which set their own. The
  // compaction threshold is the step's, not a setting of the session's.
  const { compactAbove: _threshold, ...hostOptions } = step.sessionOptions
  const sessionOptions = Object.keys(hostOptions).length > 0 ? hostOptions : undefined
  const recordSessionOptions = (outcome: SessionOptionsOutcome | undefined) => {
    if (outcome) {
      setRoundSessionOptions(db, run.id, step.id, outcome)
    }
  }
  // Set when the session is compacted first: the message then goes out after this entry returns.
  let deferred = false

  try {
    const where = await spaceChatFor(env.chats, env.spaceSlug, worker)
    if ('problem' in where || !env.chats) {
      throw 'problem' in where
        ? new SpaceChatProblem(where.problem, where.kind)
        : new SpaceChatProblem(NO_GROUP_CHATS, 'no_chats')
    }
    const { chat } = where
    const chats = env.chats
    const tid = taskId(db, task.number)
    const lane = { app: env.app, taskId: tid, agentId: worker.nodeId }
    await oneThreadAtATime(lane, async () => {
      // A thread in a chat other than the space's stays readable where it is; the task goes to a new one.
      // A reused thread also stays in whatever folder it is in: the step's folder only files a thread it opens.
      const own =
        previous?.threadRef && previous.agentNodeId === worker.nodeId && previous.chatSlug === chat.slug
          ? { ref: previous.threadRef, threadId: previous.threadId, chatRef: previous.chatRef }
          : null
      const recorded = own ?? agentTaskThread(db, { taskId: tid, agentId: worker.nodeId, chatSlug: chat.slug })
      // A thread archived when the task closed takes no messages; the step coming back reopens it first.
      // One the host refuses as unreachable is left, and the step opens a new thread.
      const reuse = recorded && (await reopenTaskThread(chats, recorded.ref)) ? recorded : null
      if (reuse) {
        const sentBack = input.cause
        updateRunStep(db, run.id, step.id, {
          threadRef: reuse.ref,
          threadId: reuse.threadId,
          chatRef: reuse.chatRef ?? chat.ref,
          chatSlug: chat.slug,
        })
        setRoundThread(db, run.id, step.id, reuse.ref)
        const deliver = async (compacted: boolean) => {
          // Queued behind the running turn: the agent that finished the previous step is usually still
          // writing its report, and pushing into that turn would cancel its pending tool calls.
          const sent = await chats.send({
            thread: reuse.ref,
            queue: 'wait',
            sessionOptions,
            // The step's own thread gets the task back for rework; any other thread of the agent's gets the step as new.
            message: own
              ? reworkMessage({
                  ...message,
                  attempt: attempts,
                  from: sentBack?.from.name ?? task.status.name,
                  movedBy: sentBack?.actor.name ?? 'The workflow',
                  reason: input.reason ?? null,
                  compacted,
                })
              : openingMessage(message),
          })
          recordSessionOptions(sent?.sessionOptions)
        }
        const over = await contextOverThreshold(chats, step.sessionOptions, reuse.ref, env.now())
        if (!over) {
          await deliver(false)
          return
        }
        // Not awaited: a compaction waits for the session's running turn, which can be the very turn
        // whose step finish brought the task here. Queued on the same lane, so it runs next, ahead of
        // any later entry into this thread.
        const roundNo = startRoundCompaction(
          db,
          run.id,
          step.id,
          { outcome: 'running', threshold: over.threshold, before: over.tokens, after: null, error: null },
          processMark(),
        )
        if (roundNo === null) {
          return
        }
        deferred = true
        void oneThreadAtATime(lane, () =>
          compactThenDeliver(env, input, worker, { thread: reuse.ref, roundNo, ...over }, deliver),
        )
        return
      }
      const started = await openTaskThread(task.key, (title) =>
        chats.startThread({
          chat: chat.ref,
          agentNodeId: worker.nodeId,
          title,
          message: openingMessage(message),
          folder: step.folder || undefined,
          sessionOptions,
        }),
      )
      const { thread } = started
      updateRunStep(db, run.id, step.id, {
        threadRef: thread.ref,
        threadId: thread.threadId,
        chatRef: thread.chat.ref,
        chatSlug: thread.chat.slug,
      })
      setRoundThread(db, run.id, step.id, thread.ref)
      recordSessionOptions(started.sessionOptions)
    })
  } catch (error) {
    const hint = await sessionUnreachable(env, input, error)
    throw new Error(`${task.key} ${step.name}: ${hint}`)
  }
  if (!deferred) {
    await stepOpened(env, input, worker)
  }
}

/**
 * The step's session could not be opened or messaged: the step waits with
 * the reason, its round records it, and the people who should hear do.
 * Answers the reason as shown.
 */
async function sessionUnreachable(env: EngineEnv, input: StepOfRun, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : String(error)
  // The host answers "Not available" for a chat the task manager may not post in, e.g. one it was removed from since it was checked.
  const refused = !(error instanceof SpaceChatProblem) && isUnreachable(error)
  const hint = refused ? notInSpaceChat(env.spaceSlug) : reason
  updateRunStep(env.db, input.run.id, input.step.id, { state: 'waiting', error: hint })
  const why = error instanceof SpaceChatProblem ? error.reason : refused ? 'not_in_chat' : 'session_failed'
  await attention(env, input, why, hint)
  return hint
}

/**
 * Compact the step's session, record how that went, then send the round's
 * message whichever way it went — unless the round ended meanwhile. Runs
 * after the step was entered, so nothing waits on it; a message that cannot
 * be sent is recorded on the step as an entry's would be, and on the
 * compaction, which would otherwise read as followed by the message.
 */
async function compactThenDeliver(
  env: EngineEnv,
  input: EnterInput,
  worker: { nodeId: string; name: string },
  session: { thread: string; roundNo: number; threshold: number; tokens: number },
  deliver: (compacted: boolean) => Promise<void>,
): Promise<void> {
  const { run, step } = input
  const result = await compactSession(env.chats ?? {}, session.thread)
  const open = endRoundCompaction(env.db, run.id, step.id, session.roundNo, {
    outcome: result.outcome,
    threshold: session.threshold,
    before: result.contextBefore ?? session.tokens,
    after: result.contextAfter,
    error: result.error ?? null,
  })
  if (!open) {
    return
  }
  try {
    // Told whenever the session may have dropped what it held, so the agent re-reads the task first.
    await deliver(result.outcome === 'compacted' || result.outcome === 'unknown')
  } catch (error) {
    markCompactionUnsent(env.db, run.id, step.id, session.roundNo)
    const hint = await sessionUnreachable(env, input, error)
    console.error(`[task-pipelines] ${input.task.key} ${step.name}: ${hint}`)
    return
  }
  await stepOpened(env, input, worker)
}

/**
 * Compactions a restart cut off: the process that would have ended them, and
 * sent their rounds' messages, is gone. Each is recorded as failed, with its
 * message unsent. A round
 * still open never got its message, so its step waits with the reason, and
 * the run's starter and the task's reporter hear it, as for a session that
 * could not be reached; restarting the step sends it. Compactions this
 * process is still running are left alone. Answers how many were recovered.
 */
export async function recoverInterruptedCompactions(env: EngineEnv): Promise<number> {
  const orphans = orphanedCompactions(env.db, processMark())
  for (const orphan of orphans) {
    const open = endRoundCompaction(env.db, orphan.runId, orphan.stepId, orphan.roundNo, {
      ...orphan.compaction,
      outcome: 'failed',
      error: INTERRUPTED_COMPACTION,
      unsent: true,
    })
    const run = getRun(env.db, env.projectKey, orphan.runId)
    const step = run?.steps.find((s) => s.stepId === orphan.stepId)
    if (!open || !run || run.state !== 'active' || step?.state !== 'active') {
      continue
    }
    const { number } = env.db
      .prepare('SELECT t.number FROM workflow_run r JOIN task t ON t.id = r.task_id WHERE r.id = ?')
      .get(run.id) as { number: number }
    await sessionUnreachable(
      env,
      { run, workflow: { name: run.workflowName }, step: { id: step.stepId, name: step.name }, task: { number } },
      new Error(INTERRUPTED_ROUND),
    )
  }
  return orphans.length
}

/**
 * Enter an approval step: no session opens. The step waits on its approvers,
 * and each of them is asked for a decision. A round re-entered in place (a
 * restart) keeps the decisions already made in it.
 */
async function awaitApproval(
  env: EngineEnv,
  input: EnterInput,
  entry: { attempts: number; now: string },
): Promise<void> {
  const { run, workflow, step, task } = input
  updateRunStep(env.db, run.id, step.id, {
    name: step.name,
    state: 'waiting',
    agentNodeId: null,
    agentName: null,
    startedAt: entry.now,
    endedAt: null,
    outcome: null,
    summary: null,
    finishedBy: null,
    attempts: entry.attempts,
    error: null,
  })
  enterRound(env.db, run.id, step.id, null, entry.now)
  await tell(env, {
    kind: 'approval_requested',
    taskNumber: task.number,
    recipients: (step.approval?.approvers ?? []).map((a) => ({
      kind: 'person' as const,
      id: a.personId,
      name: a.name,
    })),
    actor: input.cause?.actor ?? null,
    workflow: { name: workflow.name },
    step: { name: step.name },
  })
}

/** The step's session has the task: its agent's inbox says so. */
function stepOpened(env: EngineEnv, input: EnterInput, worker: { nodeId: string; name: string }): Promise<void> {
  return tell(env, {
    kind: 'step_open',
    taskNumber: input.task.number,
    recipients: [{ kind: 'agent', id: worker.nodeId, name: worker.name }],
    actor: input.cause?.actor ?? null,
    workflow: { name: input.workflow.name },
    step: { name: input.step.name },
  })
}

/**
 * Start a workflow on a task. The run begins at the step for the task's
 * current status when there is one; otherwise the task moves to the first
 * step's status, and the status change opens it like any other.
 */
export async function startWorkflow(
  env: EngineEnv,
  tasks: TaskPort,
  input: { task: TaskSummary; workflow?: string; actor: Actor },
): Promise<WorkflowRun> {
  const { db, projectKey } = env
  const workflow = input.workflow ? findWorkflow(db, input.workflow) : defaultWorkflow(db)
  if (!workflow) {
    throw new Error(
      input.workflow
        ? `No workflow "${input.workflow}" in this project; workflows_list shows them`
        : 'This project has no workflows yet: create one on the Workflows page, or with workflow_save',
    )
  }
  if (workflow.steps.length === 0) {
    throw new Error(`Workflow "${workflow.name}" has no steps`)
  }
  const runId = createRun(db, {
    taskId: taskId(db, input.task.number),
    workflow,
    startedBy: input.actor,
    now: env.now(),
  })
  const run = getRun(db, projectKey, runId)
  if (!run) {
    throw new Error('The run was created but cannot be read back')
  }
  const here = stepStartedBy(workflow.steps, input.task.status.id)
  if (here) {
    try {
      await enterStep(env, { run, workflow, step: here, task: input.task })
    } catch {
      // Recorded on the step, which the returned run shows; the run itself has started.
    }
  } else {
    await tasks.changeStatus({ key: input.task.key, status: workflow.steps[0].triggerStatus })
  }
  return getRun(db, projectKey, runId) ?? run
}

/**
 * Find the transition a finishing agent named: by id or label, or by the
 * status it sets. A status two transitions set means the one into the step
 * that status starts, as a person's move to it would.
 */
function resolveTransition(
  all: Status[],
  steps: WorkflowStepDef[],
  step: WorkflowStepDef,
  transition: string | number,
): WorkflowTransition {
  const ref = String(transition).trim()
  const wanted = ref.toLowerCase()
  const named =
    step.transitions.find((t) => t.id === ref) ?? step.transitions.find((t) => t.label.toLowerCase() === wanted)
  if (named) {
    return named
  }
  const byStatus = step.transitions.filter(
    (t) => String(t.status) === wanted || statusName(all, t.status).toLowerCase() === wanted,
  )
  const match =
    byStatus.length > 1 ? byStatus.find((t) => t.toStep === (stepStartedBy(steps, t.status)?.id ?? null)) : byStatus[0]
  if (!match) {
    throw new Error(`"${transition}" is not a way out of "${step.name}"; choose one of: ${transitionList(step)}`)
  }
  return match
}

/**
 * Finish the open step with one of its transitions. An agent may finish only
 * the step it is working; a person (the task panel's Advance) may finish any
 * open step. The summary is recorded on the step before the status moves, so
 * the next step's instructions and rework message can quote it.
 */
export async function finishStep(
  env: EngineEnv,
  tasks: TaskPort,
  input: { task: TaskSummary; transition: string | number; summary?: string; actor: Actor },
): Promise<WorkflowRun> {
  const { db, projectKey } = env
  const run = activeRunForTask(db, projectKey, taskId(db, input.task.number))
  if (!run) {
    throw new Error(`${input.task.key} is not running a workflow`)
  }
  const open = openStepOf(run)
  const workflow = getWorkflow(db, run.workflowId)
  const step = open ? workflow?.steps.find((s) => s.id === open.stepId) : undefined
  if (!open || !workflow || !step) {
    throw new Error(`${input.task.key} has no open step to finish`)
  }
  if (step.kind === 'approval') {
    throw new Error(
      `"${step.name}" is an approval step: its approvers decide it from the task, with workflow_step_decide`,
    )
  }
  if (input.actor.kind === 'agent' && open.agentName !== input.actor.name) {
    throw new Error(
      `The open step "${open.name}" of ${input.task.key} is worked by ${open.agentName ?? 'nobody yet'}, not ${input.actor.name}`,
    )
  }
  const transition = resolveTransition(statuses(db), workflow.steps, step, input.transition)
  const summary = input.summary?.trim() || null
  transaction(db, () => {
    updateRunStep(db, run.id, open.stepId, { summary, finishedBy: input.actor.name })
  })
  await moveTask(
    env,
    tasks,
    run,
    input.task,
    { status: transition.status, transition: transition.id },
    summary,
    input.actor,
  )
  return getRun(db, projectKey, run.id) ?? run
}

/** The transition a verdict takes: the one named, or the only one the verdict has. */
function verdictTransition(
  steps: WorkflowStepDef[],
  step: WorkflowStepDef,
  verdict: ApprovalVerdict,
  ref: string | undefined,
): WorkflowTransition {
  const options = verdictTransitions(steps, step)[verdict]
  const list = options.map((t) => `"${t.label}"`).join(', ')
  if (ref === undefined) {
    if (options.length === 1) {
      return options[0]
    }
    throw new Error(
      options.length === 0
        ? `"${step.name}" has no transition to ${verdict} by`
        : `"${step.name}" can ${verdict} by several transitions: pass "transition" as one of ${list}`,
    )
  }
  const wanted = ref.trim().toLowerCase()
  const match = options.find((t) => t.id === ref.trim() || t.label.toLowerCase() === wanted)
  if (!match) {
    throw new Error(`"${ref}" is not a way to ${verdict} "${step.name}"; choose one of: ${list}`)
  }
  return match
}

/**
 * The decision that settled a round, the latest one with the outcome's
 * verdict, and the transition it chose: where the step leaves by. A chosen
 * transition the workflow no longer has for that verdict (removed, or its gate
 * changed since) is refused rather than replaced by another: the approver
 * decides again, which replaces their decision.
 */
function settlingDecision(
  steps: WorkflowStepDef[],
  step: WorkflowStepDef,
  decisions: ApprovalDecision[],
  gate: TransitionGate,
): { decision: ApprovalDecision; transition: WorkflowTransition } {
  const verdict = APPROVAL_VERDICTS.find((v) => VERDICT_GATE[v] === gate)
  if (!verdict) {
    throw new Error(`"${step.name}" was settled by a ${gate} gate, which no verdict leaves by`)
  }
  const decision = [...decisions].reverse().find((d) => d.verdict === verdict)
  if (!decision) {
    throw new Error(`"${step.name}" was settled to ${verdict} with no decision to ${verdict}`)
  }
  const transition = verdictTransitions(steps, step)[verdict].find((t) => t.id === decision.transitionId)
  if (!transition) {
    throw new Error(
      `"${decision.transition}", which ${decision.approver.name} chose, is no longer a way to ${verdict} "${step.name}": ${decision.approver.name} must decide again`,
    )
  }
  return { decision, transition }
}

/**
 * An approver decides an approval step: Approve or Reject, by one of the
 * transitions the verdict may take. The decision is recorded on the open
 * round; when it settles the round (see `approvalOutcome`), the task moves by
 * the settling decision's transition and its comment becomes the step's summary.
 * Only the step's approvers decide, and only as themselves.
 */
export async function decideStep(
  env: EngineEnv,
  tasks: TaskPort,
  input: {
    task: TaskSummary
    verdict: ApprovalVerdict
    transition?: string
    comment?: string
    /** The signed-in person deciding; null for anyone else (an agent, an internal call). */
    person: { id: string; name: string } | null
  },
): Promise<WorkflowRun> {
  const { db, projectKey } = env
  const key = input.task.key
  const run = activeRunForTask(db, projectKey, taskId(db, input.task.number))
  if (!run) {
    throw new Error(`${key} is not running a workflow`)
  }
  const open = openStepOf(run)
  const workflow = getWorkflow(db, run.workflowId)
  const step = open ? workflow?.steps.find((s) => s.id === open.stepId) : undefined
  if (!open || !workflow || !step?.approval) {
    throw new Error(open ? `"${open.name}" of ${key} is not an approval step` : `${key} has no open step to decide`)
  }
  const person = input.person
  if (!person) {
    throw new Error('Only a person can approve or reject: decide from the task, signed in')
  }
  const approver = step.approval.approvers.find((a) => a.personId === person.id)
  if (!approver) {
    throw new Error(
      `You aren't an approver of "${step.name}". Its approvers: ${step.approval.approvers.map((a) => a.name).join(', ')}`,
    )
  }
  if (hasPendingMove(db, run.id)) {
    throw new Error(`"${step.name}" has just been decided: ${key} is moving on`)
  }
  const transition = verdictTransition(workflow.steps, step, input.verdict, input.transition)
  const comment = input.comment?.trim() || null
  recordDecision(db, run.id, step.id, {
    approver: { personId: person.id, name: person.name },
    verdict: input.verdict,
    transition,
    comment,
    at: env.now(),
  })
  const decisions =
    getRun(db, projectKey, run.id)
      ?.steps.find((s) => s.stepId === step.id)
      ?.rounds.at(-1)?.decisions ?? []
  const gate = approvalOutcome(step.approval, decisions)
  if (gate === null) {
    return getRun(db, projectKey, run.id) ?? run
  }
  const settled = settlingDecision(workflow.steps, step, decisions, gate)
  const summary = settled.decision.comment
  updateRunStep(db, run.id, open.stepId, { summary, finishedBy: settled.decision.approver.name })
  await moveTask(
    env,
    tasks,
    run,
    input.task,
    { status: settled.transition.status, transition: settled.transition.id },
    summary,
    {
      kind: 'person',
      name: person.name,
    },
  )
  return getRun(db, projectKey, run.id) ?? run
}

/**
 * Move the task as the workflow asks: the move is held on the run, then the
 * task model changes the status and its hook advances the run. A move that
 * keeps the task's status changes nothing the hook hears, so it advances the
 * run here, the same way.
 */
async function moveTask(
  env: EngineEnv,
  tasks: TaskPort,
  run: WorkflowRun,
  task: TaskSummary,
  move: PendingMove,
  comment: string | null,
  actor: Actor,
): Promise<void> {
  setPendingMove(env.db, run.id, move)
  try {
    await tasks.changeStatus({ key: task.key, status: move.status, comment: comment ?? undefined })
  } catch (error) {
    setPendingMove(env.db, run.id, null)
    throw error
  }
  if (move.status === task.status.id) {
    await advanceRun(env, { task, from: task.status, to: task.status, actor })
  }
}

/**
 * Restart a step. A step the task's current status starts is re-entered in
 * place (its session gets the task again, or is opened if it never was),
 * closing another step that is open. Any other step is reached the way a
 * step is reached: the task moves to the step's status. An agent cannot close
 * an open approval step either way: in place it is refused here, and a move
 * is refused by the status hook.
 */
export async function restartStep(
  env: EngineEnv,
  tasks: TaskPort,
  input: { task: TaskSummary; step: string; actor: Actor },
): Promise<WorkflowRun> {
  const { db, projectKey } = env
  const run = activeRunForTask(db, projectKey, taskId(db, input.task.number))
  if (!run) {
    throw new Error(`${input.task.key} is not running a workflow`)
  }
  const workflow = getWorkflow(db, run.workflowId)
  const wanted = input.step.trim().toLowerCase()
  const step = workflow?.steps.find((s) => s.id === input.step || s.name.toLowerCase() === wanted)
  if (!workflow || !step) {
    throw new Error(`No step "${input.step}" in this run's workflow`)
  }
  if (step.triggerStatus === input.task.status.id) {
    const open = openStepOf(run)
    const openDef = open ? workflow.steps.find((s) => s.id === open.stepId) : undefined
    // Closing an open approval step in place would end it with no decision; only people may override its approvers.
    if (input.actor.kind === 'agent' && open && open.stepId !== step.id && openDef?.kind === 'approval') {
      throw new Error(
        `${input.task.key} waits on the approvers of "${open.name}": only people can move it on until they decide`,
      )
    }
    if (open && open.stepId !== step.id) {
      await closeStep(env, run, open, { outcome: input.task.status.name, finishedBy: input.actor.name, taken: null })
    }
    await enterStep(env, { run, workflow, step, task: input.task })
  } else {
    await moveTask(env, tasks, run, input.task, { status: step.triggerStatus, step: step.id }, null, input.actor)
  }
  return getRun(db, projectKey, run.id) ?? run
}

/** Cancel a task's active run; the open step's session is told to stop. */
export async function cancelRun(env: EngineEnv, input: { task: TaskSummary; actor: Actor }): Promise<WorkflowRun> {
  const { db, projectKey } = env
  const run = activeRunForTask(db, projectKey, taskId(db, input.task.number))
  if (!run) {
    throw new Error(`${input.task.key} is not running a workflow`)
  }
  const now = env.now()
  const open = openStepOf(run)
  transaction(db, () => {
    if (open) {
      updateRunStep(db, run.id, open.stepId, {
        state: 'done',
        endedAt: now,
        outcome: 'Cancelled',
        finishedBy: input.actor.name,
      })
      endRound(db, run.id, open.stepId, { at: now, by: 'cancel', outcome: 'Cancelled' })
    }
    endRun(db, run.id, 'cancelled', now)
  })
  if (open) {
    await recordRoundUsage(db, env.chats, { runId: run.id, stepId: open.stepId, threadRef: open.threadRef })
  }
  await tell(env, {
    kind: 'workflow_cancelled',
    taskNumber: input.task.number,
    recipients: [starterOf(run)],
    actor: input.actor,
    workflow: { name: run.workflowName },
  })
  if (open?.threadRef && env.chats) {
    try {
      await env.chats.send({
        thread: open.threadRef,
        message: cancelledMessage({ taskKey: input.task.key, by: input.actor.name }),
      })
    } catch {
      // The run is cancelled either way; a session that cannot be told is only a missed courtesy.
    }
  }
  return getRun(db, projectKey, run.id) ?? run
}
