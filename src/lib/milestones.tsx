// The project's milestones in the shapes the kit's components take. The
// server numbers milestones; the kit keys them by string. A task write passes
// the id back as a number, which the server reads as the id whatever the
// names are. Filters and saved views name milestones, as task_list does.

import type { TaskFilterDef } from '@/components/ui/tasks/task-filter-bar'
import { milestoneSpanText, type TaskMilestone, TaskMilestoneChip } from '@/components/ui/tasks/task-milestone-chip'
import type { Milestone } from '../../shared/milestones'

export function toTaskMilestone(milestone: Milestone): TaskMilestone {
  return { ...milestone, id: String(milestone.id) }
}

/** The Milestone filter of Tasks: "No milestone", then every milestone in the listing order, archived ones last. */
export function milestoneFilter(milestones: readonly Milestone[]): TaskFilterDef {
  return {
    id: 'milestone',
    label: 'Milestone',
    searchable: true,
    options: [
      { value: 'none', label: 'No milestone' },
      ...milestones.map((milestone) => ({
        value: milestone.name,
        label: [milestone.name, milestoneSpanText(milestone)].filter(Boolean).join(' · '),
        icon: <TaskMilestoneChip name={milestone.name} state={milestone.state} variant='outline' />,
      })),
    ],
    emptyText: 'No milestones yet',
  }
}
