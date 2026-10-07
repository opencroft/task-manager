// What every page of one project shares: the typed API, the project's
// statuses, assignees, labels with their colours and versions (kept fresh by live events), a toast for
// failures, a confirm dialog, and the task menu every task surface offers.

import { legacy } from '@opencroft/client'
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { TaskAvatarsProvider } from '@/components/ui/tasks/task-assignee'
import { TaskLabelColorsProvider } from '@/components/ui/tasks/task-label-chip'
import type { TaskMenuProps } from '@/components/ui/tasks/task-menu'

import type { LabelColor, ProjectLabel } from '../../shared/settings'
import type { AssigneeOption, PersonAvatar, Priority, Status, TaskSummary } from '../../shared/types'
import type { Version } from '../../shared/versions'
import { type TasksApi, errorMessage, tasksApi } from '../lib/api'
import { assigneeInput } from '../lib/assignees'
import { useTasksLive } from '../lib/live'
import { absoluteLink, currentLocation, hrefFor, navigate } from '../lib/router'
import { closePeek, openTask, taskHref } from './task-opener'

export interface ConfirmRequest {
  title: string
  description: ReactNode
  action: string
  destructive?: boolean
  onConfirm: () => Promise<unknown> | unknown
}

export interface ProjectContextValue {
  instanceId: string
  projectKey: string
  api: TasksApi
  statuses: Status[]
  assignees: AssigneeOption[]
  /** The names of the labels in use. */
  labels: string[]
  /** The same labels with their colours and task counts. */
  projectLabels: ProjectLabel[]
  /** False until the labels have loaded once: `projectLabels` is empty then for want of an answer, not of labels. */
  labelsLoaded: boolean
  /** Every version of the project, archived ones too, with their task counts. */
  versions: Version[]
  /** Report a failed action to the person. */
  fail: (error: unknown) => void
  confirm: (request: ConfirmRequest) => void
  /** The task menu for one task, wired to the actions. */
  menuFor: (task: MenuTask, extra?: Partial<TaskMenuProps>) => TaskMenuProps
}

/** What the task menu needs to know about a task. */
export type MenuTask = Pick<TaskSummary, 'key' | 'priority' | 'assignee' | 'childCount' | 'parentKey'> & {
  status: Pick<Status, 'id'>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext)
  if (!value) {
    throw new Error('useProject outside ProjectProvider')
  }
  return value
}

/** A state update that keeps the previous value when the next one is equal to it. */
function unlessUnchanged<T>(next: T): (previous: T) => T {
  return (previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
}

/** Puts `text` on the clipboard and confirms with "Copied <what>". */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    legacy.toast.success(`Copied ${what}`)
  } catch {
    legacy.toast.error('Copying is not allowed here')
  }
}

