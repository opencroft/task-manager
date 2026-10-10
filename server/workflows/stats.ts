/**
 * A workflow's statistics, computed in SQL from what the engine recorded:
 * runs, and the rounds of their steps (one per entry into a step). Nothing is
 * self-reported. A range selects the runs STARTED inside it, and everything
 * about those runs; a run that started earlier and finished inside the range
 * is not counted. Percentiles are nearest-rank, and null below the samples
 * they need (`STATS_MIN_SAMPLES`), so no caller reads a median off one run.
 */

import {
  STATS_MIN_SAMPLES,
  type StatsDurations,
  type StatsRange,
  type StatsUsage,
  type StepStats,
  type WorkflowDef,
  type WorkflowStats,
} from '../../shared/workflows.ts'
import type { Db } from '../db.ts'
import { type FlowRound, firstPass, flowRounds, rangeStart, stepFlow, throughput } from './stats-flow.ts'
import { roundCost } from './usage.ts'

const MS = (from: string, to: string) => `CAST(round((julianday(${to}) - julianday(${from})) * 86400000) AS INTEGER)`

/** Rounds of the runs in range; `?` placeholders take the workflow id and the range start. */
const ROUNDS_IN_RANGE = `
  FROM workflow_run_round o JOIN workflow_run r ON r.id = o.run_id
  WHERE r.workflow_id = ? AND r.started_at >= ?`

// Joins a worker's kind and name and a step id into one group key: the ASCII
// unit separator, which no name typed into a form carries.
const SEPARATOR = '\u001f'
const UNIT = 'char(31)'

/**
 * Samples, median and 90th percentile of `ms` per `key`, over the rows the
 * `keyed` query yields. Nearest rank: the value at position ceil(p/100 × n) in order.
 */
function durations(db: Db, keyed: string, params: string[]): Map<string, StatsDurations> {
  const rows = db
    .prepare(
      `WITH d AS (${keyed}),
       ranked AS (SELECT key, ms, row_number() OVER (PARTITION BY key ORDER BY ms) AS rn, count(*) OVER (PARTITION BY key) AS n FROM d)
       SELECT key, n AS samples,
         max(CASE WHEN rn = (n * 50 + 99) / 100 THEN ms END) AS median,
         max(CASE WHEN rn = (n * 90 + 99) / 100 THEN ms END) AS p90
       FROM ranked GROUP BY key`,
    )
    .all(...params) as Array<{ key: string; samples: number; median: number; p90: number }>
  return new Map(
    rows.map((row) => [
      row.key,
      {
        samples: row.samples,
        median: row.samples >= STATS_MIN_SAMPLES.median ? row.median : null,
        p90: row.samples >= STATS_MIN_SAMPLES.p90 ? row.p90 : null,
      },
    ]),
  )
}

const NOT_MEASURED: StatsDurations = { samples: 0, median: null, p90: null }

interface StepCounts {
  entered: number
  reworked: number
}

/** Counts and times per step, grouped by `key` (an SQL expression over the round `o` that ends in its step). */
function stepFigures(
  db: Db,
  key: string,
  where: string,
  params: string[],
): { counts: Map<string, StepCounts>; times: Map<string, StatsDurations> } {
  const counts = db
    .prepare(
      `SELECT ${key} AS key, count(DISTINCT o.run_id) AS entered,
         count(DISTINCT CASE WHEN o.round_no > 1 THEN o.run_id END) AS reworked
       ${ROUNDS_IN_RANGE} ${where} GROUP BY key`,
    )
    .all(...params) as unknown as Array<StepCounts & { key: string }>
  const times = durations(
    db,
    `SELECT ${key} AS key, ${MS('o.started_at', 'o.ended_at')} AS ms ${ROUNDS_IN_RANGE} ${where} AND o.ended_by = 'transition'`,
    params,
  )
  return { counts: new Map(counts.map(({ key: k, ...c }) => [k, c])), times }
}

