import { cn } from "@/lib/utils"

import {
  StatsChartCard,
  StatsCount,
  StatsLegend,
  StatsMark,
  StatsReadoutRow,
  StatsStepName,
  WORKFLOW_EXIT_TONES,
  type WorkflowStatsExit,
  type WorkflowStatsOpenRuns,
  type WorkflowStepExits,
  type WorkflowStepStats,
  statPercent,
  statPlural,
  statsReadoutAlign,
  statsSegmentCorners,
  statsSeriesTone,
} from "./workflow-stats-chart"

/** The step fields these charts read. */
export type WorkflowStatsExitsStep = Pick<WorkflowStepStats, "stepId" | "name" | "rounds" | "exits" | "roundsPerRun">

export interface WorkflowStatsExitsChartProps {
  steps: WorkflowStatsExitsStep[]
  /** Opens the runs a segment counted, from "Open runs" in its popover. Without it the segments only show their figures. */
  onOpenRuns?: WorkflowStatsOpenRuns
  className?: string
}

const EXIT_ORDER: WorkflowStatsExit[] = ["moved_on", "sent_back", "other", "cancelled", "open"]

interface Segment {
  key: string
  exit: WorkflowStatsExit
  /** A sent-back segment's transition label. */
  transition?: string
  label: string
  count: number
}

const sentBackTotal = (exits: WorkflowStepExits) => exits.sentBack.reduce((sum, s) => sum + s.count, 0)

/** A step's rounds in the order of the legend, one segment per sent-back transition, empty ones left out. */
function segmentsOf(exits: WorkflowStepExits): Segment[] {
  const tones = WORKFLOW_EXIT_TONES
  const segments: Segment[] = [
    { key: "moved_on", exit: "moved_on", label: tones.moved_on.label, count: exits.movedOn },
    ...exits.sentBack.map(({ transition, count }) => ({
      key: `sent_back:${transition}`,
      exit: "sent_back" as const,
      transition,
      label: `${tones.sent_back.label}: ${transition}`,
      count,
    })),
    { key: "other", exit: "other", label: tones.other.label, count: exits.other },
    { key: "cancelled", exit: "cancelled", label: tones.cancelled.label, count: exits.cancelled },
    { key: "open", exit: "open", label: tones.open.label, count: exits.open },
  ]
  return segments.filter((s) => s.count > 0)
}

/** The same counts as text, so they read without opening a segment: "18 moved on · 5 sent back · 3 still open". */
function exitsSummary(exits: WorkflowStepExits): string {
  const counts: Array<[WorkflowStatsExit, number]> = [
    ["moved_on", exits.movedOn],
    ["sent_back", sentBackTotal(exits)],
    ["other", exits.other],
    ["cancelled", exits.cancelled],
    ["open", exits.open],
  ]
  return counts
    .filter(([, count]) => count > 0)
    .map(([exit, count]) => `${count} ${WORKFLOW_EXIT_TONES[exit].label.toLowerCase()}`)
    .join(" · ")
}

function ExitsRow({ step, onOpenRuns }: { step: WorkflowStatsExitsStep; onOpenRuns?: WorkflowStatsOpenRuns }) {
  const segments = segmentsOf(step.exits)
  const total = segments.reduce((sum, s) => sum + s.count, 0)
  let before = 0
  return (
    <li className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-x-3">
      <StatsStepName name={step.name} className="leading-6" />
      {total === 0 ? (
        <span className="text-xs leading-6 text-muted-foreground">No rounds</span>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex h-6 w-full gap-0.5">
            {segments.map((s, i) => {
              const middle = (before + s.count / 2) / total
              before += s.count
              const share = statPercent(s.count, total)
              const open = onOpenRuns
                ? () => onOpenRuns({ step: step.stepId, exit: s.exit, ...(s.transition !== undefined ? { transition: s.transition } : {}) })
                : undefined
              return (
                <StatsMark
                  key={s.key}
                  label={`${step.name}: ${s.label}, ${statPlural(s.count, "round")} of ${total} (${share}%)`}
                  readout={
                    <>
                      <span className="text-muted-foreground">{step.name}</span>
                      <StatsReadoutRow tone={WORKFLOW_EXIT_TONES[s.exit]} value={`${s.count} · ${share}%`} label={s.label} />
                    </>
                  }
                  tone={WORKFLOW_EXIT_TONES[s.exit]}
                  fillClassName={cn("inset-x-0 inset-y-1", statsSegmentCorners(i, segments.length))}
                  onOpenRuns={open}
                  align={statsReadoutAlign(middle)}
                  className="h-full min-w-1.5"
                  style={{ flexGrow: s.count, flexBasis: 0 }}
                />
              )
            })}
          </div>
          <p className="text-[11px] text-muted-foreground tabular-nums">{exitsSummary(step.exits)}</p>
        </div>
      )}
    </li>
  )
}

