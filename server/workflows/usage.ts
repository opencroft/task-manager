/**
 * What a workflow's agent sessions spent: tokens and cost per round, taken
 * from the step session's chat — the host's own turn records, through
 * `groupChats.usage` — never from anything the agent says. Nothing here asks
 * the agent for anything or waits on it.
 *
 * WHICH TURNS ARE A ROUND'S. A step's session is its agent's thread on the
 * task, shared by that step's rework, the agent's other steps on the task and
 * its mentions, so a thread's turns are split between the rounds that used it
 * by time. The agent finishes a step from INSIDE a turn — its
 * `workflow_step_finish` call is part of it — so the round ends while that
 * turn is still running, and its record lands when it ends. That finishing
 * turn is the last one the round counts: the first to end at or after the
 * round did. The next round on the thread, whatever its step, counts only
 * turns that ended after that: its message was queued behind the finishing
 * turn. A mention answered while a round is open counts for that round;
 * between rounds nothing counts it.
 *
 * A round's figures are never finer than the host's turn records. An agent
 * whose harness takes input mid-turn, read in realtime, gets the next step's
 * message inside the turn that is still running, so several rounds can share
 * one turn and one record. That turn counts once, for the first round it
 * ended after; the rounds it swallowed count nothing.
 *
 * WHEN. A round's usage is read when the round ends. If the session is still
 * in its finishing turn then, the round is recorded `pending` with what exists
 * and settles the next time its run or its workflow's statistics are read,
 * once that turn has ended. No timer: the next read settles it, however late.
 * An open round's figures are read live and not stored.
 */

import type { RoundUsageState, RunRound, Spent, Usage, UsageTokens, WorkflowRun } from '../../shared/workflows.ts'
import type { Db } from '../db.ts'

/**
 * A thread's recorded turns, whether one is running, and the context its
 * session holds — the host's `groupChats.usage` answer. `context` is absent
 * on a host that does not report it, and null when the session never did.
 */
export interface ThreadUsage {
  turns: Array<{
    endedAt: string
    tokens: UsageTokens
    cost: { amount: number; currency: string } | null
  }>
  busy: boolean
  context?: { usedTokens: number; contextLimit: number | null } | null
}

/** The part of the host's group chats that reads usage; absent on a host without it. */
export interface UsagePort {
  usage?(thread: string, options?: { since?: string }): Promise<ThreadUsage>
}

const NO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** Usage summed; cost is added per currency, never across currencies. */
export function sumUsage(parts: Usage[]): Usage {
  const tokens = { ...NO_TOKENS }
  const cost = new Map<string, number>()
  let turns = 0
  for (const part of parts) {
    turns += part.turns
    tokens.input += part.tokens.input
    tokens.output += part.tokens.output
    tokens.cacheRead += part.tokens.cacheRead
    tokens.cacheWrite += part.tokens.cacheWrite
    tokens.total += part.tokens.total
    for (const { amount, currency } of part.cost) {
      cost.set(currency, (cost.get(currency) ?? 0) + amount)
    }
  }
  return { turns, tokens, cost: [...cost].map(([currency, amount]) => ({ amount: roundCost(amount), currency })) }
}

/** Sums of priced amounts carry binary noise (0.1 + 0.02 = 0.12000000000000001); ten places is far below any price. */
export function roundCost(amount: number): number {
  return Math.round(amount * 1e10) / 1e10
}

function usageOfTurns(turns: ThreadUsage['turns']): Usage {
  return sumUsage(
    turns.map((turn) => ({ turns: 1, tokens: turn.tokens, cost: turn.cost ? [turn.cost] : [] })),
  )
}

/**
 * The round's span on its thread. `claim`: how far earlier rounds on the
 * thread have claimed its turns (`until`; turns ending up to then are
 * theirs), and the step of the round that claimed the turn ending there
 * (`by`). Null when no earlier round claimed any.
 */
export interface RoundWindow {
  startedAt: string
  endedAt: string | null
  claim: { until: string; by: string } | null
}

/** A round's usage as `attribute` finds it; `sharedWith` is set only for a `shared` round. */
export interface Attributed {
  usage: Usage
  state: RoundUsageState
  until: string | null
  sharedWith: string | null
}

/**
 * The usage of one round from its thread's turns (see the module note), and
 * for a settled round where the thread's claimed turns now stop: when the
 * last turn it counts ended, or its own end when it counts none after it.
 *
 * The shared rule comes first for an ended round. Its finishing turn is the
 * first turn to end at or after its end; when an earlier claim already
 * reaches that far, the turn it would finish in ends no later than the claim
 * and is counted already. So the round has no turn of its own, busy session
 * or not, and must not take a later round's turn as its finishing one: it is
 * `shared`, with no figures, naming the step whose round counted that turn.
 * A claim reaches past a round's end only through a recorded turn, since an
 * earlier round's end is always before this one's.
 *
 * All times are ISO strings from `toISOString`, so they compare as text.
 */
