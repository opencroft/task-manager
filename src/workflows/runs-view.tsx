// One workflow's runs, drawn by the kit's WorkflowRunsTable: which tasks are
// running it or ran it, where each run is, and who worked each step. This
// file loads them and performs what the table reports. An address carrying a
// match (see runs-match.ts) shows the runs one statistic counted instead of
// the state filter's.

import { legacy } from '@opencroft/client'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { describeRunsMatch } from '@/components/ui/workflows/workflow-stats-chart'
import { WorkflowRunsTable, type WorkflowRunsFilter } from '@/components/ui/workflows/workflow-runs-table'

import type { WorkflowDef, WorkflowRun } from '../../shared/workflows'
import { useProject } from '../app/project'
import { openTask } from '../app/task-opener'
import { useTasksLive } from '../lib/live'
import { navigateQuery, useTasksLocation } from '../lib/router'
import { threadHref, workflowsApi } from './api'
import { runsMatchOf, runsMatchParams } from './runs-match'

export function WorkflowRunsView({ instanceId, workflow }: { instanceId: string; workflow: WorkflowDef }) {
  const { fail, confirm } = useProject()
  const api = useMemo(() => workflowsApi(instanceId), [instanceId])
  const location = useTasksLocation()
  const match = useMemo(() => runsMatchOf(location.query), [location])
  const [filter, setFilter] = useState<WorkflowRunsFilter>('active')
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  // Every run the match selects; the list stops at the server's limit.
  const [total, setTotal] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.workflow_runs_list(
        match ? { workflow: workflow.id, match } : { workflow: workflow.id, state: filter === 'all' ? undefined : filter },
      )
      setRuns(result.runs)
      setTotal(result.total ?? null)
    } catch (error) {
      fail(error)
    }
  }, [api, fail, filter, match, workflow.id])

  // A new selection shows as loading rather than as the previous one's runs.
  useEffect(() => {
    setRuns(null)
    void load()
  }, [load])

  useTasksLive(instanceId, () => void load())

  const described = match ? describeRunsMatch(match, workflow.steps.find((s) => s.id === match.step)?.name ?? 'a removed step', match.range) : ''
  const scope = match
    ? {
        label: runs && total !== null && total > runs.length ? `${described} · showing the newest ${runs.length} of ${total}` : described,
        onClear: () => navigateQuery(runsMatchParams(null), { replace: true }),
      }
    : undefined

  return (
    <WorkflowRunsTable
      runs={runs}
      filter={filter}
      onFilterChange={setFilter}
      scope={scope}
      onOpenTask={(run) => openTask(run.taskKey)}
      onOpenSession={(_run, step) => {
        if (step.chatRef && step.threadId) {
          window.open(threadHref(step.chatRef, step.threadId), '_blank')
        }
      }}
      onCancel={(run) =>
        confirm({
          title: `Cancel the run on ${run.taskKey}?`,
          description: 'The open step’s session is told to stop. The task keeps its status and its run history.',
          action: 'Cancel run',
          destructive: true,
          onConfirm: async () => {
            await api.workflow_run_cancel({ task: run.taskKey })
            legacy.toast.success(`Cancelled the run on ${run.taskKey}`)
            await load()
          },
        })
      }
      emptyText={!match && filter === 'active' ? `No task is running ${workflow.name} now. Start it from a task’s page.` : undefined}
    />
  )
}