/** Runs in range with a round whose usage is still waiting for its finishing turn: what a read settles first. */
export function pendingRunIds(db: Db, workflowId: string, since: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT o.run_id AS id ${ROUNDS_IN_RANGE} AND o.usage_state = 'pending'`)
    .all(workflowId, since) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/** A measured round's usage, for the usage figures. */
interface UsageRound {
  stepId: string
  worker: string | null
  state: 'pending' | 'settled' | 'shared'
  tokens: number
  cost: Array<{ amount: number; currency: string }>
}

function usageRounds(db: Db, params: string[]): UsageRound[] {
  const rows = db
    .prepare(
      `SELECT o.step_id, o.worker_kind, o.worker_name, o.usage_state, o.usage_shared_with, o.tokens_total, o.cost
       ${ROUNDS_IN_RANGE} AND o.ended_by = 'transition' AND o.usage_state IS NOT NULL`,
    )
    .all(...params) as Array<{
    step_id: string
    worker_kind: string | null
    worker_name: string | null
    usage_state: 'pending' | 'settled'
    usage_shared_with: string | null
    tokens_total: number | null
    cost: string | null
  }>
  return rows.map((row) => ({
    stepId: row.step_id,
    worker: row.worker_kind && row.worker_name ? [row.worker_kind, row.worker_name].join(SEPARATOR) : null,
    state: row.usage_shared_with !== null ? 'shared' : row.usage_state,
    tokens: row.tokens_total ?? 0,
    cost: row.cost ? (JSON.parse(row.cost) as UsageRound['cost']) : [],
  }))
}

/** Nearest rank over `values`, as `durations` does in SQL, with the same minimum samples. */
function distribution(values: number[]): StatsDurations & { sum: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const rank = (p: number) => sorted[Math.ceil((p / 100) * n) - 1] ?? null
  return {
    samples: n,
    median: n >= STATS_MIN_SAMPLES.median ? rank(50) : null,
    p90: n >= STATS_MIN_SAMPLES.p90 ? rank(90) : null,
    sum: roundCost(sorted.reduce((sum, value) => sum + value, 0)),
  }
}

/** Usage over these rounds: settled ones measured, pending and shared ones counted. */
function usageStats(rounds: UsageRound[]): StatsUsage {
  const settled = rounds.filter((round) => round.state === 'settled')
  const currencies = [...new Set(settled.flatMap((round) => round.cost.map((c) => c.currency)))].sort()
  return {
    pending: rounds.filter((round) => round.state === 'pending').length,
    shared: rounds.filter((round) => round.state === 'shared').length,
    tokens: distribution(settled.map((round) => round.tokens)),
    // A round priced in a currency adds its amount there; rounds not priced in it are not samples of it.
    cost: currencies.map((currency) => ({
      currency,
      ...distribution(
        settled.flatMap((round) => round.cost.filter((c) => c.currency === currency).map((c) => c.amount)),
      ),
    })),
  }
}

function stepStats(
  step: { id: string; name: string },
  counts: StepCounts | undefined,
  time: StatsDurations | undefined,
  usage: UsageRound[],
  flow: FlowRound[],
): StepStats {
  return {
    stepId: step.id,
    name: step.name,
    entered: counts?.entered ?? 0,
    reworked: counts?.reworked ?? 0,
    time: time ?? NOT_MEASURED,
    usage: usageStats(usage.filter((round) => round.stepId === step.id)),
    ...stepFlow(flow.filter((round) => round.stepId === step.id)),
  }
}

export function workflowStats(db: Db, workflow: WorkflowDef, range: StatsRange, now: string): WorkflowStats {
  const params = [workflow.id, rangeStart(range, now)]

  const runs = {
    ...(db
      .prepare(
        `SELECT count(*) AS started,
         coalesce(sum(state = 'finished'), 0) AS finished,
         coalesce(sum(state = 'cancelled'), 0) AS cancelled,
         coalesce(sum(state = 'active'), 0) AS active
       FROM workflow_run WHERE workflow_id = ? AND started_at >= ?`,
      )
      .get(...params) as WorkflowStats['runs']),
  }
  const runTime =
    durations(
      db,
      `SELECT '' AS key, ${MS('started_at', 'ended_at')} AS ms FROM workflow_run WHERE workflow_id = ? AND started_at >= ? AND state = 'finished'`,
      params,
    ).get('') ?? NOT_MEASURED

  const usage = usageRounds(db, params)
  const flow = flowRounds(db, workflow.id, rangeStart(range, now))
  const overall = stepFigures(db, 'o.step_id', '', params)
  const steps = workflow.steps.map((step) =>
    stepStats(step, overall.counts.get(step.id), overall.times.get(step.id), usage, flow),
  )

  const byWorker = stepFigures(
    db,
    `o.worker_kind || ${UNIT} || o.worker_name || ${UNIT} || o.step_id`,
    'AND o.worker_kind IS NOT NULL',
    params,
  )
  const workers = new Map<string, { kind: 'agent' | 'person'; name: string }>()
  for (const key of byWorker.counts.keys()) {
    const [kind, name] = key.split(SEPARATOR) as ['agent' | 'person', string]
    workers.set(`${kind}${SEPARATOR}${name}`, { kind, name })
  }
  const agents = [...workers.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .map((agent) => {
      const keyOf = (stepId: string) => [agent.kind, agent.name, stepId].join(SEPARATOR)
      const worker = [agent.kind, agent.name].join(SEPARATOR)
      const theirs = usage.filter((round) => round.worker === worker)
      const theirFlow = flow.filter((round) => round.worker?.kind === agent.kind && round.worker.name === agent.name)
      return {
        agent,
        steps: workflow.steps
          .filter((step) => byWorker.counts.has(keyOf(step.id)))
          .map((step) =>
            stepStats(step, byWorker.counts.get(keyOf(step.id)), byWorker.times.get(keyOf(step.id)), theirs, theirFlow),
          ),
      }
    })
    .filter((entry) => entry.steps.length > 0)

  return {
    range,
    minSamples: STATS_MIN_SAMPLES,
    runs,
    runTime,
    firstPass: firstPass(db, workflow.id, rangeStart(range, now)),
    throughput: throughput(db, workflow.id, range, now),
    steps,
    usage: usageStats(usage),
    agents,
  }
}
