// The filter menus a task list offers (the Tasks page, the Board, a board's
// preset filter), each built one way from the project's own values.

import type { TaskFilterDef } from '@/components/ui/tasks/task-filter-bar'
import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskLabelChip } from '@/components/ui/tasks/task-label-chip'
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, TaskPriorityIcon } from '@/components/ui/tasks/task-priority-icon'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { TASK_TYPES, TASK_TYPE_LABELS, TaskTypeIcon } from '@/components/ui/tasks/task-type-icon'

import type { AssigneeOption, Status, TaskParent } from '../../shared/types'
import type { Version } from '../../shared/versions'
import { versionFilter } from './versions'

export type TaskFilterId = 'status' | 'assignee' | 'type' | 'priority' | 'label' | 'version' | 'parent'

/** What the menus list: the project's statuses, people and agents, labels, versions and parent tasks. */
export interface TaskFilterSources {
  statuses: readonly Status[]
  assignees: readonly AssigneeOption[]
  labels: readonly string[]
  versions: readonly Version[]
  parents?: readonly TaskParent[]
}

function filterDef(id: TaskFilterId, sources: TaskFilterSources): TaskFilterDef {
  switch (id) {
    case 'status':
      return {
        id,
        label: 'Status',
        options: sources.statuses.map((status) => ({
          value: String(status.id),
          label: status.name,
          icon: <TaskStatusBadge name={status.name} category={status.category} color={status.color} size="sm" />,
        })),
      }
    case 'assignee':
      return {
        id,
        label: 'Assignee',
        options: [
          { value: 'none', label: 'Unassigned', icon: <TaskAssignee assignee={null} withName size="sm" /> },
          ...sources.assignees.map((option) => ({
            value: option.assignee.name,
            label: option.assignee.name,
            icon: <TaskAssignee assignee={option.assignee} withName size="sm" />,
          })),
        ],
      }
    case 'type':
      return {
        id,
        label: 'Type',
        options: TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type], icon: <TaskTypeIcon type={type} withLabel /> })),
      }
    case 'priority':
      return {
        id,
        label: 'Priority',
        options: TASK_PRIORITIES.map((priority) => ({
          value: priority,
          label: TASK_PRIORITY_LABELS[priority],
          icon: <TaskPriorityIcon priority={priority} withLabel />,
        })),
      }
    case 'label':
      return {
        id,
        label: 'Label',
        options: sources.labels.map((label) => ({ value: label, label, icon: <TaskLabelChip name={label} variant="outline" /> })),
        emptyText: 'No labels used yet',
      }
    case 'version':
      return versionFilter(sources.versions)
    case 'parent':
      return {
        id,
        label: 'Parent',
        options: [
          { value: 'none', label: 'Top-level only' },
          ...(sources.parents ?? []).map((task) => ({ value: task.key, label: `${task.key} ${task.summary}` })),
        ],
      }
  }
}

/** The menus for `ids`, in that order. */
export function taskFilterDefs(ids: readonly TaskFilterId[], sources: TaskFilterSources): TaskFilterDef[] {
  return ids.map((id) => filterDef(id, sources))
}
