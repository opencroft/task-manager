// Seam owned by dependencies. The server entry spreads `dependencyActions`
// into the `tasks` App's actions; input schemas and descriptions live in
// extension.json.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import type { DependencyActionId, TaskLinkInput } from '../../shared/dependencies.ts'
import { scopeFor } from '../actions.ts'
import { getTask } from '../service.ts'
import { linkTasks, unlinkTasks } from './store.ts'

const handlers: Record<DependencyActionId, (ctx: AppActionContext, input: TaskLinkInput) => unknown> = {
  task_link: (ctx, input) => {
    const scope = scopeFor(ctx)
    linkTasks(scope, input)
    return { result: getTask(scope, input.to) }
  },
  task_unlink: (ctx, input) => {
    const scope = scopeFor(ctx)
    unlinkTasks(scope, input)
    return { result: getTask(scope, input.to) }
  },
}

export const dependencyActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [
    id,
    (ctx: AppActionContext, params: Record<string, unknown>) => handler(ctx, (params ?? {}) as unknown as TaskLinkInput),
  ]),
)
