import {
  StatsChartCard,
  StatsCount,
  StatsStepName,
  WORKFLOW_COULDNT_START_LABELS,
  type WorkflowStatsOpenRuns,
  type WorkflowStepStats,
  statPlural,
} from "./workflow-stats-chart"

/** The step fields the list reads. */
export type WorkflowStatsCouldntStartStep = Pick<WorkflowStepStats, "stepId" | "name" | "couldntStart">

export interface WorkflowStatsCouldntStartListProps {
  steps: WorkflowStatsCouldntStartStep[]
  /** Opens the runs a count counted. Without it the counts are plain text. */
  onOpenRuns?: WorkflowStatsOpenRuns
  className?: string
}

/**
 * The steps that couldn't start at some point, each with its times per reason,
 * most first. Steps that always could are left out, and with none left one
 * quiet line says so.
 */
export function WorkflowStatsCouldntStartList({ steps, onOpenRuns, className }: WorkflowStatsCouldntStartListProps) {
  const blocked = steps.filter((step) => step.couldntStart.total > 0)
  return (
    <StatsChartCard className={className} title="Couldn’t start" description="Times a step was entered but its work couldn’t begin, by reason.">
      {blocked.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every step could start.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {blocked.map((step) => (
            <li key={step.stepId} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <StatsStepName name={step.name} className="font-medium" />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{statPlural(step.couldntStart.total, "time")}</span>
              </span>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {step.couldntStart.reasons.map(({ reason, count }) => (
                  <li key={reason} className="flex min-w-0 items-baseline gap-1.5 text-xs">
                    <StatsCount
                      label={`${step.name} couldn’t start ${statPlural(count, "time")}: ${WORKFLOW_COULDNT_START_LABELS[reason]}`}
                      onOpenRuns={onOpenRuns ? () => onOpenRuns({ step: step.stepId, couldntStart: reason }) : undefined}
                      className="text-sm font-medium"
                    >
                      {count}
                    </StatsCount>
                    <span className="text-muted-foreground">{WORKFLOW_COULDNT_START_LABELS[reason]}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </StatsChartCard>
  )
}
