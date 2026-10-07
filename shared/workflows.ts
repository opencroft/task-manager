/**
 * Workflow types shared by the server (storage, engine, actions) and the
 * client (Workflows page, task panel), with the few pure rules both sides
 * apply to them. Nothing here touches storage or the DOM, so either side can
 * import it without pulling the other's code along.
 *
 * A workflow is a project's process for working a task: an ordered list of
 * steps. A step is left by one of its transitions, each an edge to the step
 * that opens next (or to the end of the run) that also sets the task's
 * status. A person moving the task to a status opens the first step started
 * by that status. A run binds one workflow to one task; each agent step of a
 * run gets its own agent session (a thread in the space's group chat), reused
 * if the task comes back to that step. An approval step has no session: its
 * approvers, people, decide which transition it leaves by.
 */

import type { StatusRef } from './types.ts'

/**
 * A new step's instructions when none are given. The opening message is the
 * instructions alone, so this is what names the task to the step's agent.
 */
export const DEFAULT_STEP_INSTRUCTIONS = '{{ task.key }}: {{ task.summary }}'

/** Reasoning effort, in the chat command bar's vocabulary. */
export const STEP_EFFORTS = ['max', 'extra', 'high', 'medium', 'low', 'default', 'off'] as const
export type StepEffort = (typeof STEP_EFFORTS)[number]

/** Permission mode, in the chat command bar's vocabulary. */
export const STEP_PERMISSION_MODES = ['auto', 'plan', 'manual-edits', 'accept-edits', 'reject-edits', 'bypass'] as const
export type StepPermissionMode = (typeof STEP_PERMISSION_MODES)[number]

/** How often the session's agent reads what is sent to it: the chat command bar's Presence. */
export const STEP_PRESENCE_KINDS = ['high-attention', 'realtime', 'online', 'minutes', 'hourly', 'daily', 'custom'] as const
export type StepPresence =
  | { kind: Exclude<(typeof STEP_PRESENCE_KINDS)[number], 'custom'> }
  | { kind: 'custom'; intervalMs: number }

/** The context, in tokens, above which a step compacts its session before a round when it sets no threshold of its own. */
export const DEFAULT_COMPACT_ABOVE = 200_000

/**
 * The chat command bar's settings a step applies to its session every time
 * the step is entered, before its message is sent. One left out leaves the
 * session's own setting as it is. A value the session's agent does not offer
 * is skipped when the step is entered, and the round records it.
 *
 * `compactAbove` is the step's own, not the command bar's: when the step is
 * entered into a session it already has, and that session holds more context
 * than this many tokens, the session is compacted before the round's message.
 * Absent: `DEFAULT_COMPACT_ABOVE`. 0: never.
 */
export interface StepSessionOptions {
  effort?: StepEffort
  presence?: StepPresence
  permissionMode?: StepPermissionMode
  compactAbove?: number
}

/** The context above which a step compacts its session before a round, or null when it never does. */
export function compactThreshold(options: StepSessionOptions): number | null {
  const above = options.compactAbove ?? DEFAULT_COMPACT_ABOVE
  return above > 0 ? above : null
}

/**
 * How a compaction of a step's session before a round ended, as the host
 * reported it. `running` until it ends. `compacted`: the context shrank;
 * `not_compacted`: it did not; `unknown`: there was no reading to tell by;
 * `failed`: it errored; `timed_out`: it had not ended when the wait for it gave up.
 * The round's message is sent after it whichever way it ends.
 */
export const COMPACTION_OUTCOMES = ['running', 'compacted', 'not_compacted', 'unknown', 'failed', 'timed_out'] as const
export type CompactionOutcome = (typeof COMPACTION_OUTCOMES)[number]

/** A compaction of the step's session before a round's message. */
export interface RoundCompaction {
  outcome: CompactionOutcome
  /** The step's threshold the session's context was over. */
  threshold: number
  /** Context tokens before and after the compaction; null when not known. */
  before: number | null
  after: number | null
  /** Why it failed or could not be told. */
  error: string | null
  /**
   * Set when the round's message was not sent after it: a restart cut the
   * compaction off, or the session could not be messaged. Its step waited
   * with the reason; restarting the step sends the message.
   */
  unsent?: true
}

