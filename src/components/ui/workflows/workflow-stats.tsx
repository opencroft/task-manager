import { AlertTriangle, ChevronRight, Info } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "../button"
import { SegmentedButton } from "../input/segmented-button"
import { Skeleton } from "../skeleton"
import { TaskManagerError } from "../states/task-manager-error"
import { TaskAssignee, type TaskAssigneeValue } from "../tasks/task-assignee"
import { cn } from "@/lib/utils"
import { formatCompactNumber } from "../utils/compact-number"
import { formatMoney } from "./workflow-spent"
import {
  WORKFLOW_STATS_MIN_MEDIAN,
  WORKFLOW_STATS_RANGES,
  type WorkflowStatsDurations,
  type WorkflowStatsOpenRuns,
  type WorkflowStatsRange,
  type WorkflowStatsThroughput,
  type WorkflowStatsUsage,
  type WorkflowStepStats,
  formatStatDuration,
  statPercent,
  statPlural,
  statShowsMedian,
  statShowsP90,
} from "./workflow-stats-chart"
import { WorkflowStatsCouldntStartList } from "./workflow-stats-couldnt-start"
import { WorkflowStatsExitsChart, WorkflowStatsSentBackChart } from "./workflow-stats-exits"
import { WorkflowStatsSpendChart } from "./workflow-stats-spend"
import { WorkflowStatsThroughputChart } from "./workflow-stats-throughput"
import { WorkflowStatsTimeBar, WorkflowStatsTimeChart, statsTimeScale } from "./workflow-stats-time"

export interface WorkflowAgentStats {
  agent: TaskAssigneeValue
  /** The same numbers, restricted to the rounds this agent or person worked. */
  steps: WorkflowStepStats[]
}

export interface WorkflowStatsData {
  range: WorkflowStatsRange
  runs: { started: number; finished: number; cancelled: number; active: number }
  /** Finished runs only, from the run's start to its end. */
  runTime: WorkflowStatsDurations
  /** Finished runs, and those of them that entered every step they reached once. */
  firstPass: { finished: number; firstPass: number }
  throughput: WorkflowStatsThroughput
  /** The workflow's current steps, in order. */
  steps: WorkflowStepStats[]
  /** Over every measured round of the runs in range. */
  usage?: WorkflowStatsUsage
  agents: WorkflowAgentStats[]
}

