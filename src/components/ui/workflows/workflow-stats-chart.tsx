import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react"

import { Button } from "../button"
import { Popover, PopoverContent, PopoverTrigger } from "../popover"
import { cn } from "@/lib/utils"

export type WorkflowStatsRange = "7d" | "30d" | "90d" | "all"

/** Times in milliseconds. `samples` is how many were measured; below the thresholds the figure is not shown. */
export interface WorkflowStatsDurations {
  samples: number
  median: number | null
  p90: number | null
}

/** A per-round figure over the measured rounds, with their total. */
export type WorkflowStatsAmounts = WorkflowStatsDurations & { sum: number }

/**
 * Tokens and cost per round, over rounds the task left whose agent session's
 * usage has settled. `pending` rounds still wait for the turn that finished them.
 * `shared` rounds happened inside a turn an earlier step's round counted (an
 * agent that takes the next step's message mid-turn), so they are left out of
 * the figures rather than counted as zero.
 */
export interface WorkflowStatsUsage {
  pending: number
  shared?: number
  tokens: WorkflowStatsAmounts
  /** One entry per currency. */
  cost: Array<WorkflowStatsAmounts & { currency: string }>
}

/** Tokens and cost summed over rounds whose usage has settled; one cost entry per currency. */
export interface WorkflowStatsSpend {
  tokens: number
  cost: Array<{ currency: string; amount: number }>
}

/** How a round at a step ended. */
export type WorkflowStatsExit = "moved_on" | "sent_back" | "other" | "cancelled" | "open"

/** Why a step couldn't start; `unrecorded` for times counted before reasons were kept. */
export type WorkflowStatsCouldntStart = "unassigned" | "not_in_chat" | "session_failed" | "unrecorded"

/**
 * How a step's rounds ended. `movedOn` and `sentBack` left by one of the step's
 * transitions (a pass, a fail); `other` by a status change that wasn't one of
 * them; `cancelled` ended with their run; `open` have not ended.
 */
export interface WorkflowStepExits {
  movedOn: number
  /** Per transition label, most first. */
  sentBack: Array<{ transition: string; count: number }>
  other: number
  cancelled: number
  open: number
}

export interface WorkflowStepStats {
  stepId: string
  name: string
  /** Runs that reached the step. */
  entered: number
  /** Of those, runs that entered it more than once. */
  reworked: number
  /** Its rounds: each entry into it. */
  rounds: number
  exits: WorkflowStepExits
  /** Runs that reached the step, by the rounds they took there: 1, 2, 3, and 4 or more. */
  roundsPerRun: [number, number, number, number]
  /** Times the step couldn't start, by reason, most first; `total` is their sum. */
  couldntStart: { total: number; reasons: Array<{ reason: WorkflowStatsCouldntStart; count: number }> }
  /** Per round, from the step's start to its end. */
  time: WorkflowStatsDurations
  /** Wall time of its ended rounds in finished runs, summed: its part of where their time went. */
  finishedTimeMs: number
  /** What the step's agent sessions spent per round; absent from a host that does not record it. */
  usage?: WorkflowStatsUsage
  /** The settled spend, first rounds apart from rework (rounds 2 and later). */
  spend: { first: WorkflowStatsSpend; rework: WorkflowStatsSpend }
}

/** Runs started, finished and cancelled per bucket: a UTC day, or a week starting Monday. */
export interface WorkflowStatsThroughput {
  bucket: "day" | "week"
  /** Every bucket of the range in order, empty ones included; `start` is its first day (YYYY-MM-DD). */
  points: Array<{ start: string; started: number; finished: number; cancelled: number }>
}

/**
 * The runs one figure counted: the runs started in the range shown that have a
 * round at `step` matching every criterion given.
 */
export interface WorkflowStatsRunsMatch {
  /** The step's id. */
  step: string
  /** How a round there ended; with `sent_back`, `transition` narrows it to one transition's label. */
  exit?: WorkflowStatsExit
  transition?: string
  /** Rounds the run took there; 4 means 4 or more. */
  rounds?: 1 | 2 | 3 | 4
  /** A time the step couldn't start, for this reason. */
  couldntStart?: WorkflowStatsCouldntStart
}

/** Opens the runs a figure counted. A chart given none shows its counts as plain text. */
export type WorkflowStatsOpenRuns = (match: WorkflowStatsRunsMatch) => void

/** Fewest measured rounds or runs a median, or a rate, is shown from. */
export const WORKFLOW_STATS_MIN_MEDIAN = 5
/** Fewest measured rounds or runs a 90th percentile is shown from. */
export const WORKFLOW_STATS_MIN_P90 = 10

/** The ranges, as the picker labels them, inside a sentence ("Runs started in the last 7 days"), and on their own ("last 7 days"). */
export const WORKFLOW_STATS_RANGES: Array<{ value: WorkflowStatsRange; label: string; phrase: string; span: string }> = [
  { value: "7d", label: "7 days", phrase: "in the last 7 days", span: "last 7 days" },
  { value: "30d", label: "30 days", phrase: "in the last 30 days", span: "last 30 days" },
  { value: "90d", label: "90 days", phrase: "in the last 90 days", span: "last 90 days" },
  { value: "all", label: "All", phrase: "at any time", span: "all time" },
]

