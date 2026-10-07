// The peek: a task's details beside the list it was opened from. It stays
// mounted while J and K move it from task to task, so the project's tasks for
// the Dependencies picker are fetched once per opening, not per task.

import { TaskActionsMenu } from '@/components/ui/tasks/task-menu'
import { TaskPeekPanel } from '@/components/ui/tasks/task-peek-panel'

import { copyText, useProject } from '../app/project'
import { useTaskSelection } from '../app/shortcuts'
import { closePeek, taskHref } from '../app/task-opener'
import { useQueryParam } from '../lib/router'
import { TaskDetails } from './task-details'
import { useTaskCandidates, useTaskDetails } from './use-task-details'

export function TaskPeek({ taskKey }: { taskKey: string }) {
  const { menuFor } = useProject()
  const { move } = useTaskSelection()
  const { task, missing, loadError, load, retry, update } = useTaskDetails(taskKey)
  const candidates = useTaskCandidates()
  const [, setAdd] = useQueryParam('add')

  return (
    <TaskPeekPanel
      taskKey={taskKey}
      type={task?.type}
      href={taskHref(taskKey)}
      onClose={() => closePeek()}
      onCopyKey={() => void copyText(taskKey, taskKey)}
      onPrevious={() => move(-1)}
      onNext={() => move(1)}
      actions={task ? <TaskActionsMenu {...menuFor(task)} onOpen={undefined} onAddSubtask={() => setAdd('subtask')} /> : null}
      loading={!task && !missing && !loadError}
      error={loadError}
      onRetry={retry}
    >
      {missing ? (
        <div className="flex flex-col gap-1 p-6 text-sm">
          <p className="font-medium">{missing}</p>
          <p className="text-muted-foreground">It may have been deleted.</p>
        </div>
      ) : task ? (
        // Keyed, so what belongs to one task (a draft, its attachments, the open tab) does not carry over to the next.
        <TaskDetails key={task.key} task={task} load={load} update={update} candidates={candidates} inPeek />
      ) : null}
    </TaskPeekPanel>
  )
}