/**
 * How each step's rounds ended, as one full-width bar per step. A sent-back
 * segment per transition label; a click or a tap on a segment opens its count
 * and share in a popover, with "Open runs" for the runs it counted.
 */
export function WorkflowStatsExitsChart({ steps, onOpenRuns, className }: WorkflowStatsExitsChartProps) {
  return (
    <StatsChartCard
      className={className}
      title="How tasks get closed"
      description="Each step's rounds, by how they left it: moved on or sent back by one of its transitions, another status move, cancelled with the run, or still open."
      legend={<StatsLegend items={EXIT_ORDER.map((exit) => ({ key: exit, label: WORKFLOW_EXIT_TONES[exit].label, tone: WORKFLOW_EXIT_TONES[exit] }))} />}
    >
      <ul className="flex flex-col gap-3">
        {steps.map((step) => (
          <ExitsRow key={step.stepId} step={step} onOpenRuns={onOpenRuns} />
        ))}
      </ul>
    </StatsChartCard>
  )
}

const HISTOGRAM = statsSeriesTone(0)
const ROUND_COUNTS = [1, 2, 3, 4] as const

const roundsName = (rounds: 1 | 2 | 3 | 4) => (rounds === 4 ? "4 or more rounds" : statPlural(rounds, "round"))

function SentBackRow({ step, onOpenRuns }: { step: WorkflowStatsExitsStep; onOpenRuns?: WorkflowStatsOpenRuns }) {
  const sent = sentBackTotal(step.exits)
  // Rounds that ended by one of the step's transitions or another status move: those that could have sent it back.
  const ended = step.exits.movedOn + sent + step.exits.other
  const runs = step.roundsPerRun.reduce((sum, n) => sum + n, 0)
  const peak = Math.max(1, ...step.roundsPerRun)
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <StatsStepName name={step.name} />
        {ended === 0 ? (
          <span className="text-xs text-muted-foreground">{step.rounds === 0 ? "No rounds" : "No round has ended yet"}</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <StatsCount
              label={`${statPercent(sent, ended)}% of the rounds that ended at ${step.name} sent the task back: ${sent} of ${statPlural(ended, "round")}`}
              onOpenRuns={onOpenRuns && sent > 0 ? () => onOpenRuns({ step: step.stepId, exit: "sent_back" }) : undefined}
              className="text-lg font-semibold"
            >
              {statPercent(sent, ended)}%
            </StatsCount>
            <span className="text-xs text-muted-foreground tabular-nums">
              {sent} of {statPlural(ended, "round")}
            </span>
          </span>
        )}
      </div>
      {runs > 0 ? (
        <div role="group" aria-label={`Rounds per run at ${step.name}`} className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">Rounds per run</span>
          <div className="flex h-10 items-end border-b border-border">
            {ROUND_COUNTS.map((rounds, i) => {
              const count = step.roundsPerRun[i]
              return (
                <StatsMark
                  key={rounds}
                  label={`${statPlural(count, "run")} took ${roundsName(rounds)} at ${step.name}`}
                  readout={<StatsReadoutRow tone={HISTOGRAM} value={statPlural(count, "run")} label={`took ${roundsName(rounds)}`} />}
                  tone={count > 0 ? HISTOGRAM : undefined}
                  fillClassName="inset-x-px bottom-0 rounded-t-[4px]"
                  fillStyle={{ height: `${(count / peak) * 100}%` }}
                  onOpenRuns={onOpenRuns && count > 0 ? () => onOpenRuns({ step: step.stepId, rounds }) : undefined}
                  align="end"
                  className="h-full w-6"
                />
              )
            })}
          </div>
          <div aria-hidden="true" className="flex text-[10px] text-muted-foreground tabular-nums">
            {ROUND_COUNTS.map((rounds) => (
              <span key={rounds} className="w-6 text-center">
                {rounds === 4 ? "4+" : rounds}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  )
}

export interface WorkflowStatsSentBackChartProps {
  steps: WorkflowStatsExitsStep[]
  /** Opens the runs a rate or a column counted, from "Open runs" in its popover. Without it a rate is plain text. */
  onOpenRuns?: WorkflowStatsOpenRuns
  className?: string
}

/**
 * How often each step sent the task back: the share of its rounds that ended
 * by a transition (or another status move) and went back, with how many rounds
 * runs took there, 1, 2, 3, or 4 and more.
 */
export function WorkflowStatsSentBackChart({ steps, onOpenRuns, className }: WorkflowStatsSentBackChartProps) {
  return (
    <StatsChartCard
      className={className}
      title="Sent back"
      description="The share of each step's ended rounds that sent the task back, and how many rounds runs took there."
    >
      <ul className="flex flex-col gap-3">
        {steps.map((step) => (
          <SentBackRow key={step.stepId} step={step} onOpenRuns={onOpenRuns} />
        ))}
      </ul>
    </StatsChartCard>
  )
}