export function attribute(usage: ThreadUsage, round: RoundWindow): Attributed {
  const { claim } = round
  const inWindow = usage.turns.filter((turn) => turn.endedAt >= round.startedAt && (claim === null || turn.endedAt > claim.until))
  if (round.endedAt === null) {
    return { usage: usageOfTurns(inWindow), state: 'live', until: null, sharedWith: null }
  }
  const endedAt = round.endedAt
  if (claim !== null && claim.until >= endedAt) {
    return { usage: usageOfTurns([]), state: 'shared', until: claim.until, sharedWith: claim.by }
  }
  const finishing = inWindow.findIndex((turn) => turn.endedAt >= endedAt)
  if (finishing >= 0) {
    return {
      usage: usageOfTurns(inWindow.slice(0, finishing + 1)),
      state: 'settled',
      until: inWindow[finishing]!.endedAt,
      sharedWith: null,
    }
  }
  // No turn has ended since the round did. A busy session is in the round's
  // finishing turn; an idle one has nothing still to come.
  if (usage.busy) {
    return { usage: usageOfTurns(inWindow), state: 'pending', until: null, sharedWith: null }
  }
  return { usage: usageOfTurns(inWindow), state: 'settled', until: endedAt, sharedWith: null }
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** The round columns usage is read from; see migrations wf-0003-round-usage and wf-0007-round-shared-turn. */
export interface RoundUsageColumns {
  usage_state: 'pending' | 'settled' | null
  /** Set on a settled round that shared a turn: the step whose round counted it. */
  usage_shared_with: string | null
  usage_turns: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  tokens_total: number | null
  cost: string | null
}

/** A stored round's usage, or null when none was recorded. */
export function storedUsage(row: RoundUsageColumns): (Usage & { state: RoundUsageState; sharedWith?: string }) | null {
  if (row.usage_state === null) {
    return null
  }
  return {
    ...(row.usage_shared_with !== null ? { state: 'shared' as const, sharedWith: row.usage_shared_with } : { state: row.usage_state }),
    turns: row.usage_turns ?? 0,
    tokens: {
      input: row.tokens_input ?? 0,
      output: row.tokens_output ?? 0,
      cacheRead: row.tokens_cache_read ?? 0,
      cacheWrite: row.tokens_cache_write ?? 0,
      total: row.tokens_total ?? 0,
    },
    cost: row.cost ? (JSON.parse(row.cost) as Usage['cost']) : [],
  }
}

interface RoundKey {
  runId: string
  stepId: string
  roundNo: number
}

/** Store a round's usage. A shared round is stored settled, with the step it shared a turn with. */
function saveUsage(db: Db, key: RoundKey, threadRef: string, result: Attributed): void {
  const { usage, state, until } = result
  db.prepare(
    `UPDATE workflow_run_round SET thread_ref = ?, usage_state = ?, usage_shared_with = ?, usage_until = ?, usage_turns = ?,
       tokens_input = ?, tokens_output = ?, tokens_cache_read = ?, tokens_cache_write = ?, tokens_total = ?, cost = ?
     WHERE run_id = ? AND step_id = ? AND round_no = ?`,
  ).run(
    threadRef,
    state === 'shared' ? 'settled' : state,
    state === 'shared' ? result.sharedWith : null,
    until,
    usage.turns,
    usage.tokens.input,
    usage.tokens.output,
    usage.tokens.cacheRead,
    usage.tokens.cacheWrite,
    usage.tokens.total,
    JSON.stringify(usage.cost),
    key.runId,
    key.stepId,
    key.roundNo,
  )
}

/**
 * A round's thread, read, and the round's window on it. Its `claim` is the
 * furthest any earlier round on the thread, of any step or run, has claimed:
 * a settled one recorded where its claim stops; any other ended round (its
 * usage could not be read, or it settled before rounds recorded that) claims
 * up to its own end; and a pending round just before this one is waiting on
 * its finishing turn, the first to end after it did. Taking the furthest
 * keeps the bound from moving backwards, so no turn is counted twice, and a
 * round that will never be read again claims nothing past its end, so none
 * is lost to it.
 *
 * The host records a turn only when it ends with usage reported. A pending
 * round whose finishing turn never gets a record therefore claims the next
 * turn to end instead: one turn moves between the two rounds, and none is
 * lost or counted twice.
 */
async function readWindow(
  db: Db,
  chats: UsagePort | null,
  round: { threadRef: string; startedAt: string; endedAt: string | null },
): Promise<{ usage: ThreadUsage; window: RoundWindow } | null> {
  const previous = db
    .prepare(
      `SELECT o.ended_at, o.usage_state, s.name FROM workflow_run_round o
       JOIN workflow_run_step s ON s.run_id = o.run_id AND s.step_id = o.step_id
       WHERE o.thread_ref = ? AND o.started_at < ? AND o.ended_at IS NOT NULL ORDER BY o.started_at DESC LIMIT 1`,
    )
    .get(round.threadRef, round.startedAt) as
    | { ended_at: string; usage_state: 'pending' | 'settled' | null; name: string }
    | undefined
  const waiting = previous?.usage_state === 'pending' ? previous.ended_at : null
  // Read from the previous round's end when it waits: its finishing turn may have ended before this round began.
  const usage = await readThread(chats, round.threadRef, waiting !== null && waiting < round.startedAt ? waiting : round.startedAt)
  if (!usage) {
    return null
  }
  // Over every earlier round, not only the last: a round that knows nothing of
  // what came before it (its read failed) must not pull the bound back. Of the
  // rounds reaching the bound, the earliest is the one that counted its turn;
  // a later one that shared it names the same step.
  const furthest = db
    .prepare(
      `SELECT coalesce(o.usage_until, o.ended_at) AS bound, coalesce(o.usage_shared_with, s.name) AS by
       FROM workflow_run_round o JOIN workflow_run_step s ON s.run_id = o.run_id AND s.step_id = o.step_id
       WHERE o.thread_ref = ? AND o.started_at < ? AND o.ended_at IS NOT NULL
       ORDER BY bound DESC, o.started_at LIMIT 1`,
    )
    .get(round.threadRef, round.startedAt) as { bound: string; by: string } | undefined
  const pendingClaim =
    previous && waiting !== null
      ? { until: usage.turns.find((turn) => turn.endedAt >= waiting)?.endedAt ?? waiting, by: previous.name }
      : null
  const earlierClaim = furthest ? { until: furthest.bound, by: furthest.by } : null
  const claim = pendingClaim && (!earlierClaim || pendingClaim.until > earlierClaim.until) ? pendingClaim : earlierClaim
  return { usage, window: { startedAt: round.startedAt, endedAt: round.endedAt, claim } }
}

async function readThread(chats: UsagePort | null, threadRef: string, since: string): Promise<ThreadUsage | null> {
  if (!chats?.usage) {
    return null
  }
  try {
    return await chats.usage(threadRef, { since })
  } catch (error) {
    // Usage is a report on the run, never a reason for the run to fail.
    console.error('[task-pipelines] reading a step session’s usage failed', error)
    return null
  }
}

/**
 * The step's round that just ended: read its session's usage and record it.
 * Only a round an agent worked, in a session the workflow opened, has usage.
 */
export async function recordRoundUsage(
  db: Db,
  chats: UsagePort | null,
  input: { runId: string; stepId: string; threadRef: string | null },
): Promise<void> {
  if (!input.threadRef) {
    return
  }
  const round = db
    .prepare(
      `SELECT round_no, worker_kind, started_at, ended_at FROM workflow_run_round
       WHERE run_id = ? AND step_id = ? AND ended_at IS NOT NULL ORDER BY round_no DESC LIMIT 1`,
    )
    .get(input.runId, input.stepId) as
    | { round_no: number; worker_kind: string | null; started_at: string; ended_at: string }
    | undefined
  if (!round || round.worker_kind !== 'agent') {
    return
  }
  const read = await readWindow(db, chats, { threadRef: input.threadRef, startedAt: round.started_at, endedAt: round.ended_at })
  if (!read) {
    return
  }
  const key = { runId: input.runId, stepId: input.stepId, roundNo: round.round_no }
  saveUsage(db, key, input.threadRef, attribute(read.usage, read.window))
  saveContext(db, key, { threadRef: input.threadRef, startedAt: round.started_at }, read.usage)
}

/**
 * The context the round's session holds, kept as the round's own once no
 * turn is running: as the round ends when the session is idle then, otherwise
 * when the round settles after its finishing turn. A reading taken inside a
 * turn is not final: a harness may rebuild its count during the turn and
 * report its true figure only at the turn's end, so a session's first turn
 * can read 0 until then. Never once another round has started on its thread,
 * since the session's context is that round's from then on; nor over a
 * figure already kept.
 */
function saveContext(db: Db, key: RoundKey, round: { threadRef: string; startedAt: string }, usage: ThreadUsage): void {
  const context = usage.context?.usedTokens
  if (context === undefined || usage.busy) {
    return
  }
  db.prepare(
    `UPDATE workflow_run_round SET context_tokens = ?
     WHERE run_id = ? AND step_id = ? AND round_no = ? AND context_tokens IS NULL
       AND NOT EXISTS (SELECT 1 FROM workflow_run_round later WHERE later.thread_ref = ? AND later.started_at > ?)`,
  ).run(context, key.runId, key.stepId, key.roundNo, round.threadRef, round.startedAt)
}

/**
 * Settle the pending rounds of these runs whose finishing turn has since
 * ended, oldest first, so a later round on the same thread sees where an
 * earlier one's turns stop. Rounds that still wait stay pending.
 */
export async function settlePendingUsage(db: Db, chats: UsagePort | null, runIds: string[]): Promise<void> {
  if (runIds.length === 0 || !chats?.usage) {
    return
  }
  const marks = runIds.map(() => '?').join(', ')
  const pending = db
    .prepare(
      `SELECT run_id, step_id, round_no, thread_ref, started_at, ended_at FROM workflow_run_round
       WHERE usage_state = 'pending' AND run_id IN (${marks}) ORDER BY started_at`,
    )
    .all(...runIds) as Array<{
    run_id: string
    step_id: string
    round_no: number
    thread_ref: string
    started_at: string
    ended_at: string
  }>
  for (const row of pending) {
    const read = await readWindow(db, chats, { threadRef: row.thread_ref, startedAt: row.started_at, endedAt: row.ended_at })
    if (!read) {
      continue
    }
    const result = attribute(read.usage, read.window)
    if (result.state !== 'pending') {
      const key = { runId: row.run_id, stepId: row.step_id, roundNo: row.round_no }
      saveUsage(db, key, row.thread_ref, result)
      saveContext(db, key, { threadRef: row.thread_ref, startedAt: row.started_at }, read.usage)
    }
  }
}

// ── Rollups ─────────────────────────────────────────────────────────────────

/**
 * Rounds summed: wall time of every round, usage of those that have their
 * own. A shared round adds no figures; it names the step that counted its turn.
 */
export function spentOf(rounds: RunRound[]): Spent {
  const withUsage = rounds.flatMap((round) => (round.usage && round.usage.state !== 'shared' ? [round.usage] : []))
  const sharedWith = [
    ...new Set(rounds.flatMap((round) => (round.usage?.state === 'shared' && round.usage.sharedWith ? [round.usage.sharedWith] : []))),
  ]
  return {
    timeMs: rounds.reduce((sum, round) => sum + round.timeMs, 0),
    usage: withUsage.length ? sumUsage(withUsage) : null,
    pending: withUsage.filter((usage) => usage.state === 'pending').length,
    ...(sharedWith.length ? { sharedWith } : {}),
  }
}

/**
 * Several `Spent` summed — a run's steps, or a task's runs. A shared turn is
 * counted in the total already, under the step that counted it, so the sum
 * names no shared steps.
 */
export function sumSpent(parts: Spent[]): Spent {
  const usages = parts.flatMap((part) => (part.usage ? [part.usage] : []))
  return {
    timeMs: parts.reduce((sum, part) => sum + part.timeMs, 0),
    usage: usages.length ? sumUsage(usages) : null,
    pending: parts.reduce((sum, part) => sum + part.pending, 0),
  }
}

/**
 * The run with its open round's usage read live from its session, and its
 * step and run totals recomputed. A run with no open agent round is returned
 * as it is.
 */
export async function withLiveUsage(db: Db, chats: UsagePort | null, run: WorkflowRun): Promise<WorkflowRun> {
  const open = run.steps.find((step) => step.state === 'active')
  const round = open?.rounds.at(-1)
  if (!open?.threadRef || !round || round.endedAt !== null || round.worker?.kind !== 'agent') {
    return run
  }
  const read = await readWindow(db, chats, { threadRef: open.threadRef, startedAt: round.startedAt, endedAt: null })
  if (!read) {
    return run
  }
  const live = attribute(read.usage, read.window)
  const contextTokens = read.usage.context?.usedTokens ?? round.contextTokens
  const rounds = [...open.rounds.slice(0, -1), { ...round, usage: { ...live.usage, state: live.state }, contextTokens }]
  const steps = run.steps.map((step) => (step === open ? { ...step, rounds, spent: spentOf(rounds) } : step))
  return { ...run, steps, spent: sumSpent(steps.map((step) => step.spent)) }
}