export function statPlural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `part` as a whole percentage of `whole`; 0 of nothing. */
export function statPercent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** A duration as it reads in a table: 45s, 12m, 3h 20m, 2d 4h. */
export function formatStatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    const rest = m % 60
    return rest ? `${h}h ${rest}m` : `${h}h`
  }
  const d = Math.floor(h / 24)
  const rest = h % 24
  return rest ? `${d}d ${rest}h` : `${d}d`
}

export const statShowsMedian = (t: WorkflowStatsDurations) => t.median !== null && t.samples >= WORKFLOW_STATS_MIN_MEDIAN
export const statShowsP90 = (t: WorkflowStatsDurations) => t.p90 !== null && t.samples >= WORKFLOW_STATS_MIN_P90

/** A fill: a class for what changes with the theme, a style for the chart tokens (which carry their own light and dark values). */
export interface StatsTone {
  className?: string
  style?: CSSProperties
}

/** The categorical series colours, in their fixed order. A sixth series reuses the fifth rather than inventing a hue. */
export const WORKFLOW_STATS_SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const

export function statsSeriesColor(index: number): string {
  return WORKFLOW_STATS_SERIES[Math.min(Math.max(index, 0), WORKFLOW_STATS_SERIES.length - 1)]
}

export function statsSeriesTone(index: number): StatsTone {
  return { style: { backgroundColor: statsSeriesColor(index) } }
}

/**
 * The corners of segment `index` of `count` in a horizontal stacked bar: the
 * bar's two ends rounded, the joins between segments nearly square.
 */
export function statsSegmentCorners(index: number, count: number): string {
  if (count === 1) {
    return "rounded-[4px]"
  }
  if (index === 0) {
    return "rounded-l-[4px] rounded-r-[1px]"
  }
  return index === count - 1 ? "rounded-l-[1px] rounded-r-[4px]" : "rounded-[1px]"
}

/** Where a mark's readout lines up, from how far along the chart the mark's middle is (0 to 1). */
export function statsReadoutAlign(position: number): "start" | "center" | "end" {
  return position < 0.25 ? "start" : position > 0.75 ? "end" : "center"
}

const OPEN_STRIPES = "repeating-linear-gradient(135deg, color-mix(in oklab, var(--muted-foreground) 55%, transparent) 0 1.5px, transparent 1.5px 5px)"

/**
 * One colour per way a round ends, the same in every chart of the page. Sent
 * back is the warning tone; a round still open is striped, so it reads as not
 * ended rather than as a fifth outcome.
 */
export const WORKFLOW_EXIT_TONES: Record<WorkflowStatsExit, StatsTone & { label: string }> = {
  moved_on: { label: "Moved on", style: { backgroundColor: "var(--chart-2)" } },
  sent_back: { label: "Sent back", className: "bg-amber-600 dark:bg-amber-400" },
  other: { label: "Other move", style: { backgroundColor: "var(--chart-4)" } },
  cancelled: { label: "Cancelled", className: "bg-muted-foreground/40" },
  open: { label: "Still open", className: "ring-1 ring-muted-foreground/50 ring-inset", style: { backgroundImage: OPEN_STRIPES } },
}

/** Why a step couldn't start, in plain words. */
export const WORKFLOW_COULDNT_START_LABELS: Record<WorkflowStatsCouldntStart, string> = {
  unassigned: "Nobody assigned",
  not_in_chat: "Task manager not in the space chat",
  session_failed: "Session couldn’t be opened or sent to",
  unrecorded: "Reason not recorded",
}

function matchPhrase(match: WorkflowStatsRunsMatch, step: string): string {
  if (match.couldntStart) {
    return `Couldn’t start ${step}: ${WORKFLOW_COULDNT_START_LABELS[match.couldntStart]}`
  }
  if (match.rounds) {
    return `${match.rounds === 4 ? "4 or more rounds" : statPlural(match.rounds, "round")} at ${step}`
  }
  switch (match.exit) {
    case "moved_on":
      return `Moved on from ${step}`
    case "sent_back":
      return match.transition ? `Sent back from ${step} by “${match.transition}”` : `Sent back from ${step}`
    case "other":
      return `Left ${step} by another move`
    case "cancelled":
      return `Cancelled at ${step}`
    case "open":
      return `Still open at ${step}`
    default:
      return `Reached ${step}`
  }
}

/** The runs a match selects, in words: "Sent back from Review · last 30 days". */
export function describeRunsMatch(match: WorkflowStatsRunsMatch, stepName: string, range: WorkflowStatsRange): string {
  return `${matchPhrase(match, stepName)} · ${WORKFLOW_STATS_RANGES.find((r) => r.value === range)?.span ?? range}`
}

/** A swatch keyed like its mark: a block for bars, a short stroke for a line. */
export function StatsSwatch({ tone, shape = "bar", className }: { tone: StatsTone; shape?: "bar" | "line"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0", shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[3px]", tone.className, className)}
      style={tone.style}
    />
  )
}