/** What became of a round's session options, as the host reported it. */
export interface SessionOptionsOutcome {
  applied: Array<keyof StepSessionOptions>
  skipped: Array<{ option: keyof StepSessionOptions; reason: string }>
}

/** Who works a step: whoever the task is assigned to, or one fixed agent node. */
export type StepWorker = { kind: 'assignee' } | { kind: 'agent'; agentNodeId: string }

/**
 * A transition's gate result: `pass` lets the task move on, `fail` sends it
 * back. What a run shows for the round that left a step by the transition.
 */
export const TRANSITION_GATES = ['pass', 'fail'] as const
export type TransitionGate = (typeof TRANSITION_GATES)[number]

/**
 * What works a step. `agent`: a session of the step's worker. `approval`:
 * people, its approvers, each approving or rejecting the task; no session.
 */
export const STEP_KINDS = ['agent', 'approval'] as const
export type StepKind = (typeof STEP_KINDS)[number]

/** A person who decides an approval step, by the host's directory user id. */
export interface StepApprover {
  personId: string
  /** The person's name when the step was saved; the id is what identifies them. */
  name: string
  /** A required approver must approve for the step to pass. */
  required: boolean
}

/** Who decides an approval step and how many approvals pass it. */
export interface StepApproval {
  approvers: StepApprover[]
  /** Approvals that pass the step, required ones included: at least the required count, at most every approver. */
  needed: number
}

export const APPROVAL_VERDICTS = ['approve', 'reject'] as const
export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number]

/** The gate of the transitions a verdict may take: Approve leaves by a pass, Reject by a fail. */
export const VERDICT_GATE: Record<ApprovalVerdict, TransitionGate> = { approve: 'pass', reject: 'fail' }

/** One approver's decision in a round of an approval step. */
export interface ApprovalDecision {
  approver: { personId: string; name: string }
  verdict: ApprovalVerdict
  /** The id of the transition the approver chose: what a settling decision moves the task by. */
  transitionId: string
  /** That transition's label, as it read then. */
  transition: string
  comment: string | null
  at: string
}

/**
 * Where an approval step's round stands after its decisions: `pass` once every
 * required approver approved and the approvals reach `needed`; `fail` as soon
 * as any approver rejects; null while undecided. Decisions by someone who is
 * no longer an approver do not count. The engine applies it when a decision is
 * made, against the step as it is then: editing the approvers or the number
 * while a round is open settles nothing until the next decision.
 */
export function approvalOutcome(
  approval: StepApproval,
  decisions: ReadonlyArray<Pick<ApprovalDecision, 'approver' | 'verdict'>>,
): TransitionGate | null {
  const approvers = new Map(approval.approvers.map((a) => [a.personId, a]))
  const counted = decisions.filter((d) => approvers.has(d.approver.personId))
  if (counted.some((d) => d.verdict === 'reject')) {
    return 'fail'
  }
  const approved = new Set(counted.map((d) => d.approver.personId))
  const requiredMet = approval.approvers.every((a) => !a.required || approved.has(a.personId))
  return requiredMet && approved.size >= approval.needed ? 'pass' : null
}

/** An open approval step as `workflow_run_get` shows it: where its round stands, and what the caller may decide. */
export interface OpenApproval {
  needed: number
  /** Every approver, with their decision in the open round, if any. */
  approvers: Array<StepApprover & { decision: ApprovalDecision | null }>
  /** Labels of the transitions each verdict may take, in the step's order. */
  transitions: Record<ApprovalVerdict, string[]>
  /** Whether the caller is one of the approvers. */
  canDecide: boolean
  /** The caller's person id, to find their own decision; null for anyone but a signed-in person. */
  viewerId: string | null
}

/** One way out of a step: the edge its agent names to finish it. */
export interface WorkflowTransition {
  /** Unique within the workflow. */
  id: string
  /** What the agent picks it by and the run shows, e.g. "Back to Design". Unique within the step (case-insensitive). */
  label: string
  /** Id of the step that opens next; null ends the run. */
  toStep: string | null
  /** Id of the status the task moves to. */
  status: number
  /** Set: an override. Null: derived from the graph (see `transitionGate`). */
  gate: TransitionGate | null
}

