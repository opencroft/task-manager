import { cn } from "@/lib/utils"

import {
  StatsChartCard,
  StatsLegend,
  StatsMark,
  StatsReadoutRow,
  StatsStepName,
  type WorkflowStatsDurations,
  type WorkflowStepStats,
  formatStatDuration,
  statPercent,
  statPlural,
  statShowsMedian,
  statShowsP90,
  statsReadoutAlign,
  statsSegmentCorners,
  statsSeriesTone,
} from "./workflow-stats-chart"

/** The step fields the chart reads. */
export type WorkflowStatsTimeStep = Pick<WorkflowStepStats, "stepId" | "name" | "time" | "finishedTimeMs">

/** The time a list of bars is drawn against: the longest 90th percentile shown, or median where none is. */
export function statsTimeScale(times: WorkflowStatsDurations[]): number {
  return Math.max(1, ...times.map((t) => (statShowsP90(t) ? (t.p90 as number) : statShowsMedian(t) ? (t.median as number) : 0)))
}

/**
 * A step's time per round: the figures, and a bar with the median solid and
 * the 90th percentile as its lighter tail, against `scale` (see
 * `statsTimeScale`). Too few measured rounds say so instead.
 */
export function WorkflowStatsTimeBar({ time, scale }: { time: WorkflowStatsDurations; scale: number }) {
  if (time.samples === 0) {
    return <span className="text-xs text-muted-foreground">Not measured</span>
  }
  if (!statShowsMedian(time)) {
    return <span className="text-xs text-muted-foreground">{statPlural(time.samples, "round")} measured, too few for a median</span>
  }
  const median = time.median as number
  const p90 = statShowsP90(time) ? (time.p90 as number) : null
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
        <span className="font-medium">{formatStatDuration(median)}</span>
        <span className="text-xs text-muted-foreground">{p90 !== null ? `90% within ${formatStatDuration(p90)}` : "too few for a 90th percentile"}</span>
      </span>
      <span aria-hidden="true" className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {p90 !== null ? (
          <span className="absolute inset-y-0 left-0 rounded-full opacity-35" style={{ width: `${Math.min(100, (p90 / scale) * 100)}%`, backgroundColor: "var(--chart-2)" }} />
        ) : null}
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (median / scale) * 100)}%`, backgroundColor: "var(--chart-2)" }} />
      </span>
    </span>
  )
}

export interface WorkflowStatsTimeChartProps {
  steps: WorkflowStatsTimeStep[]
  className?: string
}

/**
 * Where finished runs' time went: one bar split into each step's share, a
 * colour per step position, then each step's time per round. A click or a
 * tap on a share opens its duration in a popover; the legend carries the
 * percentages.
 */
export function WorkflowStatsTimeChart({ steps, className }: WorkflowStatsTimeChartProps) {
  const total = steps.reduce((sum, step) => sum + step.finishedTimeMs, 0)
  // The colour follows the step's position, so a step without time keeps the others' colours where they were.
  const shares = steps.map((step, position) => ({ step, position })).filter(({ step }) => step.finishedTimeMs > 0)
  const scale = statsTimeScale(steps.map((step) => step.time))
  let before = 0
  return (
    <StatsChartCard
      className={className}
      title="Where the time goes"
      description="Each step's part of the time finished runs took, then its time per round: the median, with 90% of rounds within the lighter tail."
      legend={
        shares.length > 0 ? (
          <StatsLegend
            items={shares.map(({ step, position }) => ({
              key: step.stepId,
              tone: statsSeriesTone(position),
              label: (
                <>
                  <span className="min-w-0 break-words">{step.name}</span>
                  <span className="tabular-nums">{statPercent(step.finishedTimeMs, total)}%</span>
                </>
              ),
            }))}
          />
        ) : undefined
      }
    >
      {total === 0 ? (
        <p className="text-xs text-muted-foreground">No run has finished yet, so there is no time to split.</p>
      ) : (
        <div className="flex h-6 w-full gap-0.5">
          {shares.map(({ step, position }, i) => {
            const middle = (before + step.finishedTimeMs / 2) / total
            before += step.finishedTimeMs
            const share = statPercent(step.finishedTimeMs, total)
            return (
              <StatsMark
                key={step.stepId}
                label={`${step.name}: ${formatStatDuration(step.finishedTimeMs)}, ${share}% of finished runs' time`}
                readout={
                  <>
                    <span className="text-muted-foreground">{step.name}</span>
                    <StatsReadoutRow tone={statsSeriesTone(position)} value={`${formatStatDuration(step.finishedTimeMs)} · ${share}%`} label="of finished runs' time" />
                  </>
                }
                tone={statsSeriesTone(position)}
                fillClassName={cn("inset-x-0 inset-y-1", statsSegmentCorners(i, shares.length))}
                align={statsReadoutAlign(middle)}
                className="h-full min-w-1.5"
                style={{ flexGrow: step.finishedTimeMs, flexBasis: 0 }}
              />
            )
          })}
        </div>
      )}
      <ul className="flex flex-col gap-2.5 border-t pt-3">
        {steps.map((step) => (
          <li key={step.stepId} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-x-3">
            <StatsStepName name={step.name} className="leading-5" />
            <WorkflowStatsTimeBar time={step.time} scale={scale} />
          </li>
        ))}
      </ul>
    </StatsChartCard>
  )
}
