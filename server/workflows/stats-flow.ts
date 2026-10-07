/**
 * How tasks get through a workflow, from the rounds of the runs started in a
 * range: how each round ended, how many rounds runs took at a step, why steps
 * couldn't start, where finished runs' time went, what first rounds and rework
 * spent, and runs started and ended over time. The runs list's `match` filter
 * classifies rounds with the same functions, so a count and the runs it opens
 * always agree.
 */

import type {
  CouldntStartKey,
  CouldntStartReason,
  RunExit,
  RunsMatch,
  RunState,
  StatsRange,
  StatsSpend,
  StatsThroughput,
  StepStats,
  TransitionGate,
} from '../../shared/workflows.ts'
import type { Db } from '../db.ts'
import { roundCost } from './usage.ts'

/** The earliest start a run in `range` may have, as the ISO text runs are stored with. */
export function rangeStart(range: StatsRange, now: string): string {
  return range === 'all' ? '' : new Date(Date.parse(now) - RANGE_DAYS[range] * DAY).toISOString()
}

const DAY = 86_400_000
const RANGE_DAYS: Record<Exclude<StatsRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

/** One round of a run in range, with what the flow figures read off it. */
export interface FlowRound {
  runId: string
  runState: RunState
  stepId: string
  roundNo: number
  worker: { kind: 'agent' | 'person'; name: string } | null
  startedAt: string
  endedAt: string | null
  endedBy: 'transition' | 'cancel' | null
  transition: string | null
  gate: TransitionGate | null
  /** Times the round couldn't start, recorded reasons or not. */
  attention: number
  /** The reasons recorded for those times. */
  reasons: CouldntStartReason[]
  /** Settled usage of a round the task left that had figures of its own; null otherwise. */
  spend: StatsSpend | null
}

/** Every round of the workflow's runs started at or after `since`. */
export function flowRounds(db: Db, workflowId: string, since: string): FlowRound[] {
  const rows = db
    .prepare(
      `SELECT o.run_id, r.state, o.step_id, o.round_no, o.worker_kind, o.worker_name, o.started_at, o.ended_at, o.ended_by,
         o.transition_label, o.gate, o.attention, o.usage_state, o.usage_shared_with, o.tokens_total, o.cost,
         (SELECT json_group_array(a.reason) FROM workflow_run_attention a
          WHERE a.run_id = o.run_id AND a.step_id = o.step_id AND a.round_no = o.round_no) AS reasons
       FROM workflow_run_round o JOIN workflow_run r ON r.id = o.run_id
       WHERE r.workflow_id = ? AND r.started_at >= ?`,
    )
    .all(workflowId, since) as Array<{
    run_id: string
    state: RunState
    step_id: string
    round_no: number
    worker_kind: 'agent' | 'person' | null
    worker_name: string | null
    started_at: string
    ended_at: string | null
    ended_by: 'transition' | 'cancel' | null
    transition_label: string | null
    gate: TransitionGate | null
    attention: number
    usage_state: 'pending' | 'settled' | null
    usage_shared_with: string | null
    tokens_total: number | null
    cost: string | null
    reasons: string
  }>
  return rows.map((row) => ({
    runId: row.run_id,
    runState: row.state,
    stepId: row.step_id,
    roundNo: row.round_no,
    worker: row.worker_kind && row.worker_name ? { kind: row.worker_kind, name: row.worker_name } : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    transition: row.transition_label,
    gate: row.gate,
    attention: row.attention,
    reasons: JSON.parse(row.reasons) as CouldntStartReason[],
    spend:
      row.ended_by === 'transition' && row.usage_state === 'settled' && row.usage_shared_with === null
        ? { tokens: row.tokens_total ?? 0, cost: row.cost ? (JSON.parse(row.cost) as Array<{ amount: number; currency: string }>).map(({ currency, amount }) => ({ currency, amount })) : [] }
        : null,
  }))
}

/**
 * How a round ended. A transition with a gate moved the task on or sent it
 * back; one without left by a status change that wasn't one of the step's
 * transitions, or before transitions were recorded.
 */
export function exitOf(round: FlowRound): RunExit {
  if (round.endedAt === null) {
    return 'open'
  }
  if (round.endedBy === 'cancel') {
    return 'cancelled'
  }
  return round.gate === 'pass' ? 'moved_on' : round.gate === 'fail' ? 'sent_back' : 'other'
}

/** A fail transition with no label still counts, under this name. */
const UNNAMED_TRANSITION = 'Sent back'

/** Rounds a run took at a step: its highest round number there (rounds recorded before rounds were kept carry their attempts). */
function roundsByRun(rounds: FlowRound[]): Map<string, number> {
  const taken = new Map<string, number>()
  for (const round of rounds) {
    taken.set(round.runId, Math.max(taken.get(round.runId) ?? 0, round.roundNo))
  }
  return taken
}

const roundsBucket = (n: number): 1 | 2 | 3 | 4 => (Math.min(Math.max(n, 1), 4) as 1 | 2 | 3 | 4)

function couldntStartOf(rounds: FlowRound[]): StepStats['couldntStart'] {
  const counts = new Map<CouldntStartKey, number>()
  let total = 0
  for (const round of rounds) {
    total += round.attention
    for (const reason of round.reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
    const unrecorded = round.attention - round.reasons.length
    if (unrecorded > 0) {
      counts.set('unrecorded', (counts.get('unrecorded') ?? 0) + unrecorded)
    }
  }
  return { total, reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) }
}

