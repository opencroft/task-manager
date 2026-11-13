// Seam owned by milestones. The server entry spreads `milestoneActions` into
// the `tasks` App's actions: list, create, edit (which archives and
// restores) and delete.

import type { MilestoneActionId } from '../../shared/milestones.ts'
import { scopedActions } from '../actions.ts'
import { createMilestone, deleteMilestone, listMilestones, updateMilestone } from './store.ts'

export const milestoneActions = scopedActions<MilestoneActionId>({
  milestone_list: (s, input) => listMilestones(s, input),
  milestone_create: (s, input) => createMilestone(s, input),
  milestone_update: (s, input) => updateMilestone(s, input),
  milestone_delete: (s, input) => deleteMilestone(s, input),
})
