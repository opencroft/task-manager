import { cn } from "@/lib/utils"

import {
  StatsChartCard,
  StatsLegend,
  StatsMark,
  StatsReadoutRow,
  type StatsTone,
  WORKFLOW_EXIT_TONES,
  type WorkflowStatsThroughput,
  statsReadoutAlign,
  statsSeriesColor,
  statsSeriesTone,
} from "./workflow-stats-chart"

const FINISHED: StatsTone = statsSeriesTone(0)
const STARTED_COLOR = statsSeriesColor(1)
const STARTED: StatsTone = statsSeriesTone(1)
const CANCELLED: StatsTone = WORKFLOW_EXIT_TONES.cancelled
const LEVELS = [1, 2, 3, 4]

// The smallest whole "nice" step (1, 2 or 5 times a power of ten) whose
// last level reaches the maximum, so every level reads as a round count and
// the top one contains the data.
function countStep(max: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(max, 1) / LEVELS.length))
  for (const m of [1, 2, 5]) {
    if (m * magnitude * LEVELS.length >= max) {
      return Math.max(1, m * magnitude)
    }
  }
  return Math.max(1, 10 * magnitude)
}

/** A bucket by its first day: "Sep 23", or "Week of Sep 21". */
function bucketLabel(start: string, bucket: WorkflowStatsThroughput["bucket"]): string {
  const day = new Date(`${start}T00:00:00Z`)
  if (Number.isNaN(day.getTime())) {
    return start
  }
  const text = day.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
  return bucket === "week" ? `Week of ${text}` : text
}

export interface WorkflowStatsThroughputChartProps {
  throughput: WorkflowStatsThroughput
  className?: string
}

/**
 * Runs per day or week: finished runs as columns with the cancelled ones
 * stacked on them, runs started as a line, all against one count axis. Each
 * bucket is one hit target, its whole height; a click or a tap on it opens a
 * popover listing all three.
 */
export function WorkflowStatsThroughputChart({ throughput, className }: WorkflowStatsThroughputChartProps) {
  const { bucket, points } = throughput
  const n = points.length
  const step = countStep(Math.max(0, ...points.map((p) => Math.max(p.started, p.finished + p.cancelled))))
  const top = step * LEVELS.length
  const height = (count: number) => (count / top) * 100
  const x = (i: number) => ((i + 0.5) / n) * 100
  const legend = (
    <StatsLegend
      items={[
        { key: "started", label: "Started", tone: STARTED, shape: "line" },
        { key: "finished", label: "Finished", tone: FINISHED },
        { key: "cancelled", label: "Cancelled", tone: CANCELLED },
      ]}
    />
  )

  return (
    <StatsChartCard
      className={className}
      title="Throughput over time"
      description={`Per ${bucket}: runs started, and runs that finished or were cancelled.`}
      legend={legend}
    >
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">No runs in this range.</p>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
          <div aria-hidden="true" className="relative h-40 min-w-4">
            {LEVELS.map((level) => (
              <span
                key={level}
                className="absolute right-0 translate-y-1/2 text-[10px] leading-none text-muted-foreground tabular-nums"
                style={{ bottom: `${height(level * step)}%` }}
              >
                {level * step}
              </span>
            ))}
          </div>
          <div role="group" aria-label={`Runs per ${bucket}`} className="relative h-40 border-b border-border">
            {LEVELS.map((level) => (
              <span
                key={level}
                aria-hidden="true"
                className="absolute inset-x-0 border-t border-dashed border-border/70"
                style={{ bottom: `${height(level * step)}%` }}
              />
            ))}
            <div className="absolute inset-0 flex">
              {points.map((p, i) => {
                const label = bucketLabel(p.start, bucket)
                const stack = [
                  { key: "finished", count: p.finished, tone: FINISHED },
                  { key: "cancelled", count: p.cancelled, tone: CANCELLED },
                ].filter((s) => s.count > 0)
                return (
                  <StatsMark
                    key={p.start}
                    label={`${label}: ${p.started} started, ${p.finished} finished, ${p.cancelled} cancelled`}
                    readout={
                      <>
                        <span className="text-muted-foreground">{label}</span>
                        <StatsReadoutRow tone={STARTED} value={p.started} label="started" />
                        <StatsReadoutRow tone={FINISHED} value={p.finished} label="finished" />
                        <StatsReadoutRow tone={CANCELLED} value={p.cancelled} label="cancelled" />
                      </>
                    }
                    align={statsReadoutAlign((i + 0.5) / n)}
                    className="flex h-full min-w-0 flex-1 flex-col items-center justify-end hover:bg-muted/50 focus-visible:bg-muted/50 data-[popup-open]:bg-muted/50"
                  >
                    {stack.length > 0 ? (
                      <span
                        aria-hidden="true"
                        className="flex w-3/5 max-w-6 flex-col-reverse gap-0.5"
                        style={{ height: `${height(p.finished + p.cancelled)}%` }}
                      >
                        {stack.map((s, k) => (
                          <span
                            key={s.key}
                            className={cn("min-h-px", k === stack.length - 1 && "rounded-t-[4px]", s.tone.className)}
                            style={{ ...s.tone.style, flexGrow: s.count, flexBasis: 0 }}
                          />
                        ))}
                      </span>
                    ) : null}
                  </StatsMark>
                )
              })}
            </div>
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                points={points.map((p, i) => `${x(i)},${100 - height(p.started)}`).join(" ")}
                fill="none"
                stroke={STARTED_COLOR}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {n === 1 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute z-10 size-2.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-background"
                style={{ left: `${x(0)}%`, bottom: `${height(points[0].started)}%`, backgroundColor: STARTED_COLOR }}
              />
            ) : null}
          </div>
          <span aria-hidden="true" />
          <div aria-hidden="true" className="flex justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{bucketLabel(points[0].start, bucket)}</span>
            {n > 1 ? <span>{bucketLabel(points[n - 1].start, bucket)}</span> : null}
          </div>
        </div>
      )}
    </StatsChartCard>
  )
}
