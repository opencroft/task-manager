// Seam owned by answers across projects: `task_list` and `my_work` take
// `scope: "all"` and then read every task-manager App the caller can see, in
// this one request. The server entry wraps its actions with
// `withProjectScope`; `scope: "this"` (the default) leaves them as they are.

import { type AppActionContext, type AppActionHandler, apps, type HostAppInstance } from '@opencroft/server/apps'

import type { ActionInputs } from '../../shared/action-inputs.ts'
import { REFERENCE_ACTIONS } from '../../shared/references.ts'
import { parseParams } from '../action-params.ts'
import { scopeFor } from '../actions.ts'
import { viewerOf } from '../my-work/index.ts'
import { mergeMyWork, myWork } from '../my-work/store.ts'
import { referenceProjects, resolveReferences } from '../references.ts'
import { listTasks, summariesWhere } from '../service.ts'
import { acrossProjects, type ProjectInstance, scoped } from './across.ts'
import { acrossListInput, mergeTaskLists } from './task-list.ts'

/**
 * The task-manager Apps the caller can see, oldest first: the one place they
 * are chosen. The host lets any signed-in person and any agent open every App
 * — it has no access rule per space or per App (measured 26.09.2026) — so
 * reading every instance shows nothing the caller could not open one by one.
 * When the host gains such a rule, the filter goes here, asked of the host
 * for this caller, and nowhere else.
 */
async function visibleProjects(_ctx?: AppActionContext): Promise<ProjectInstance[]> {
  // Each listed instance carries its name and slug as well.
  return (await apps.listInstances('tasks')) as Array<HostAppInstance & Pick<ProjectInstance, 'name' | 'slug'>>
}

/**
 * The caller's call, moved to another instance. Its database is read through
 * the same per-instance handle that instance's own actions use (`scopeFor`),
 * never a second connection to the file.
 */
function contextIn(ctx: AppActionContext, instance: ProjectInstance): AppActionContext {
  const { instanceId, spaceSlug, name, slug, params, dataDir } = instance
  return { ...ctx, instanceId, spaceSlug, name, slug, params, dataDir }
}

async function taskListAcross(ctx: AppActionContext, input: ActionInputs['task_list']) {
  const { perProject, limit } = acrossListInput(input)
  const across = await acrossProjects(await visibleProjects(ctx), (instance) =>
    listTasks(scopeFor(contextIn(ctx, instance)), perProject),
  )
  return { ...mergeTaskLists(input.query, limit, across.parts), projects: across.projects }
}

async function myWorkAcross(ctx: AppActionContext, input: ActionInputs['my_work']) {
  const viewer = await viewerOf(scopeFor(ctx))
  const across = await acrossProjects(await visibleProjects(ctx), (instance) =>
    myWork(scopeFor(contextIn(ctx, instance)), viewer, input),
  )
  return { ...mergeMyWork(viewer, input, across.parts), projects: across.projects }
}

/**
 * The extension-level actions behind task keys in markdown. They are called
 * with no App and no caller -- the host's `invoke` carries neither -- which
 * reads the same set `visibleProjects` does for anyone today. When the host
 * gains an access rule per App, these need the caller it will then carry.
 */
export const referenceActions = {
  [REFERENCE_ACTIONS.projects]: async () => referenceProjects(await visibleProjects()),
  [REFERENCE_ACTIONS.resolve]: async (keys: unknown) =>
    resolveReferences(await visibleProjects(), keys, (instance, numbers) =>
      summariesWhere(
        scopeFor(instance as unknown as AppActionContext),
        `t.number IN (${numbers.map(() => '?').join(',')})`,
        numbers,
        't.number',
      ),
    ),
}

/** The actions, with `task_list` and `my_work` taking `scope`. */
export function withProjectScope(actions: Record<string, AppActionHandler>): Record<string, AppActionHandler> {
  const own = (id: string): AppActionHandler => {
    const handler = actions[id]
    if (!handler) {
      throw new Error(`There is no ${id} action to answer across projects`)
    }
    return handler
  }
  return {
    ...actions,
    task_list: scoped(own('task_list'), (ctx, params) => taskListAcross(ctx, parseParams('task_list', params))),
    my_work: scoped(own('my_work'), (ctx, params) => myWorkAcross(ctx, parseParams('my_work', params))),
  }
}