export interface WorkflowStepDef {
  id: string
  name: string
  kind: StepKind
  /** An approval step's approvers; null for an agent step. An approval step has no worker, instructions, folder or session options. */
  approval: StepApproval | null
  /**
   * Id of the status whose ENTRY starts this step when a person moves the task
   * there. Several steps may share one; that move then opens the first of them.
   */
  triggerStatus: number
  worker: StepWorker
  /**
   * The session's opening message as written, placeholders filled (see `server/workflows/template.ts`).
   * Nothing about the task is added to it; only how to finish the step follows it.
   */
  instructions: string
  /** The ways the step's agent may finish it, in the order offered. */
  transitions: WorkflowTransition[]
  /**
   * The thread-list folder of the space's chat the step's thread is filed in, by the name a
   * person sees there; empty for the top level. Matched exactly, and made when the chat has none.
   */
  folder: string
  /** Settings applied to the step's session before its message; `{}` changes none. */
  sessionOptions: StepSessionOptions
}

/**
 * The space's chat: where every workflow step, mention session and the
 * project chat open their threads. It is the group chat at the space's own
 * address (its slug is the space's slug); the task manager never creates it.
 */
export interface SpaceChatState {
  /** The space's slug, which is the chat's. */
  slug: string
  /** The chat's id, which its page is addressed by; null with `name`. */
  ref: string | null
  /** Null when neither the task manager nor the caller is in a chat at that address (or none exists yet). */
  name: string | null
  /** Whether the task manager's own identity is a member, so it can open threads there. */
  taskManagerIn: boolean
  /** The chat's agent members, as far as the task manager or the caller can see them. */
  agents: Array<{ nodeId: string; name: string }>
  /** For a signed-in person: whether they are in the chat, and so can let the task manager in. Null for anyone else. */
  youAreIn: boolean | null
}

export interface WorkflowDef {
  id: string
  name: string
  description: string
  /** The workflow a task runs when it starts one without naming it. Exactly one per project once any exist. */
  isDefault: boolean
  steps: WorkflowStepDef[]
  createdAt: string
  updatedAt: string
}

/**
 * What a caller submits to create or replace a workflow: ids are optional, a missing one is minted.
 * Statuses may be given by id or by name (case-insensitive); the saved definition holds ids.
 */
export interface WorkflowDraft {
  id?: string
  name: string
  description?: string
  isDefault?: boolean
  steps: WorkflowStepDraft[]
}

export type WorkflowStepDraft = Omit<
  WorkflowStepDef,
  'id' | 'kind' | 'approval' | 'worker' | 'triggerStatus' | 'transitions' | 'folder' | 'instructions' | 'sessionOptions'
> & {
  /** Omitted: `agent`. */
  kind?: StepKind
  /** An approval step's approvers; ignored for an agent step. */
  approval?: StepApprovalDraft | null
  /** An agent step's worker; ignored for an approval step. */
  worker?: StepWorker
  /** Omitted: none. */
  sessionOptions?: StepSessionOptions
  id?: string
  triggerStatus: StatusRef
  /** A bare status is the transition `{ status }`. */
  transitions: Array<StatusRef | WorkflowTransitionDraft>
  /** Omitted: `DEFAULT_STEP_INSTRUCTIONS`. An empty string stays empty. */
  instructions?: string
  /** Omitted or blank: the top level. */
  folder?: string
}

/** An approval step's approvers as a caller submits them. */
export interface StepApprovalDraft {
  /** Each a person by directory user id or by name; `required` omitted is optional. */
  approvers: Array<{ personId?: string; name?: string; required?: boolean }>
  /** Omitted: the required approvers' count, at least 1. */
  needed?: number
}

/** A transition as a caller submits it. */
export interface WorkflowTransitionDraft {
  /** Omitted: minted. */
  id?: string
  /** Omitted or blank: `defaultTransitionLabel`. */
  label?: string
  /**
   * The step that opens next, by id or name; null or "end" ends the run.
   * Omitted: the first step `status` starts, or the end when no step starts on it.
   */
  toStep?: string | null
  status: StatusRef
  /** Omitted or null: derived from the graph. */
  gate?: TransitionGate | null
}

