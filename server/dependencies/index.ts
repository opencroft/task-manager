// Seam owned by dependencies. The server entry spreads `dependencyActions`
// into the `tasks` App's actions; input schemas and descriptions live in
// extension.json.

import type { DependencyActionId } from '../../shared/dependencies.ts'
import { scopedActions } from '../actions.ts'
import { getTask } from '../service.ts'
import { linkTasks, unlinkTasks } from './store.ts'

export const dependencyActions = scopedActions<DependencyActionId>({
  task_link: (scope, input) => {
    linkTasks(scope, input)
    return { result: getTask(scope, input.to) }
  },
  task_unlink: (scope, input) => {
    unlinkTasks(scope, input)
    return { result: getTask(scope, input.to) }
  },
})
