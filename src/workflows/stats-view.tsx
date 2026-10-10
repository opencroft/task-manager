// One workflow's statistics, drawn by the kit's WorkflowStats. This file loads
// them for the range picked, and again whenever the project's tasks change. A
// count clicked opens the Runs tab on the runs it counted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { WorkflowStats } from '@/components/ui/workflows/workflow-stats'
import { STATS_RANGES, type WorkflowStats as Stats, type StatsRange, type WorkflowDef } from '../../shared/workflows'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { navigateQuery, useQueryParam } from '../lib/router'
import { workflowsApi } from './api'
import { runsMatchParams } from './runs-match'

export function WorkflowStatsView({ instanceId, workflow }: { instanceId: string; workflow: WorkflowDef }) {
  const api = useMemo(() => workflowsApi(instanceId), [instanceId])
  // The range lives in the address, the same parameter a clicked count's runs carry, so Back from them returns to it.
  const [rangeParam, setRangeParam] = useQueryParam('range')
  const range: StatsRange = (STATS_RANGES as readonly string[]).includes(rangeParam ?? '')
    ? (rangeParam as StatsRange)
    : '30d'
  const setRange = (next: StatsRange) => setRangeParam(next === '30d' ? null : next)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may land: a slower answer for an earlier range must not replace a newer one.
  const latest = useRef(0)

  const load = useCallback(async () => {
    const request = ++latest.current
    setLoading(true)
    try {
      const next = await api.workflow_stats({ workflow: workflow.id, range })
      if (request === latest.current) {
        setStats(next)
        setError(null)
      }
    } catch (failure) {
      if (request === latest.current) {
        setError(errorMessage(failure))
      }
    } finally {
      if (request === latest.current) {
        setLoading(false)
      }
    }
  }, [api, range, workflow.id])

  useEffect(() => {
    void load()
  }, [load])

  useTasksLive(instanceId, () => void load())

  return (
    <WorkflowStats
      className='max-w-4xl'
      stats={stats}
      range={range}
      onRangeChange={setRange}
      // A history entry of its own, so Back returns to the statistics.
      onOpenRuns={(match) => navigateQuery({ tab: 'runs', ...runsMatchParams({ ...match, range }) })}
      loading={loading}
      error={error}
      onRetry={() => void load()}
    />
  )
}