export function ProjectProvider({ instanceId, projectKey, children }: { instanceId: string; projectKey: string; children: ReactNode }) {
  const api = useMemo(() => tasksApi(instanceId), [instanceId])
  const [statuses, setStatuses] = useState<Status[]>([])
  const [assignees, setAssignees] = useState<AssigneeOption[]>([])
  const [projectLabels, setProjectLabels] = useState<ProjectLabel[]>([])
  const [labelsLoaded, setLabelsLoaded] = useState(false)
  const [versions, setVersions] = useState<Version[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null)
  const [confirming, setConfirming] = useState(false)

  const fail = useCallback((error: unknown) => {
    legacy.toast.error(errorMessage(error))
  }, [])

  const loadMeta = useCallback(async () => {
    try {
      const [nextStatuses, nextAssignees, nextLabels, nextVersions] = await Promise.all([
        api.status_list({}),
        api.assignee_list({}),
        api.label_overview({}),
        api.version_list({}),
      ])
      // An unchanged list keeps its identity, so `menuFor` and every memoised row and card built on it stay put.
      setStatuses(unlessUnchanged(nextStatuses))
      setAssignees(unlessUnchanged(nextAssignees))
      setProjectLabels(unlessUnchanged(nextLabels.labels))
      setLabelsLoaded(true)
      setVersions(unlessUnchanged(nextVersions.versions))
    } catch (error) {
      fail(error)
    }
  }, [api, fail])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  // Pictures are loaded once per opening, not with the meta above: they are often inline images, and a task change never changes one.
  const [avatars, setAvatars] = useState<PersonAvatar[]>([])
  useEffect(() => {
    api.avatar_list({}).then(setAvatars, fail)
  }, [api, fail])

  // Statuses change rarely; assignees and labels grow with task edits.
  useTasksLive(instanceId, () => void loadMeta(), 400)

  const confirm = useCallback((request: ConfirmRequest) => setPendingConfirm(request), [])

  const menuFor = useCallback(
    (task: MenuTask, extra: Partial<TaskMenuProps> = {}): TaskMenuProps => ({
      statusId: task.status.id,
      priority: task.priority,
      assigneeName: task.assignee?.name ?? null,
      statuses,
      assignees: assignees.map((option) => ({ kind: option.assignee.kind, name: option.assignee.name, id: option.assignee.id })),
      onOpen: () => openTask(task.key),
      onCopyKey: () => void copyText(task.key, task.key),
      onCopyLink: () => void copyText(absoluteLink(taskHref(task.key)), `link to ${task.key}`),
      onStatusChange: (statusId) => void api.task_change_status({ key: task.key, status: statusId }).catch(fail),
      onPriorityChange: (priority: Priority) => void api.task_update({ key: task.key, priority }).catch(fail),
      onAssigneeChange: (assignee) => void api.task_update({ key: task.key, assignee: assigneeInput(assignee) }).catch(fail),
      onAddSubtask: () => navigate(hrefFor(['task', task.key], { add: 'subtask' })),
      onDelete: () =>
        setPendingConfirm({
          title: `Delete ${task.key}?`,
          description: task.childCount
            ? `This deletes ${task.key} and all ${task.childCount > 1 ? 'its subtasks' : 'its subtask'} below it, with their comments and history. It cannot be undone.`
            : `This deletes ${task.key} with its comments and history. It cannot be undone.`,
          action: task.childCount ? 'Delete with subtasks' : 'Delete',
          destructive: true,
          onConfirm: async () => {
            await api.task_delete({ key: task.key, withSubtasks: Boolean(task.childCount) })
            legacy.toast.success(`Deleted ${task.key}`)
            const [page, key] = currentLocation().segments
            if (page === 'task' && key?.toUpperCase() === task.key) {
              navigate(task.parentKey ? taskHref(task.parentKey) : hrefFor(['tasks']), { replace: true })
            }
            closePeek(task.key)
          },
        }),
      ...extra,
    }),
    [api, assignees, fail, statuses],
  )

  const labels = useMemo(() => projectLabels.map((label) => label.name), [projectLabels])
  const labelColors = useMemo(
    () => Object.fromEntries(projectLabels.flatMap((label) => (label.color ? [[label.name, label.color]] : []))) as Record<string, LabelColor>,
    [projectLabels],
  )

  const value = useMemo<ProjectContextValue>(
    () => ({ instanceId, projectKey, api, statuses, assignees, labels, projectLabels, labelsLoaded, versions, fail, confirm, menuFor }),
    [instanceId, projectKey, api, statuses, assignees, labels, projectLabels, labelsLoaded, versions, fail, confirm, menuFor],
  )

  return (
    <ProjectContext.Provider value={value}>
      {/* Every label chip in the App reads its colour from here, and every avatar its picture. */}
      <TaskLabelColorsProvider value={labelColors}>
        <TaskAvatarsProvider value={avatars}>{children}</TaskAvatarsProvider>
      </TaskLabelColorsProvider>
      <AlertDialog open={pendingConfirm !== null} onOpenChange={(open) => !open && !confirming && setPendingConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingConfirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pendingConfirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingConfirm?.destructive ? 'destructive' : 'default'}
              disabled={confirming}
              onClick={async () => {
                if (!pendingConfirm) {
                  return
                }
                setConfirming(true)
                try {
                  await pendingConfirm.onConfirm()
                  setPendingConfirm(null)
                } catch (error) {
                  fail(error)
                } finally {
                  setConfirming(false)
                }
              }}
            >
              {pendingConfirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProjectContext.Provider>
  )
}
