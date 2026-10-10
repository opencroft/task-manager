// Seam owned by saved views. The server entry spreads `viewActions` into the
// `tasks` App's actions; input schemas and descriptions live in extension.json.

import type { ViewActionId } from '../../shared/views.ts'
import { scopedActions } from '../actions.ts'
import { recipientKey } from '../inbox/store.ts'
import { type Scope, TaskError } from '../service.ts'
import { deleteView, listViews, saveView, setDefaultView, type ViewOwner } from './store.ts'

/**
 * The caller as a view owner: the signed-in person by directory id, an agent
 * by its node id. An internal call with neither owns no views.
 */
async function ownerOf(scope: Scope): Promise<ViewOwner> {
  const { ctx } = scope.inv
  const person = ctx.callerPerson
  if (person?.id) {
    return { key: `person:${person.id}`, name: person.name.trim() || 'user' }
  }
  if (ctx.callerAgent) {
    const key = await recipientKey(
      { agents: scope.agents, people: scope.people },
      { kind: 'agent', name: ctx.callerAgent },
    )
    if (key) {
      return { key, name: ctx.callerAgent }
    }
  }
  throw new TaskError('Saved views belong to whoever calls: call as an agent, or from the App signed in')
}

export const viewActions = scopedActions<ViewActionId>({
  view_list: async (scope, input) => listViews(scope.db, await ownerOf(scope), input),
  view_save: async (scope, input) => saveView(scope.db, await ownerOf(scope), input, new Date().toISOString()),
  view_delete: async (scope, input) => deleteView(scope.db, await ownerOf(scope), input),
  view_set_default: async (scope, input) => setDefaultView(scope.db, await ownerOf(scope), input),
})