function sumSpend(rounds: FlowRound[]): StatsSpend {
  const byCurrency = new Map<string, number>()
  let tokens = 0
  for (const round of rounds) {
    if (!round.spend) {
      continue
    }
    tokens += round.spend.tokens
    for (const c of round.spend.cost) {
      byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.amount)
    }
  }
  return {
    tokens,
    cost: [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount: roundCost(amount) })),
  }
}

/** The flow figures of one step, over `rounds`: that step's rounds, all of them or one worker's. */
export function stepFlow(
  rounds: FlowRound[],
): Pick<StepStats, 'rounds' | 'exits' | 'roundsPerRun' | 'couldntStart' | 'finishedTimeMs' | 'spend'> {
  const exits: StepStats['exits'] = { movedOn: 0, sentBack: [], other: 0, cancelled: 0, open: 0 }
  const sentBack = new Map<string, number>()
  for (const round of rounds) {
    const exit = exitOf(round)
    if (exit === 'sent_back') {
      const label = round.transition ?? UNNAMED_TRANSITION
      sentBack.set(label, (sentBack.get(label) ?? 0) + 1)
    } else if (exit === 'moved_on') {
      exits.movedOn += 1
    } else {
      exits[exit] += 1
    }
  }
  exits.sentBack = [...sentBack].map(([transition, count]) => ({ transition, count })).sort((a, b) => b.count - a.count)

  const roundsPerRun: StepStats['roundsPerRun'] = [0, 0, 0, 0]
  for (const taken of roundsByRun(rounds).values()) {
    roundsPerRun[roundsBucket(taken) - 1] += 1
  }

  let finishedTimeMs = 0
  for (const round of rounds) {
    if (round.runState === 'finished' && round.endedAt !== null) {
      finishedTimeMs += Math.max(0, Date.parse(round.endedAt) - Date.parse(round.startedAt))
    }
  }

  return {
    rounds: rounds.length,
    exits,
    roundsPerRun,
    couldntStart: couldntStartOf(rounds),
    finishedTimeMs,
    spend: { first: sumSpend(rounds.filter((r) => r.roundNo === 1)), rework: sumSpend(rounds.filter((r) => r.roundNo > 1)) },
  }
}

/** Finished runs in range, and those that entered every step they reached once. */
export function firstPass(db: Db, workflowId: string, since: string): { finished: number; firstPass: number } {
  const { finished, firstPass } = db
    .prepare(
      `SELECT count(*) AS finished,
         coalesce(sum(NOT EXISTS (SELECT 1 FROM workflow_run_round o WHERE o.run_id = r.id AND o.round_no > 1)), 0) AS firstPass
       FROM workflow_run r WHERE r.workflow_id = ? AND r.started_at >= ? AND r.state = 'finished'`,
    )
    .get(workflowId, since) as { finished: number; firstPass: number }
  return { finished, firstPass }
}

/** The first day (YYYY-MM-DD, UTC) of the bucket `iso` falls in; a week starts on Monday. */
function bucketOf(iso: string, bucket: StatsThroughput['bucket']): string {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  if (bucket === 'week') {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  }
  return day.toISOString().slice(0, 10)
}

/**
 * Runs started in range, per day for the short ranges and per week for the
 * long ones: when each started, and when the ended ones finished or were
 * cancelled. Every bucket from the range's start (the first run's, for all
 * time) to now is present, so a quiet day reads as zero rather than missing.
 */
export function throughput(db: Db, workflowId: string, range: StatsRange, now: string): StatsThroughput {
  const bucket = range === '7d' || range === '30d' ? 'day' : 'week'
  const runs = db
    .prepare('SELECT state, started_at, ended_at FROM workflow_run WHERE workflow_id = ? AND started_at >= ? ORDER BY started_at')
    .all(workflowId, rangeStart(range, now)) as Array<{ state: RunState; started_at: string; ended_at: string | null }>
  const from = range === 'all' ? runs[0]?.started_at : rangeStart(range, now)
  if (!from) {
    return { bucket, points: [] }
  }
  const points = new Map<string, StatsThroughput['points'][number]>()
  const last = bucketOf(now, bucket)
  for (let at = bucketOf(from, bucket); at <= last; at = new Date(Date.parse(at) + (bucket === 'week' ? 7 : 1) * DAY).toISOString().slice(0, 10)) {
    points.set(at, { start: at, started: 0, finished: 0, cancelled: 0 })
  }
  for (const run of runs) {
    const started = points.get(bucketOf(run.started_at, bucket))
    if (started) {
      started.started += 1
    }
    if (run.ended_at && (run.state === 'finished' || run.state === 'cancelled')) {
      const ended = points.get(bucketOf(run.ended_at, bucket))
      if (ended) {
        ended[run.state] += 1
      }
    }
  }
  return { bucket, points: [...points.values()] }
}

/** Ids of the runs a step figure counted (see `RunsMatch`), in no particular order. */
export function matchingRunIds(db: Db, workflowId: string, match: RunsMatch, now: string): string[] {
  const rounds = flowRounds(db, workflowId, rangeStart(match.range, now)).filter((round) => round.stepId === match.step)
  const taken = roundsByRun(rounds)
  const runs = new Set<string>()
  for (const round of rounds) {
    if (match.exit && exitOf(round) !== match.exit) {
      continue
    }
    if (match.exit === 'sent_back' && match.transition && (round.transition ?? UNNAMED_TRANSITION) !== match.transition) {
      continue
    }
    if (match.rounds && roundsBucket(taken.get(round.runId) ?? 0) !== match.rounds) {
      continue
    }
    if (match.couldntStart) {
      const recorded = match.couldntStart === 'unrecorded' ? round.attention > round.reasons.length : round.reasons.includes(match.couldntStart)
      if (!recorded) {
        continue
      }
    }
    runs.add(round.runId)
  }
  return [...runs]
}