/**
 * The gate a transition has when none is set: moving on to a later step, or
 * ending the run, passes; going back to the same or an earlier step fails.
 */
export function derivedGate(steps: ReadonlyArray<{ id: string }>, fromStep: string, toStep: string | null): TransitionGate {
  if (toStep === null) {
    return 'pass'
  }
  return steps.findIndex((s) => s.id === toStep) > steps.findIndex((s) => s.id === fromStep) ? 'pass' : 'fail'
}

/** A transition's gate: its override, or the one the graph gives it. */
export function transitionGate(
  steps: ReadonlyArray<{ id: string }>,
  fromStep: string,
  transition: Pick<WorkflowTransition, 'toStep' | 'gate'>,
): TransitionGate {
  return transition.gate ?? derivedGate(steps, fromStep, transition.toStep)
}

/** The transitions each verdict of an approval step may take: Approve its pass gates, Reject its fail gates, in the step's order. */
export function verdictTransitions<T extends Pick<WorkflowTransition, 'toStep' | 'gate'>>(
  steps: ReadonlyArray<{ id: string }>,
  step: { id: string; transitions: readonly T[] },
): Record<ApprovalVerdict, T[]> {
  const by = (verdict: ApprovalVerdict) => step.transitions.filter((t) => transitionGate(steps, step.id, t) === VERDICT_GATE[verdict])
  return { approve: by('approve'), reject: by('reject') }
}

/** The first step a status starts: what a person moving the task to that status opens. */
export function stepStartedBy<S extends Pick<WorkflowStepDef, 'triggerStatus'>>(steps: readonly S[], status: number): S | undefined {
  return steps.find((s) => s.triggerStatus === status)
}

/** A transition's label when none is given, from where it leads. */
export function defaultTransitionLabel(gate: TransitionGate, to: { step: string } | { endStatus: string }): string {
  if ('endStatus' in to) {
    return `Finish: ${to.endStatus}`
  }
  return gate === 'pass' ? `On to ${to.step}` : `Back to ${to.step}`
}

export type RunState = 'active' | 'finished' | 'cancelled'

/**
 * `pending`: not reached yet. `active`: its session is working. `waiting`: reached, but there is
 * no agent to open a session for (the assignee is a person, or nobody). `done`: finished with an
 * outcome.
 */
export type RunStepState = 'pending' | 'active' | 'waiting' | 'done'

/** Tokens spent, summed from a session's chat turns (each turn's own spend). */
export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/**
 * What an agent's session spent, from the chat's own turn records: nothing
 * the agent reports. `cost` has one entry per currency the turns were priced
 * in (in practice one), and is empty when no turn was priced.
 */
export interface Usage {
  turns: number
  tokens: UsageTokens
  cost: Array<{ amount: number; currency: string }>
}

/**
 * How final a round's usage is. `settled`: its finishing turn is counted.
 * `pending`: the round ended while its session was still in a turn, so the
 * figures lack that turn until it ends. `live`: the round is still open, read
 * as of now. `shared`: the round happened inside a turn an earlier round on
 * its thread counted (an agent that takes the next step's message mid-turn),
 * so it has no figures of its own; `sharedWith` names that round's step.
 */
export type RoundUsageState = 'settled' | 'pending' | 'live' | 'shared'

/** One entry into a step: who worked it, for how long, and what its session spent. */
export interface RunRound {
  roundNo: number
  worker: { kind: 'agent' | 'person'; name: string } | null
  startedAt: string
  endedAt: string | null
  /** 'transition': the task left the step's status; 'cancel': the run was cancelled. */
  endedBy: 'transition' | 'cancel' | null
  /** Name of the status the task moved to when the round ended. */
  outcome: string | null
  /**
   * The step's transition the round ended by, as its label read then; null for
   * a round still open, cancelled, or ended by a status move no transition matches.
   */
  transition: string | null
  /** That transition's gate result; null with `transition`. */
  gate: TransitionGate | null
  /** An approval step's decisions in this round, oldest first; empty for an agent step. */
  decisions: ApprovalDecision[]
  /** Wall time: from entering the step until the round ended, or until now while open. */
  timeMs: number
  /** Null for a round with no agent session: a person's round, one nobody could work, or a host that offers no usage. */
  usage: (Usage & { state: RoundUsageState; sharedWith?: string }) | null
  /** What became of the step's session options when the round's message went out; null when it carried none. */
  sessionOptions: SessionOptionsOutcome | null
  /** Context tokens the round's session held when the round ended, or now while it is open; null when not known. */
  contextTokens: number | null
  /** The compaction of the session before the round's message; null when there was none. */
  compaction: RoundCompaction | null
}