function Tile({ label, value, note, muted = false }: { label: string; value: ReactNode; note?: ReactNode; muted?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate text-xl font-semibold tabular-nums", muted && "text-base font-medium text-muted-foreground")}>{value}</span>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  )
}

/** Finished runs that went through every step once: a rate from enough of them, the bare counts below that. */
function FirstPassTile({ firstPass }: { firstPass: WorkflowStatsData["firstPass"] }) {
  const { finished, firstPass: once } = firstPass
  if (finished === 0) {
    return <Tile label="First pass" muted value="None finished" note="Runs that went through every step once" />
  }
  if (finished < WORKFLOW_STATS_MIN_MEDIAN) {
    return <Tile label="First pass" value={`${once} of ${finished}`} note="finished runs went through every step once" />
  }
  return <Tile label="First pass" value={`${statPercent(once, finished)}%`} note={`${once} of ${statPlural(finished, "finished run")} went through every step once`} />
}

function RunTimeTile({ runTime }: { runTime: WorkflowStatsDurations }) {
  if (!statShowsMedian(runTime)) {
    return (
      <Tile
        label="Median run time"
        muted
        value="Too few runs"
        note={runTime.samples === 0 ? "None has finished yet" : `${statPlural(runTime.samples, "finished run")}, ${WORKFLOW_STATS_MIN_MEDIAN} needed`}
      />
    )
  }
  return (
    <Tile
      label="Median run time"
      value={formatStatDuration(runTime.median as number)}
      note={statShowsP90(runTime) ? `90% within ${formatStatDuration(runTime.p90 as number)}` : statPlural(runTime.samples, "finished run")}
    />
  )
}

/** What the agent sessions spent over the range: tokens, and cost per currency. */
function SpentTiles({ usage }: { usage: WorkflowStatsUsage }) {
  return (
    <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
      <Tile
        label="Tokens"
        value={usage.tokens.samples > 0 ? formatCompactNumber(usage.tokens.sum) : "None yet"}
        muted={usage.tokens.samples === 0}
        note={
          statShowsMedian(usage.tokens)
            ? `${formatCompactNumber(usage.tokens.median as number)} per round (median)`
            : usage.pending > 0
              ? `${statPlural(usage.pending, "round")} still counting`
              : statPlural(usage.tokens.samples, "agent round")
        }
      />
      {usage.cost.length > 0 ? (
        usage.cost.map((c) => (
          <Tile
            key={c.currency}
            label={usage.cost.length > 1 ? `Cost (${c.currency})` : "Cost"}
            value={formatMoney(c.sum, c.currency)}
            note={statShowsMedian(c) ? `${formatMoney(c.median as number, c.currency)} per round (median)` : statPlural(c.samples, "priced round")}
          />
        ))
      ) : (
        <Tile label="Cost" muted value="Not priced" note="No session reported a cost" />
      )}
    </div>
  )
}

function ReworkCell({ step }: { step: WorkflowStepStats }) {
  if (step.entered === 0) {
    return <span className="text-xs text-muted-foreground">Not reached</span>
  }
  return (
    <span className="text-sm tabular-nums">
      {step.reworked} of {statPlural(step.entered, "run")}
      {step.entered >= WORKFLOW_STATS_MIN_MEDIAN ? <span className="ml-1.5 text-xs text-muted-foreground">{statPercent(step.reworked, step.entered)}%</span> : null}
    </span>
  )
}

function CouldntStartCell({ step }: { step: WorkflowStepStats }) {
  if (step.entered === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  return step.couldntStart.total > 0 ? (
    <span className="flex items-center gap-1 text-sm text-amber-700 tabular-nums dark:text-amber-300">
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      {step.couldntStart.total}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground tabular-nums">None</span>
  )
}

/** A step's spend per round: the median tokens and cost, or why there is none to show. */
function UsageCell({ usage }: { usage: WorkflowStatsUsage | undefined }) {
  const pending = (
    <>
      {usage && usage.pending > 0 ? <span className="text-xs text-muted-foreground">{statPlural(usage.pending, "round")} still counting</span> : null}
      {usage?.shared ? <span className="text-xs text-muted-foreground">{statPlural(usage.shared, "round")} shared a turn with an earlier step</span> : null}
    </>
  )
  if (!usage || usage.tokens.samples === 0) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{usage?.shared ? "Counted with an earlier step" : "No agent usage"}</span>
        {pending}
      </span>
    )
  }
  const { tokens } = usage
  if (!statShowsMedian(tokens)) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{statPlural(tokens.samples, "round")}, too few for a median</span>
        {pending}
      </span>
    )
  }
  const cost = usage.cost.filter((c) => statShowsMedian(c))
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
        <span className="font-medium">{formatCompactNumber(tokens.median as number)} tokens</span>
        {cost.map((c) => (
          <span key={c.currency}>{formatMoney(c.median as number, c.currency)}</span>
        ))}
      </span>
      {pending}
    </span>
  )
}

const ROW_GRID = "@2xl:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_8rem_7rem]"
const ROW_GRID_USAGE = "@2xl:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_minmax(8rem,11rem)_8rem_7rem]"

