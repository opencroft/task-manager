// Seam owned by "My work". The server entry spreads `myWorkActions` into the
// `tasks` App's actions; the input schema and description live in extension.json.

import type { MyWorkActionId } from '../../shared/my-work.ts'
import { scopedActions } from '../actions.ts'
import { type Scope, TaskError } from '../service.ts'
import { myWork, type Viewer } from './store.ts'

/** The caller, as the host bound it: the agent for `app_call`, the signed-in person for the App's own UI. */
export async function viewerOf(scope: Scope): Promise<Viewer> {
  const { ctx } = scope.inv
  if (ctx.callerAgent) {
    const name = ctx.callerAgent
    // Two agents with one name cannot be told apart by it: neither id is taken, as the inbox does.
    const matches = (await scope.agents()).filter((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase())
    return { kind: 'agent', id: matches.length === 1 ? matches[0].id : null, name }
  }
  if (ctx.callerPerson?.id) {
    return { kind: 'person', id: ctx.callerPerson.id, name: ctx.callerPerson.name?.trim() || 'user' }
  }
  throw new TaskError('My work belongs to whoever calls: call as an agent, or from the App signed in')
}

export const myWorkActions = scopedActions<MyWorkActionId>({
  my_work: async (scope, input) => myWork(scope, await viewerOf(scope), input),
})