/** Time and usage summed over rounds. `pending` counts rounds whose finishing turn is not counted yet. */
export interface Spent {
  timeMs: number
  /** Null when no round had an agent session with usage of its own. */
  usage: Usage | null
  pending: number
  /** The steps whose rounds counted the turns some of these rounds shared; absent when none did. */
  sharedWith?: string[]
}

export interface RunStep {
  /** The definition's step id. Kept when the definition later drops the step. */
  stepId: string
  /** The step's name when the run reached it — survives a rename or deletion of the definition. */
  name: string
  state: RunStepState
  position: number
  agentNodeId: string | null
  /** The agent's name when the step was entered — what its calls are attributed by. */
  agentName: string | null
  /** Id of the chat the session lives in — what the host's thread page is addressed by. */
  chatRef: string | null
  /** Slug of the chat the session lives in — with `threadId`, what the embedded chat view takes. */
  chatSlug: string | null
  /** The session's thread, once one was opened. A rework re-enters this same thread. */
  threadRef: string | null
  threadId: string | null
  startedAt: string | null
  endedAt: string | null
  /** Name of the status the task moved to when the step ended — a name, so it reads the same after the status is renamed or deleted. */
  outcome: string | null
  /** The finisher's own summary of the work, when it gave one. */
  summary: string | null
  /** Who ended the step: an agent name, a person, or `system`. */
  finishedBy: string | null
  /** How many times the step was entered: 1 on first entry, +1 per rework. */
  attempts: number
  /** Why the session could not be opened or messaged the last time the step was entered, if it could not. */
  error: string | null
  /** Every entry into the step in this run, oldest first. */
  rounds: RunRound[]
  /** The step's rounds summed. */
  spent: Spent
}

export interface WorkflowRun {
  id: string
  taskKey: string
  workflowId: string
  workflowName: string
  state: RunState
  startedBy: { kind: 'agent' | 'person'; name: string }
  startedAt: string
  endedAt: string | null
  steps: RunStep[]
  /** Every step's rounds summed. */
  spent: Spent
}

export interface ValidationIssue {
  /** Where the problem is, e.g. `name`, `steps.1.chat`, `steps.0.transitions.2`. */
  path: string
  message: string
}

/** How far back `workflow_stats` looks: runs started in the last 7, 30 or 90 days, or all. */
export const STATS_RANGES = ['7d', '30d', '90d', 'all'] as const
export type StatsRange = (typeof STATS_RANGES)[number]

/**
 * Fewest measured rounds or runs a median, and a 90th percentile, is given from.
 * The kit's `workflow-stats` shows figures from the same numbers.
 */
export const STATS_MIN_SAMPLES = { median: 5, p90: 10 } as const

/** Measured times in ms. `median` and `p90` are nearest-rank, null below `STATS_MIN_SAMPLES`. */
export interface StatsDurations {
  samples: number
  median: number | null
  p90: number | null
}

/**
 * Why a step couldn't start: nobody assigned to work it, the task manager not
 * in the space's chat (or the host has no chats), or the session failed to
 * open or take the message for another reason.
 */
export const COULDNT_START_REASONS = ['unassigned', 'not_in_chat', 'session_failed'] as const
export type CouldntStartReason = (typeof COULDNT_START_REASONS)[number]

/** A couldn't-start reason, or `unrecorded` for times counted before reasons were kept. */
export type CouldntStartKey = CouldntStartReason | 'unrecorded'

/**
 * How a step's rounds ended. `movedOn` and `sentBack` left by one of the
 * step's transitions (a pass gate, a fail gate); `other` left by a status
 * change that wasn't one of them, or before transitions were recorded;
 * `cancelled` ended with their run; `open` have not ended.
 */
