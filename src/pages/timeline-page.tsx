// The Timeline page: the project's tasks as a tree beside a zoomable time
// scale, with the backlog of unscheduled tasks below. The surface is the kit's
// TimelineView; this page feeds it tasks, turns what it reports into task
// actions, and refreshes on every change — this tab's, another tab's or an
// agent's.

import { AppToolbar } from '@opencroft/client'
import { ExternalLink, Unlink } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { TaskManagerToolbar } from '@/components/ui/navigation/task-manager-toolbar'
import { TaskManagerEmpty } from '@/components/ui/states/task-manager-empty'
import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import type { TimelineChange } from '@/components/ui/timeline/timeline-drop'
import type { TimelineLink } from '@/components/ui/timeline/timeline-links-model'
import type { TimelineTask } from '@/components/ui/timeline/timeline-model'
import type { TimelineVersionMarker } from '@/components/ui/timeline/timeline-version-markers'
import { TimelineView } from '@/components/ui/timeline/timeline-view'

import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { openTask } from '../app/task-opener'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { usePhoneWidth } from '../lib/phone-width'
import { currentLocation, hrefFor, navigate } from '../lib/router'
import { listAllTasks } from '../lib/task-list'

/** A task as the timeline draws it. */
function toTimelineTask(task: TaskSummary): TimelineTask {
  return {
    key: task.key,
    summary: task.summary,
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
  const { api, instanceId, projectKey, versions, fail, menuFor, confirm } = useProject()
  // A marker for each planned version at its target date and each released one at its release date; archived ones are not drawn.
  const versionMarkers = useMemo<TimelineVersionMarker[]>(
    () =>
      versions.flatMap((version) => {
        const date = version.state === 'planned' ? version.targetDate : version.state === 'released' ? version.releasedAt : null
        return date && version.state !== 'archived' ? [{ id: String(version.id), name: version.name, date, state: version.state }] : []
      }),
    [versions],
  )
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [changeError, setChangeError] = useState<string | null>(null)
  const requestId = useRef(0)
  const loaded = useRef(false)
  const { selectedKey, select } = usePageShortcuts()
  const rootRef = useRef<HTMLDivElement>(null)
  // At phone width the timeline shows one pane at a time and a tap opens a task.
  const compact = usePhoneWidth(rootRef)

  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const result = await listAllTasks(api)
      if (id === requestId.current) {
        loaded.current = true
        setTasks(result)
        setLoadError(null)
      }
    } catch (error) {
      if (id !== requestId.current) {
        return
      }
      // Before the first load the page has nothing to show but the error;
      // after it, a failed refresh keeps what is on screen.
      if (loaded.current) {
        fail(error)
      } else {
        setLoadError(errorMessage(error))
      }
    }
  }, [api, fail])

  useEffect(() => {
    void load()
  }, [load])
  useTasksLive(instanceId, () => void load())

  const byKey = useMemo(() => new Map((tasks ?? []).map((task) => [task.key, task])), [tasks])
  const timelineTasks = useMemo(() => (tasks ?? []).map(toTimelineTask), [tasks])

  // A refused change is shown above the timeline, and the page reloads, which
  // puts back whatever the server holds.
  const recover = useCallback(
    (error: unknown) => {
      setChangeError(errorMessage(error))
      void load()
    },
    [load],
  )

  const onChange = useCallback(
    (change: TimelineChange) => {
      // Dates show at once; the live refresh then confirms them. A move waits
      // for the server, since only the server computes rank.
      setTasks((current) => current?.map((task) => (task.key === change.key ? withChange(task, change) : task)) ?? current)
      const request =
        change.type === 'schedule'
          ? api.task_update({ key: change.key, startDate: change.start, endDate: change.end })
          : change.type === 'unschedule'
            ? api.task_update({ key: change.key, startDate: null, endDate: null })
            : api.task_move({ key: change.key, ...change.placement })
      request.catch(recover)
    },
    [api, recover],
  )

  // A refusal rejects: the create row shows why and keeps what was typed.
  const onCreate = useCallback(
    async ({ summary, parent }: { summary: string; parent: string | null }) => {
      await api.task_create({ summary, parent })
    },
    [api],
  )

  const menuForTask = useCallback(
    (task: TimelineTask) => {
      const summary = byKey.get(task.key)
      return summary ? menuFor(summary) : {}
    },
    [byKey, menuFor],
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

  // Every blocker of every task, as the arrows the timeline draws.
  const links = useMemo<TimelineLink[]>(
    () => (tasks ?? []).flatMap((task) => task.blockers.map((blocker) => ({ from: blocker.key, to: task.key }))),
    [tasks],
  )

  const onLink = useCallback(
    (link: TimelineLink) => {
      // A refusal (a loop) is worth reading, so it shows above the timeline like a refused move.
      api.task_link({ type: 'blocks', from: link.from, to: link.to }).catch((error) => setChangeError(errorMessage(error)))
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
      { id: 'open-blocker', label: `Open ${link.from}`, icon: ExternalLink, group: 'open', onSelect: () => openTask(link.from) },
      { id: 'open-blocked', label: `Open ${link.to}`, icon: ExternalLink, group: 'open', onSelect: () => openTask(link.to) },
      { id: 'remove', label: 'Remove link…', icon: Unlink, destructive: true, onSelect: () => onLinkClick(link) },
    ],
    [onLinkClick],
  )

  // A task made from the empty scale opens with its summary ready to type over.
  const onCreateOn = useCallback(
    (startDate: string, endDate: string) => {
      api
        .task_create({ summary: 'New task', startDate, endDate })
        .then(({ result }) => {
          openTask(result.key)
          const here = currentLocation()
          const query = new URLSearchParams(here.query)
          query.set('edit', 'summary')
          navigate(hrefFor(here.segments, query), { replace: true })
        })
        .catch(fail)
    },
    [api, fail],
  )

  // The root is there from the first render, so its width is measured before the tasks arrive.
  return (
    <div ref={rootRef} className='flex min-h-0 flex-1 flex-col'>
      {tasks === null ? (
        loadError ? (
          <TaskManagerError
            title="Couldn't load the timeline"
            message={loadError}
            onRetry={() => {
              setLoadError(null)
              void load()
            }}
          />
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
            tasks={timelineTasks}
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
            emptyScale={<TaskManagerEmpty kind='timeline-unscheduled' />}
            emptyBacklog={<TaskManagerEmpty kind='backlog' />}
            // The zoom controls sit in the host's toolbar, not over the scale.
            renderToolbar={(tools) => (
              <AppToolbar>
                <TaskManagerToolbar label='Timeline controls'>{tools}</TaskManagerToolbar>
              </AppToolbar>
            )}
          />
        </>
      )}
    </div>
  )
}