function StepRows({ steps, withUsage = false }: { steps: WorkflowStepStats[]; withUsage?: boolean }) {
  const scale = statsTimeScale(steps.map((s) => s.time))
  const grid = withUsage ? ROW_GRID_USAGE : ROW_GRID
  return (
    <div role="table" className="@container flex flex-col overflow-hidden rounded-lg border">
      <div role="row" className={cn("hidden gap-4 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground @2xl:grid", grid)}>
        <span role="columnheader">Step</span>
        <span role="columnheader">Time per round (median)</span>
        {withUsage ? <span role="columnheader">Spent per round (median)</span> : null}
        <span role="columnheader">Came back</span>
        <span role="columnheader">Couldn’t start</span>
      </div>
      {steps.map((step) => (
        <div
          key={step.stepId}
          role="row"
          className={cn("grid grid-cols-2 gap-x-4 gap-y-2 border-b px-3 py-2.5 last:border-b-0 @2xl:items-center", grid)}
        >
          <span role="cell" className="col-span-2 min-w-0 text-sm font-medium break-words @2xl:col-span-1">
            {step.name}
          </span>
          <span role="cell" className="col-span-2 min-w-0 @2xl:col-span-1">
            <WorkflowStatsTimeBar time={step.time} scale={scale} />
          </span>
          {withUsage ? (
            <span role="cell" className="col-span-2 flex min-w-0 flex-col gap-0.5 @2xl:col-span-1">
              <span className="text-[11px] text-muted-foreground @2xl:hidden">Spent per round</span>
              <UsageCell usage={step.usage} />
            </span>
          ) : null}
          <span role="cell" className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground @2xl:hidden">Came back</span>
            <ReworkCell step={step} />
          </span>
          <span role="cell" className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground @2xl:hidden">Couldn’t start</span>
            <CouldntStartCell step={step} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** The step rows again per agent or person, closed until asked for. */
function ByAgent({ agents, withUsage }: { agents: WorkflowAgentStats[]; withUsage: boolean }) {
  return (
    <details className="group/agents">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open/agents:rotate-90" />
        By agent
        <span className="text-xs font-normal text-muted-foreground">{statPlural(agents.length, "worker")}</span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {agents.map((a) => (
          <div key={`${a.agent.kind}:${a.agent.name}`} className="flex flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <TaskAssignee assignee={a.agent} withName size="sm" className="min-w-0 max-w-full font-medium" />
              <span className="min-w-0 text-xs text-muted-foreground">
                {a.agent.kind === "agent" ? "Agent" : "Person: a round lasts until they change the status"}
              </span>
            </div>
            <StepRows steps={a.steps} withUsage={withUsage && a.agent.kind === "agent"} />
          </div>
        ))}
      </div>
    </details>
  )
}

function SkeletonBlock({ className }: { className?: string }) {
  return <Skeleton aria-hidden="true" className={cn("rounded-lg", className)} />
}

export interface WorkflowStatsProps {
  /** The numbers for the range asked for; null until the first answer. */
  stats: WorkflowStatsData | null
  /** The range shown in the picker; the host refetches when it changes. */
  range: WorkflowStatsRange
  onRangeChange: (range: WorkflowStatsRange) => void
  /**
   * Opens the runs a count counted, for the range shown. Without it the counts
   * are plain text, not buttons.
   */
  onOpenRuns?: WorkflowStatsOpenRuns
  loading?: boolean
  /** Loading failed; with numbers already shown it sits above them instead of replacing them. */
  error?: string | null
  onRetry?: () => void
  className?: string
}

/**
 * A workflow's statistics, from what the engine recorded. Counts are exact
 * whatever their size; times need enough measured rounds (see the thresholds
 * in `workflow-stats-chart`) and say so when there are too few, so nothing
 * unmeasured ever reads as zero. The range counts runs started inside it, and
 * everything about those runs.
 */
export function WorkflowStats({ stats, range, onRangeChange, onOpenRuns, loading = false, error = null, onRetry, className }: WorkflowStatsProps) {
  const phrase = WORKFLOW_STATS_RANGES.find((r) => r.value === range)?.phrase ?? ""
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 text-sm text-muted-foreground">
        Runs started {phrase}
        {loading && stats ? <span className="ml-2 text-xs">Updating…</span> : null}
      </p>
      <SegmentedButton size="sm" value={range} onChange={(value) => value !== range && onRangeChange(value)} options={WORKFLOW_STATS_RANGES} />
    </div>
  )

  let body: ReactNode
  if (!stats && loading) {
    body = (
      <div role="status" aria-label="Loading statistics" className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <SkeletonBlock className="h-20" />
          <SkeletonBlock className="h-20" />
          <SkeletonBlock className="h-20" />
          <SkeletonBlock className="h-20" />
        </div>
        <SkeletonBlock className="h-56" />
        <div className="grid gap-3 @2xl:grid-cols-2">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-48" />
        </div>
      </div>
    )
  } else if (!stats) {
    body = <TaskManagerError title="The statistics could not load" message={error} onRetry={onRetry} />
  } else if (stats.runs.started === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
        <p className="text-sm font-medium">{range === "all" ? "This workflow has not run yet" : `No runs started ${phrase}`}</p>
        <p className="max-w-80 text-xs text-muted-foreground">
          {range === "all" ? "Runs appear here once a task starts this workflow." : "Earlier runs may show over a longer range."}
        </p>
        {range !== "all" ? (
          <Button variant="outline" size="sm" className="mt-1" onClick={() => onRangeChange("all")}>
            Show all time
          </Button>
        ) : null}
      </div>
    )
  } else {
    const { runs, steps } = stats
    // Shown once an agent round has usage or is waiting for it; a workflow worked only by people has none.
    const usage = stats.usage && (stats.usage.tokens.samples > 0 || stats.usage.pending > 0 || (stats.usage.shared ?? 0) > 0) ? stats.usage : undefined
    const agents = stats.agents.map((a) => ({ ...a, steps: a.steps.filter((s) => s.entered > 0) })).filter((a) => a.steps.length > 0)
    body = (
      <div className="flex flex-col gap-5">
        {error ? <TaskManagerError variant="inline" title="Could not refresh" message={error} onRetry={onRetry} /> : null}
        {runs.started < WORKFLOW_STATS_MIN_MEDIAN ? (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>
              {statPlural(runs.started, "run")}, too few for medians. The counts are exact; times appear once there are {WORKFLOW_STATS_MIN_MEDIAN} measured rounds.
            </span>
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <Tile label="Started" value={runs.started} note={runs.active > 0 ? `${runs.active} still running` : undefined} />
          <Tile
            label="Finished"
            value={runs.finished}
            note={runs.started >= WORKFLOW_STATS_MIN_MEDIAN ? `${statPercent(runs.finished, runs.started)}% of started` : undefined}
          />
          <FirstPassTile firstPass={stats.firstPass} />
          <RunTimeTile runTime={stats.runTime} />
        </div>
        {usage ? <SpentTiles usage={usage} /> : null}
        <WorkflowStatsThroughputChart throughput={stats.throughput} />
        {steps.length > 0 ? (
          <>
            <div className="grid gap-4 @2xl:grid-cols-2">
              <WorkflowStatsExitsChart steps={steps} onOpenRuns={onOpenRuns} />
              <WorkflowStatsSentBackChart steps={steps} onOpenRuns={onOpenRuns} />
            </div>
            <div className="grid gap-4 @2xl:grid-cols-2">
              <WorkflowStatsTimeChart steps={steps} />
              <WorkflowStatsSpendChart steps={steps} />
            </div>
            <WorkflowStatsCouldntStartList steps={steps} onOpenRuns={onOpenRuns} />
          </>
        ) : null}
        <section aria-label="Steps" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Steps</h3>
          {steps.length > 0 ? <StepRows steps={steps} withUsage={usage !== undefined} /> : <p className="text-sm text-muted-foreground">The workflow has no steps now.</p>}
        </section>
        {agents.length > 0 ? <ByAgent agents={agents} withUsage={usage !== undefined} /> : null}
      </div>
    )
  }

  return (
    <div data-slot="workflow-stats" className={cn("@container flex min-w-0 flex-col gap-4", className)}>
      {header}
      {body}
    </div>
  )
}
