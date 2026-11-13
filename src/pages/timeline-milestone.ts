// Which milestone the Timeline shows. The pick is in the URL
// (`?milestone=<name>`), so Back returns to the previous one and a link opens
// the same one, and it is remembered per project in this browser. With
// neither, the Timeline opens the default of `milestone-pick`. Only open
// milestones are shown.

import { useCallback, useEffect, useMemo, useRef } from 'react'

import { fromDay, today } from '@/components/ui/timeline/timeline-scale'
import type { Milestone } from '../../shared/milestones'
import { useProject } from '../app/project'
import { navigateQuery, useTasksLocation } from '../lib/router'
import { pickMilestone } from './milestone-pick'

/** The URL parameter that names the milestone shown. */
const MILESTONE_PARAM = 'milestone'

export interface TimelineMilestoneState {
  /** The project's open milestones, in the listing order. */
  open: Milestone[]
  /** The milestone shown; null while there is none to show (or not decided yet). */
  milestone: Milestone | null
  /** False until the milestones have loaded and the pick is settled. */
  ready: boolean
  /** Shows another milestone, with a history entry. */
  select: (name: string) => void
  /** Shows a milestone just created, which the project's list may not hold yet. */
  showCreated: (name: string) => void
}

export function useTimelineMilestone(): TimelineMilestoneState {
  const { milestones, labelsLoaded, projectKey } = useProject()
  const param = useTasksLocation().query.get(MILESTONE_PARAM)
  const storageKey = `tasks:${projectKey}:timeline:milestone`
  const open = useMemo(() => milestones.filter((milestone) => milestone.state === 'open'), [milestones])
  // A milestone just created is named in the URL before the project's list has it: it is waited for, not replaced.
  const created = useRef<string | null>(null)
  const waiting =
    param !== null &&
    created.current?.toLowerCase() === param.toLowerCase() &&
    !open.some((m) => m.name.toLowerCase() === param.toLowerCase())

  const pick = useMemo(
    () =>
      labelsLoaded && !waiting ? pickMilestone(open, param, localStorage.getItem(storageKey), fromDay(today())) : null,
    [labelsLoaded, waiting, open, param, storageKey],
  )

  useEffect(() => {
    if (pick?.milestone) {
      localStorage.setItem(storageKey, String(pick.milestone.id))
    }
    if (pick?.rewrite) {
      navigateQuery({ [MILESTONE_PARAM]: pick.milestone?.name ?? null }, { replace: true })
    }
  }, [pick, storageKey])

  const select = useCallback((name: string) => navigateQuery({ [MILESTONE_PARAM]: name }), [])
  const showCreated = useCallback((name: string) => {
    created.current = name
    navigateQuery({ [MILESTONE_PARAM]: name })
  }, [])

  return { open, milestone: pick?.milestone ?? null, ready: pick !== null, select, showCreated }
}