export interface StatsLegendItem {
  key: string
  label: ReactNode
  tone: StatsTone
  shape?: "bar" | "line"
}

/** A chart's series, each keyed by the shape its mark has. The text stays in the ink tokens. */
export function StatsLegend({ items, className }: { items: StatsLegendItem[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}>
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          <StatsSwatch tone={item.tone} shape={item.shape} />
          <span className="flex min-w-0 items-baseline gap-1">{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

/** One line of a readout: the value first, then what it is. */
export function StatsReadoutRow({ tone, value, label }: { tone?: StatsTone; value: ReactNode; label: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {tone ? <StatsSwatch tone={tone} shape="line" /> : null}
      <span className="font-medium text-popover-foreground tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

/** A step's name in a chart row; a long one wraps rather than being cut short. */
export function StatsStepName({ name, className }: { name: string; className?: string }) {
  return <span className={cn("min-w-0 text-sm break-words", className)}>{name}</span>
}

/** The edge of the trigger a details popover lines up with. */
export type StatsDetailsAlign = "start" | "center" | "end"

export interface StatsDetailsProps {
  /** The trigger: a button element, given its own label and classes. */
  trigger: ReactElement
  /** What the trigger shows. */
  children?: ReactNode
  /** The figures and what they mean, in the popover. */
  details: ReactNode
  /** Opens the runs behind the figures, offered as "Open runs" in the popover. */
  onOpenRuns?: () => void
  align?: StatsDetailsAlign
}

/**
 * A figure's details, opened by a click or a tap on its trigger in a popover,
 * the same on every device. Enter or Space on the trigger opens it, Escape and
 * a click outside close it. With `onOpenRuns`, the popover's "Open runs"
 * button is what opens the runs; the trigger itself never navigates.
 */
export function StatsDetails({ trigger, children, details, onOpenRuns, align = "center" }: StatsDetailsProps) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent side="top" align={align} className="w-max max-w-64 gap-2 p-2.5 text-xs">
        <div className="flex min-w-0 flex-col gap-0.5">{details}</div>
        {onOpenRuns ? (
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            onClick={() => {
              setOpen(false)
              onOpenRuns()
            }}
          >
            Open runs
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export interface StatsMarkProps {
  /** What the mark stands for, with its figures, in words: its accessible name. */
  label: string
  /** The exact figures, shown in the popover a click or a tap on the mark opens. */
  readout: ReactNode
  /** The mark's fill; leave it out when `children` draw the mark. */
  tone?: StatsTone
  /** Where the fill sits inside the hit target, and its corners. */
  fillClassName?: string
  fillStyle?: CSSProperties
  /** Opens the runs the mark counted, from the "Open runs" button in its popover. */
  onOpenRuns?: () => void
  /** The edge the popover lines up with, so one at a chart's edge stays inside it. */
  align?: StatsDetailsAlign
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/**
 * A chart mark with its readout. The mark is a button whose hit target is the
 * whole box the mark is placed in, larger than the painted fill; a click, a
 * tap, Enter or Space opens the readout in a popover, with "Open runs" when the
 * mark counts runs.
 */
export function StatsMark({ label, readout, tone, fillClassName, fillStyle, onOpenRuns, align = "center", className, style, children }: StatsMarkProps) {
  return (
    <StatsDetails
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cn(
            "group/mark relative block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            className,
          )}
          style={style}
        />
      }
      details={readout}
      onOpenRuns={onOpenRuns}
      align={align}
    >
      {tone ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute transition-[filter] group-focus-visible/mark:brightness-110 group-data-[popup-open]/mark:brightness-110",
            fillClassName,
            tone.className,
          )}
          style={{ ...tone.style, ...fillStyle }}
        />
      ) : null}
      {children}
    </StatsDetails>
  )
}

/**
 * A count, as visible text. With `onOpenRuns` it is a button: a click or a tap
 * opens a popover saying what it counted, with "Open runs".
 */
export function StatsCount({
  label,
  onOpenRuns,
  className,
  children,
}: {
  /** What the figure counted, in words: the popover's text and the button's name. */
  label: string
  onOpenRuns?: () => void
  className?: string
  children: ReactNode
}) {
  if (!onOpenRuns) {
    return <span className={cn("tabular-nums", className)}>{children}</span>
  }
  return (
    <StatsDetails
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cn(
            "cursor-pointer rounded-sm tabular-nums underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none data-[popup-open]:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            className,
          )}
        />
      }
      details={<span className="text-popover-foreground">{label}</span>}
      onOpenRuns={onOpenRuns}
      align="start"
    >
      {children}
    </StatsDetails>
  )
}

export interface StatsChartCardProps {
  title: string
  /** What the chart counts, in a line. */
  description?: ReactNode
  legend?: ReactNode
  children: ReactNode
  className?: string
}

/** One chart: its title and what it counts, its legend, then the plot. */
export function StatsChartCard({ title, description, legend, children, className }: StatsChartCardProps) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-4", className)}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {legend}
      {children}
    </section>
  )
}