export interface StepExits {
  movedOn: number
  /** Per transition label, most first. */
  sentBack: Array<{ transition: string; count: number }>
  other: number
  cancelled: number
  open: number
}

/** Tokens and cost summed over settled rounds. */
export interface StatsSpend {
  tokens: number
  cost: Array<{ currency: string; amount: number }>
}

export interface StepStats {
  stepId: string
  name: string
  /** Runs that reached the step. */
  entered: number
  /** Of those, runs that entered it more than once. */
  reworked: number
  /** The step's rounds, each entry into it. */
  rounds: number
  exits: StepExits
  /** Runs that reached the step by the rounds they took there: 1, 2, 3, and 4 or more. */
  roundsPerRun: [number, number, number, number]
  /** Times the step couldn't start, by reason, most first; `total` is their sum. */
  couldntStart: { total: number; reasons: Array<{ reason: CouldntStartKey; count: number }> }
  /** Per round, from entering the step until the task left its status. Cancelled rounds are not measured. */
  time: StatsDurations
  /** Wall time of the step's ended rounds in finished runs, summed: its part of where their time went. */
  finishedTimeMs: number
  /** What the step's sessions spent, over the same rounds as `time` that have settled usage. */
  usage: StatsUsage
  /** The same settled spend, split into first rounds and rework (rounds 2 and later). */
  spend: { first: StatsSpend; rework: StatsSpend }
}

/** Runs started, finished and cancelled per bucket; a bucket is a UTC day or a week starting Monday. */
export interface StatsThroughput {
  bucket: 'day' | 'week'
  /** Every bucket from the range's start to now, in order, empty ones included. `start` is its first day (YYYY-MM-DD). */
  points: Array<{ start: string; started: number; finished: number; cancelled: number }>
}

export const RUN_EXITS = ['moved_on', 'sent_back', 'other', 'cancelled', 'open'] as const
export type RunExit = (typeof RUN_EXITS)[number]

/**
 * The runs one step figure counted, so the runs list can show them: runs of
 * the workflow started in `range` with a round at `step` that matches every
 * criterion given.
 */
export interface RunsMatch {
  range: StatsRange
  step: string
  /** How a round there ended; with `sent_back`, `transition` narrows it to one transition's label. */
  exit?: RunExit
  transition?: string
  /** Rounds the run took there; 4 means 4 or more. */
  rounds?: 1 | 2 | 3 | 4
  /** A time it couldn't start there, for this reason. */
  couldntStart?: CouldntStartKey
}

/**
 * Usage over measured rounds: those the task left (as for times) whose agent
 * session's usage has settled. `samples`, `median` and `p90` follow the same
 * rules as times. `pending` rounds are left out until their finishing turn is
 * counted. `shared` rounds are left out for good: they happened inside a turn
 * an earlier step's round counted, so they have no figures, and a zero in
 * their place would be a false sample.
 */
export interface StatsUsage {
  pending: number
  shared: number
  /** Tokens per round (all five kinds summed into `total`). */
  tokens: StatsDurations & { sum: number }
  /** Cost per round, one entry per currency. */
  cost: Array<StatsDurations & { currency: string; sum: number }>
}

/** A workflow's statistics over the runs started in `range`, and everything about those runs. */
export interface WorkflowStats {
  range: StatsRange
  /** The samples a median and a 90th percentile need; below them they are null while `samples` stays exact. */
  minSamples: typeof STATS_MIN_SAMPLES
  runs: { started: number; finished: number; cancelled: number; active: number }
  /** Finished runs, from start to end. */
  runTime: StatsDurations
  /** Finished runs, and those of them that entered every step they reached once. */
  firstPass: { finished: number; firstPass: number }
  throughput: StatsThroughput
  /** The workflow's current steps, in order. */
  steps: StepStats[]
  /** Usage over every measured round of the runs in range, whatever step it was. */
  usage: StatsUsage
  /** The same step figures over the rounds each agent or person worked. */
  agents: Array<{ agent: { kind: 'agent' | 'person'; name: string }; steps: StepStats[] }>
}
