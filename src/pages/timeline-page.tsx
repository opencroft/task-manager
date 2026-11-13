// The Timeline page: one milestone at a time, its tasks as a tree beside a
// zoomable time scale, and the backlog of tasks in no milestone below. The
// surface is the kit's TimelineView; this page picks the milestone, feeds the
// view the two lists, and turns what it reports into task actions. Dragging a
// task from the backlog onto the timeline puts it into the milestone shown;
// dragging one back takes it out with its dates kept.

import { ExternalLink, Unlink } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { TaskManagerEmpty } from '@/components/ui/states/task-manager-empty'
import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { TaskMilestoneEditor, type TaskMilestoneInput } from '@/components/ui/tasks/task-milestones-manager'
import type { TimelineChange } from '@/components/ui/timeline/timeline-drop'
import type { TimelineLink } from '@/components/ui/timeline/timeline-links-model'
import { TimelineMilestonePicker } from '@/components/ui/timeline/timeline-milestone-picker'
import type { TimelineMilestone } from '@/components/ui/timeline/timeline-milestone-row'
import type { TaskPlacement, TimelineTask } from '@/components/ui/timeline/timeline-model'
import type { TimelineVersionMarker } from '@/components/ui/timeline/timeline-version-markers'
import { TimelineView } from '@/components/ui/timeline/timeline-view'
import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { openTask } from '../app/task-opener'
import { errorMessage } from '../lib/api'
import { toTaskMilestone } from '../lib/milestones'
import { usePhoneWidth } from '../lib/phone-width'
import { currentLocation, hrefFor, navigate } from '../lib/router'
import { useTimelineLists } from './timeline-lists'
import { useTimelineMilestone } from './timeline-milestone'

/** A task as the timeline draws it. */
function toTimelineTask(task: TaskSummary): TimelineTask {
  return {
    key: task.key,
    summary: task.summary,
    type: task.type,
    parentKey: task.parentKey,
    rank: task.rank,
    startDate: task.startDate,
    endDate: task.endDate,
    status: { name: task.status.name, category: task.status.category, color: task.status.color },
    assignee: task.assignee ? { kind: task.assignee.kind, name: task.assignee.name } : null,
  }
}

/** The dates a change leaves a task with, for showing it before the server confirms. */
function withChange(task: TaskSummary, change: TimelineChange): TaskSummary {
  if (change.type === 'schedule') {
    return { ...task, startDate: change.start, endDate: change.end }
  }
  if (change.type === 'unschedule') {
    return { ...task, startDate: null, endDate: null }
  }
  return task
}

