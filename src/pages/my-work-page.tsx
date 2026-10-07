// "My work", the page the App opens on: what needs the signed-in person now,
// in this project or in all of them, from the `my_work` action an agent calls
// for the same answer. The kit's `my-work-view` renders it; this file feeds it
// and keeps it fresh.

import { legacy } from '@opencroft/client'
import { ExternalLink, Link2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type MyWorkScope, type MyWorkStep, type MyWorkTask, MyWorkView } from '@/components/ui/tasks/my-work-view'

import type { MyWorkResult } from '../../shared/my-work'
import type { TaskSummary } from '../../shared/types'
import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { isElsewhere, openTaskIn, taskHrefIn } from '../app/task-opener'
import { inboxRowMenu, openInbox, useInboxLive } from '../inbox/project-inbox'
import { assigneeInput } from '../lib/assignees'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { absoluteLink } from '../lib/router'

type Viewer = MyWorkResult['viewer']

/** Today on the person's own calendar, which "Starting soon" counts from. */
function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Who the page is about is known from the first answer; the last one is kept
// so the header names the person at once on the next open.
function readViewer(storageKey: string): Viewer | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Viewer | null
    return saved && typeof saved.name === 'string' && (saved.kind === 'person' || saved.kind === 'agent') ? saved : null
  } catch {
    return null
  }
}

// The scope is the person's, not the project's: the same in every App.
const SCOPE_KEY = 'task-pipelines:my-work-scope'

function readScope(): MyWorkScope {
  return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'this'
}

// Across projects a change anywhere refreshes the page, so a busy moment elsewhere costs one read, not one per change.
const ALL_PROJECTS_REFRESH_MS = 2000

export function MyWorkPage() {
  const { instanceId, api, statuses, menuFor } = useProject()
  const viewerKey = `task-pipelines:${instanceId}:my-work-viewer`
  const [scope, setScope] = useState<MyWorkScope>(readScope)
  const [data, setData] = useState<MyWorkResult | null>(null)
  const [viewer, setViewer] = useState<Viewer | null>(() => readViewer(viewerKey))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Answers to an older refresh are dropped once a newer one was asked.
  const request = useRef(0)
  const { selectedKey } = usePageShortcuts()

  const changeScope = useCallback((next: MyWorkScope) => {
    localStorage.setItem(SCOPE_KEY, next)
    setScope(next)
  }, [])

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const next = await api.my_work({ today: localToday(), scope })
      if (id === request.current) {
        setData(next)
        setViewer(next.viewer)
        setError(null)
        localStorage.setItem(viewerKey, JSON.stringify(next.viewer))
      }
    } catch (failure) {
      if (id === request.current) {
        setError(errorMessage(failure))
      }
    } finally {
      if (id === request.current) {
        setLoading(false)
      }
    }
  }, [api, viewerKey, scope])

  useEffect(() => {
    void load()
  }, [load])

  // Task changes move tasks in and out of the sections; inbox changes carry the steps and the recent list.
  // Across projects, those of every project do.
  const watched = scope === 'all' ? null : instanceId
  const refreshMs = scope === 'all' ? ALL_PROJECTS_REFRESH_MS : 300
  useTasksLive(watched, () => void load(), refreshMs)
  useInboxLive(watched, () => void load(), refreshMs)

  const statusOrder = useMemo(() => [...statuses].sort((a, b) => a.position - b.position).map((s) => s.name), [statuses])

  const create = useCallback(
    async (summary: string) => {
      if (!viewer) {
        return
      }
      await api.task_create({ summary, assignee: assigneeInput(viewer) })
      await load()
    },
    [api, load, viewer],
  )

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col p-3 sm:p-4">
      <MyWorkView
        viewer={viewer ?? { kind: 'person', name: 'You' }}
        data={data}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onOpen={openTaskIn}
        scope={scope}
        onScopeChange={changeScope}
        selectedKey={selectedKey}
        // The sections list `task_list` rows as they are. The task menu acts on this project, so another's rows have none.
        menuFor={(task: MyWorkTask) => (isElsewhere(task.project) ? undefined : menuFor(task as TaskSummary))}
        onCreate={viewer ? create : undefined}
        statusOrder={statusOrder}
        stepMenu={(step: MyWorkStep) => [
          { id: 'open', label: 'Open task', icon: ExternalLink, group: 'open', onSelect: () => openTaskIn(step.task.key, step.project) },
          step.sessionHref && {
            id: 'thread',
            label: 'Open the thread',
            icon: ExternalLink,
            group: 'open',
            onSelect: () => window.open(step.sessionHref as string, '_blank', 'noopener'),
          },
          {
            id: 'copy-link',
            label: 'Copy link',
            icon: Link2,
            group: 'open',
            onSelect: () =>
              void navigator.clipboard
                .writeText(absoluteLink(taskHrefIn(step.task.key, step.project)))
                .then(() => legacy.toast.success(`Copied link to ${step.task.key}`))
                .catch(() => legacy.toast.error('Copying is not allowed here')),
          },
        ]}
        // Read, unread and mute go to the inbox of the App the change is in; the host takes its address as well as its id.
        recentMenu={(n) => inboxRowMenu((isElsewhere(n.project) && n.project?.app) || instanceId, n, (key) => openTaskIn(key, n.project))}
        onShowInbox={() => openInbox(instanceId)}
      />
    </div>
  )
}
