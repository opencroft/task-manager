// Seam owned by saved views. The server entry spreads `viewActions` into the
// `tasks` App's actions; input schemas and descriptions live in extension.json.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import type {
  ViewActionId,
  ViewDeleteInput,
  ViewListInput,
  ViewSaveInput,
  ViewSetDefaultInput,
} from '../../shared/views.ts'
import { scopeFor } from '../actions.ts'
import { recipientKey } from '../inbox/store.ts'
import { TaskError } from '../service.ts'
import { type ViewOwner, deleteView, listViews, saveView, setDefaultView } from './store.ts'

/**
 * The caller as a view owner: the signed-in person by directory id, an agent
 * by its node id. An internal call with neither owns no views.
 */
async function ownerOf(ctx: AppActionContext): Promise<ViewOwner> {
  const scope = scopeFor(ctx)
  const person = ctx.callerPerson
  if (person?.id) {
    return { key: `person:${person.id}`, name: person.name.trim() || 'user' }
  }
  if (ctx.callerAgent) {
    const key = await recipientKey({ agents: scope.agents, people: scope.people }, { kind: 'agent', name: ctx.callerAgent })
    if (key) {
      return { key, name: ctx.callerAgent }
    }
  }
  throw new TaskError('Saved views belong to whoever calls: call as an agent, or from the App signed in')
}

type Params = Record<string, unknown>

const handlers: Record<ViewActionId, (ctx: AppActionContext, params: Params) => Promise<unknown>> = {
  view_list: async (ctx, params) => listViews(scopeFor(ctx).db, await ownerOf(ctx), params as ViewListInput),
  view_save: async (ctx, params) => saveView(scopeFor(ctx).db, await ownerOf(ctx), params as ViewSaveInput, new Date().toISOString()),
  view_delete: async (ctx, params) => deleteView(scopeFor(ctx).db, await ownerOf(ctx), params as unknown as ViewDeleteInput),
  view_set_default: async (ctx, params) =>
    setDefaultView(scopeFor(ctx).db, await ownerOf(ctx), params as unknown as ViewSetDefaultInput),
}

export const viewActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx: AppActionContext, params: Params) => handler(ctx, params ?? {})]),
)