export function TimelinePage() {
  const { api, projectKey, versions, milestones, fail, menuFor, confirm } = useProject()
  // A marker for each planned version at its target date and each released one at its release date; archived ones are not drawn.
  const versionMarkers = useMemo<TimelineVersionMarker[]>(
    () =>
      versions.flatMap((version) => {
        const date =
          version.state === 'planned' ? version.targetDate : version.state === 'released' ? version.releasedAt : null
        return date && version.state !== 'archived'
          ? [{ id: String(version.id), name: version.name, date, state: version.state }]
          : []
      }),
    [versions],
  )
  const shown = useTimelineMilestone()
  const { lists, loadError, reload, patch } = useTimelineLists(shown.milestone, shown.ready)
  // The milestone the lists on screen belong to, as it is now (a rename or new dates show at once).
  const listed = lists?.milestoneId == null ? null : (milestones.find((m) => m.id === lists.milestoneId) ?? null)
  const [changeError, setChangeError] = useState<string | null>(null)
  const [creatingMilestone, setCreatingMilestone] = useState(false)
  const { selectedKey, select } = usePageShortcuts()
  const rootRef = useRef<HTMLDivElement>(null)
  // At phone width the timeline shows one pane at a time and a tap opens a task.
  const compact = usePhoneWidth(rootRef)

  const byKey = useMemo(
    () => new Map([...(lists?.tree ?? []), ...(lists?.backlog ?? [])].map((task) => [task.key, task])),
    [lists],
  )
  // One timeline task per task object: a task a refresh kept (`keepUnchanged`)
  // or a change left alone keeps its timeline object too, so its row skips its render.
  const timelineOf = useRef(new WeakMap<TaskSummary, TimelineTask>())
  const toTimeline = useCallback((list: TaskSummary[]) => {
    return list.map((task) => {
      const known = timelineOf.current.get(task)
      if (known) {
        return known
      }
      const made = toTimelineTask(task)
      timelineOf.current.set(task, made)
      return made
    })
  }, [])
  const treeTasks = useMemo(() => toTimeline(lists?.tree ?? []), [lists?.tree, toTimeline])
  const backlogTasks = useMemo(() => toTimeline(lists?.backlog ?? []), [lists?.backlog, toTimeline])

  const listedName = listed?.name
  const listedStart = listed?.startDate
  const listedTarget = listed?.targetDate
  const timelineMilestone = useMemo<TimelineMilestone | undefined>(
    () =>
      listedName === undefined ? undefined : { name: listedName, startDate: listedStart, targetDate: listedTarget },
    [listedName, listedStart, listedTarget],
  )
  const kitMilestones = useMemo(() => milestones.map(toTaskMilestone), [milestones])
  const openKitMilestones = useMemo(() => kitMilestones.filter((m) => m.state === 'open'), [kitMilestones])
  const menuMilestones = useMemo(() => openKitMilestones.map(({ id, name }) => ({ id, name })), [openKitMilestones])

  // A refused change is shown above the timeline, and the page reloads, which
  // puts back whatever the server holds.
  const recover = useCallback(
    (error: unknown) => {
      setChangeError(errorMessage(error))
      reload()
    },
    [reload],
  )

  // Into a milestone (an id) or out of every one (null): one write, which takes the subtasks along and dates
  // the tasks entering; then the place in the list it was dropped on, when it was dropped on one.
  const moveToMilestone = useCallback(
    async (
      key: string,
      milestone: number | null,
      rest: { startDate?: string; endDate?: string; placement?: TaskPlacement } = {},
    ) => {
      const { placement, ...dates } = rest
      await api.task_update({ key, milestone, ...dates })
      if (placement) {
        await api.task_move({ key, ...placement })
      }
    },
    [api],
  )

  const onChange = useCallback(
    (change: TimelineChange) => {
      // Dates show at once; the live refresh then confirms them. A move, or a
      // task joining or leaving the milestone, waits for the server, since only
      // the server computes rank and the dates of a task entering a milestone.
      if (change.type === 'schedule' || change.type === 'unschedule') {
        patch(change.key, (task) => withChange(task, change))
      }
      const request =
        change.type === 'schedule'
          ? api.task_update({ key: change.key, startDate: change.start, endDate: change.end })
          : change.type === 'unschedule'
            ? api.task_update({ key: change.key, startDate: null, endDate: null })
            : change.type === 'move'
              ? api.task_move({ key: change.key, ...change.placement })
              : change.type === 'join'
                ? lists?.milestoneId == null
                  ? Promise.resolve()
                  : moveToMilestone(change.key, lists.milestoneId, {
                      startDate: change.start,
                      endDate: change.end,
                      placement: change.placement,
                    })
                : moveToMilestone(change.key, null, { placement: change.placement })
      request.catch(recover)
    },
    [api, lists?.milestoneId, moveToMilestone, patch, recover],
  )

  // A refusal rejects: the create row shows why and keeps what was typed. A
  // task made in the tree goes into the milestone shown, which dates it.
  const onCreate = useCallback(
    async ({ summary, parent, list }: { summary: string; parent: string | null; list: 'tree' | 'backlog' }) => {
      const milestone = list === 'tree' ? lists?.milestoneId : undefined
      await api.task_create({ summary, parent, ...(milestone == null ? {} : { milestone }) })
    },
    [api, lists?.milestoneId],
  )

  const menuForTask = useCallback(
    (task: TimelineTask) => {
      const summary = byKey.get(task.key)
      if (!summary) {
        return {}
      }
      const current = summary.milestone ? milestones.find((m) => m.name === summary.milestone?.name) : undefined
      return menuFor(summary, {
        milestones: menuMilestones,
        milestoneId: current ? String(current.id) : null,
        onMilestoneChange: (id) => void moveToMilestone(task.key, id === null ? null : Number(id)).catch(recover),
      })
    },
    [byKey, menuFor, menuMilestones, milestones, moveToMilestone, recover],
  )

  const onDelete = useCallback(
    (key: string) => {
      const summary = byKey.get(key)
      if (summary) {
        menuFor(summary).onDelete?.()
      }
    },
    [byKey, menuFor],
  )

  // Every blocker of every task in the tree, as the arrows the timeline draws between their bars.
  const links = useMemo<TimelineLink[]>(
    () => (lists?.tree ?? []).flatMap((task) => task.blockers.map((blocker) => ({ from: blocker.key, to: task.key }))),
    [lists?.tree],
  )

  const onLink = useCallback(
    (link: TimelineLink) => {
      // A refusal (a loop) is worth reading, so it shows above the timeline like a refused move.
      api
        .task_link({ type: 'blocks', from: link.from, to: link.to })
        .catch((error) => setChangeError(errorMessage(error)))
    },
    [api],
  )

  const onLinkClick = useCallback(
    (link: TimelineLink) =>
      confirm({
        title: `Remove the link from ${link.from} to ${link.to}?`,
        description: `${link.to} will no longer wait for ${link.from}.`,
        action: 'Remove link',
        onConfirm: () => api.task_unlink({ type: 'blocks', from: link.from, to: link.to }),
      }),
    [api, confirm],
  )

  const linkMenu = useCallback(
    (link: TimelineLink): ItemMenuEntries => [
      {
        id: 'open-blocker',
        label: `Open ${link.from}`,
        icon: ExternalLink,
        group: 'open',
        onSelect: () => openTask(link.from),
      },
      {
        id: 'open-blocked',
        label: `Open ${link.to}`,
        icon: ExternalLink,
        group: 'open',
        onSelect: () => openTask(link.to),
      },
      { id: 'remove', label: 'Remove link…', icon: Unlink, destructive: true, onSelect: () => onLinkClick(link) },
    ],
    [onLinkClick],
  )

  // A task made from the empty scale goes into the milestone shown on the dates drawn, and opens with its summary ready to type over.
  const onCreateOn = useCallback(
    (startDate: string, endDate: string) => {
      const milestone = lists?.milestoneId
      api
        .task_create({ summary: 'New task', startDate, endDate, ...(milestone == null ? {} : { milestone }) })
        .then(({ result }) => {
          openTask(result.key)
          const here = currentLocation()
          const query = new URLSearchParams(here.query)
          query.set('edit', 'summary')
          navigate(hrefFor(here.segments, query), { replace: true })
        })
        .catch(fail)
    },
    [api, fail, lists?.milestoneId],
  )

  const { showCreated } = shown
  const createMilestone = useCallback(
    async (input: TaskMilestoneInput) => {
      try {
        const { result } = await api.milestone_create({ ...input, description: input.description ?? '' })
        showCreated(result.name)
      } catch (error) {
        // The form shows the server's own words.
        throw new Error(errorMessage(error))
      }
    },
    [api, showCreated],
  )
  const openCreateMilestone = useCallback(() => setCreatingMilestone(true), [])

  const controls = (
    <TimelineMilestonePicker
      milestones={openKitMilestones}
      activeId={listed ? String(listed.id) : null}
      onSelect={(id) => {
        const picked = openKitMilestones.find((m) => m.id === id)
        if (picked) {
          shown.select(picked.name)
        }
      }}
      onCreate={openCreateMilestone}
    />
  )

  // The root is there from the first render, so its width is measured before the tasks arrive.
  return (
    <div ref={rootRef} className='flex min-h-0 flex-1 flex-col'>
      {lists === null ? (
        loadError ? (
          <TaskManagerError title="Couldn't load the timeline" message={loadError} onRetry={reload} />
        ) : (
          <TaskManagerSkeleton page='timeline' />
        )
      ) : (
        <>
          {changeError ? (
            <TaskManagerError
              variant='inline'
              title="Couldn't save that change"
              message={changeError}
              onDismiss={() => setChangeError(null)}
              className='m-2'
            />
          ) : null}
          <TimelineView
            className='min-h-0 flex-1'
            tasks={treeTasks}
            backlog={backlogTasks}
            milestone={timelineMilestone}
            controls={controls}
            placeholder={
              listed ? undefined : <TaskManagerEmpty kind='no-milestone' onCreateMilestone={openCreateMilestone} />
            }
            onCreate={onCreate}
            onChange={onChange}
            onOpen={openTask}
            onDelete={onDelete}
            menuFor={menuForTask}
            selectedKey={selectedKey}
            onSelectedKeyChange={select}
            links={links}
            versions={versionMarkers}
            onLink={onLink}
            onLinkClick={onLinkClick}
            linkMenu={linkMenu}
            onCreateOn={onCreateOn}
            compact={compact}
            storageKey={`tasks:${projectKey}:timeline`}
            emptyBacklog={<TaskManagerEmpty kind='backlog' />}
          />
        </>
      )}
      <Dialog open={creatingMilestone} onOpenChange={setCreatingMilestone}>
        <DialogContent className='sm:max-w-md'>
          {creatingMilestone ? (
            <TaskMilestoneEditor
              milestone={null}
              milestones={kitMilestones}
              onSubmit={createMilestone}
              onClose={() => setCreatingMilestone(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
