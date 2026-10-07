import { useState } from "react"

import { SegmentedButton } from "../input/segmented-button"
import { cn } from "@/lib/utils"
import { formatCompactNumber } from "../utils/compact-number"

import {
  StatsChartCard,
  StatsLegend,
  StatsMark,
  StatsReadoutRow,
  StatsStepName,
  type WorkflowStatsSpend,
  type WorkflowStepStats,
  statPercent,
  statsReadoutAlign,
  statsSegmentCorners,
  statsSeriesTone,
} from "./workflow-stats-chart"
import { formatMoney } from "./workflow-spent"

/** The step fields the chart reads. */
export type WorkflowStatsSpendStep = Pick<WorkflowStepStats, "stepId" | "name" | "spend">

export interface WorkflowStatsSpendChartProps {
  steps: WorkflowStatsSpendStep[]
  className?: string
}

const FIRST = statsSeriesTone(0)
const REWORK = statsSeriesTone(1)
const TOKENS = "tokens"

/** Every currency some step's spend was priced in, sorted. */
function currenciesOf(steps: WorkflowStatsSpendStep[]): string[] {
  const all = steps.flatMap((step) => [...step.spend.first.cost, ...step.spend.rework.cost].map((c) => c.currency))
  return [...new Set(all)].sort()
}

/**
 * Settled spend per step, first rounds and rework side by side in one bar,
 * every bar against the step that spent most. The toggle switches between
 * tokens and cost, one currency at a time; cost is offered only when some
 * round was priced.
 */
export function WorkflowStatsSpendChart({ steps, className }: WorkflowStatsSpendChartProps) {
  const currencies = currenciesOf(steps)
  const [picked, setPicked] = useState<string>(TOKENS)
  // A currency the range no longer has falls back to tokens rather than to an empty chart.
  const measure = currencies.includes(picked) ? picked : TOKENS
  const amount = (spend: WorkflowStatsSpend) => (measure === TOKENS ? spend.tokens : (spend.cost.find((c) => c.currency === measure)?.amount ?? 0))
  const format = (value: number) => (measure === TOKENS ? `${formatCompactNumber(value)} tokens` : formatMoney(value, measure))
  const rows = steps.map((step) => ({ step, first: amount(step.spend.first), rework: amount(step.spend.rework) }))
  const peak = Math.max(0, ...rows.map((row) => row.first + row.rework))
  const options = [{ value: TOKENS, label: "Tokens" }, ...currencies.map((currency) => ({ value: currency, label: currencies.length > 1 ? `Cost (${currency})` : "Cost" }))]

  return (
    <StatsChartCard
      className={className}
      title="Spend per step"
      description="What settled rounds spent at each step: first rounds, and rework (rounds 2 and later)."
      legend={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatsLegend
            items={[
              { key: "first", label: "First round", tone: FIRST },
              { key: "rework", label: "Rework", tone: REWORK },
            ]}
          />
          {currencies.length > 0 ? <SegmentedButton size="xs" value={measure} onChange={setPicked} options={options} /> : null}
        </div>
      }
    >
      {peak === 0 ? (
        <p className="text-xs text-muted-foreground">{measure === TOKENS ? "No agent round has settled spend yet." : `Nothing was priced in ${measure}.`}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map(({ step, first, rework }) => {
            const total = first + rework
            const parts = [
              { key: "first", label: "First round", value: first, tone: FIRST },
              { key: "rework", label: "Rework", value: rework, tone: REWORK },
            ].filter((part) => part.value > 0)
            let before = 0
            return (
              <li key={step.stepId} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-x-3">
                <StatsStepName name={step.name} />
                {total === 0 ? (
                  <span className="text-xs text-muted-foreground">None settled</span>
                ) : (
                  <div className="flex h-6 min-w-0 gap-0.5" style={{ width: `${(total / peak) * 100}%` }}>
                    {parts.map((part, i) => {
                      // Against the costliest step, since this bar is only as wide as its share of it.
                      const middle = (before + part.value / 2) / peak
                      before += part.value
                      const share = statPercent(part.value, total)
                      return (
                        <StatsMark
                          key={part.key}
                          label={`${step.name}: ${part.label}, ${format(part.value)} (${share}% of the step)`}
                          readout={
                            <>
                              <span className="text-muted-foreground">{step.name}</span>
                              <StatsReadoutRow tone={part.tone} value={format(part.value)} label={`${part.label.toLowerCase()} · ${share}%`} />
                            </>
                          }
                          tone={part.tone}
                          fillClassName={cn("inset-x-0 inset-y-1", statsSegmentCorners(i, parts.length))}
                          align={statsReadoutAlign(middle)}
                          className="h-full min-w-1.5"
                          style={{ flexGrow: part.value, flexBasis: 0 }}
                        />
                      )
                    })}
                  </div>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">{total > 0 ? format(total) : null}</span>
              </li>
            )
          })}
        </ul>
      )}
    </StatsChartCard>
  )
}
