// A task's own page: its details, with the page's loading, error and
// not-found states, and the keys a task's page offers (E edits the summary; a
// task created from here is a subtask of this one).

import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'

import { useProject } from '../app/project'
import { usePageShortcuts } from '../app/shortcuts'
import { hrefFor, useQueryParam } from '../lib/router'
import { TaskDetails } from './task-details'
import { useTaskCandidates, useTaskDetails } from './use-task-details'

export function TaskPage({ taskKey }: { taskKey: string }) {
  const { api } = useProject()
  const { task, missing, loadError, load, retry, update } = useTaskDetails(taskKey)
  const candidates = useTaskCandidates()
  const [, setEdit] = useQueryParam('edit')

  usePageShortcuts({
    onEditSummary: () => setEdit('summary'),
    createTask: async (summary) => (await api.task_create({ summary, parent: taskKey })).result.key,
  })

  if (missing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="font-medium">{missing}</p>
        <p className="text-sm text-muted-foreground">It may have been deleted, or the link is mistyped.</p>
        <a href={hrefFor(['tasks'])} className="text-sm text-primary hover:underline">
          Back to all tasks
        </a>
      </div>
    )
  }

  if (!task) {
    return loadError ? <TaskManagerError title={`Couldn't load ${taskKey}`} message={loadError} onRetry={retry} /> : <TaskManagerSkeleton page="details" />
  }

  return <TaskDetails task={task} load={load} update={update} candidates={candidates} />
}
