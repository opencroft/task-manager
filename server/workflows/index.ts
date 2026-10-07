// Seam owned by workflows. The task manager's
// server entry spreads `workflowActions` into the `tasks` App's actions and
// imports this module once, so status hooks registered here (see
// ../hooks.ts) are live for every instance.

import type { AppActionContext, AppActionHandler, AppInstanceContext } from '@opencroft/server'
import host from '@opencroft/server'

import { invocationOf, scopeFor } from '../actions.ts'
import { type StatusChangeEvent, statusHooks } from '../hooks.ts'
import { inboxPort } from '../inbox/index.ts'
import { broadcastTasksChanged } from '../live.ts'
import { changeStatus, getTask } from '../service.ts'
import { makeWorkflowActions, type PersonChatsPort } from './actions.ts'
import { afterStatusChange, beforeStatusChange, type ChatsPort, type EngineEnv, recoverInterruptedCompactions } from './engine.ts'

const now = () => new Date().toISOString()

/**
 * The group chats the workflow opens sessions in, as the extension's own
 * identity. Null on a host that does not offer them; steps then record why
 * they could not open.
 */
function chats(): ChatsPort | null {
  return (host as unknown as { groupChats?: ChatsPort }).groupChats ?? null
}

// `<space>.<app>`, the address an agent passes to app_call. The host builds
// every action context, from the UI as from an agent, with the instance's slug.
async function appAddress(ctx: AppActionContext): Promise<string> {
  return `${ctx.spaceSlug}.${ctx.slug}`
}

async function engineEnv(ctx: AppActionContext, inv = invocationOf(ctx)): Promise<EngineEnv> {
  const scope = scopeFor(ctx, inv)
  return {
    db: scope.db,
    projectKey: scope.projectKey,
    app: await appAddress(ctx),
    chats: chats(),
    spaceSlug: ctx.spaceSlug,
    agents: () => scope.agents(),
    now,
    inbox: inboxPort(scope),
  }
}

/**
 * At server start, for one instance: compactions the previous process was
 * running when it stopped are recorded as failed, and the steps they held up
 * ask for attention (see `recoverInterruptedCompactions`). Never throws: an
 * instance loads either way.
 */
export async function recoverWorkflowsOnLoad(ctx: AppInstanceContext): Promise<void> {
  try {
    // Nobody called: the engine acts as the extension's own identity, as for any status hook.
    const recovered = await recoverInterruptedCompactions(await engineEnv(ctx as unknown as AppActionContext))
    if (recovered > 0) {
      console.info(`[task-pipelines] ${recovered} compaction(s) cut off by a restart recorded as failed`)
    }
  } catch (error) {
    console.error('[task-pipelines] recovering interrupted compactions failed', error)
  }
}

export const workflowActions: Record<string, AppActionHandler> = makeWorkflowActions({
  open: (ctx) => {
    const scope = scopeFor(ctx)
    return { db: scope.db, projectKey: scope.projectKey }
  },
  getTask: (ctx, key) => getTask(scopeFor(ctx), key),
  actor: (ctx) => invocationOf(ctx).actor,
  person: (ctx) =>
    !ctx.callerAgent && ctx.callerPerson?.id ? { id: ctx.callerPerson.id, name: ctx.callerPerson.name?.trim() || 'user' } : null,
  people: (ctx) => scopeFor(ctx).people(),
  tasks: (ctx) => ({ changeStatus: (input) => changeStatus(scopeFor(ctx), input) }),
  chats,
  personChats: (ctx) => {
    const bound = ctx.groupChats as Partial<PersonChatsPort> | undefined
    return bound?.personChats && bound.grantExtension ? (bound as PersonChatsPort) : null
  },
  appAddress,
  changed: (ctx, keys) => broadcastTasksChanged(ctx.instanceId, keys, 'workflow'),
  now,
  inbox: (ctx) => inboxPort(scopeFor(ctx)),
  agents: (ctx) => scopeFor(ctx).agents(),
})

function change(event: StatusChangeEvent) {
  return { task: event.task, from: event.from, to: event.to, actor: event.actor }
}

// Registered once per process. A hot-reloaded copy of this module drops the
// previous copy's listeners first: the hook registry outlives module reloads,
// and two engines listening would open every session twice.
const globalForWorkflows = globalThis as unknown as { __taskPipelinesWorkflowHooks?: Array<() => void> }
for (const unsubscribe of globalForWorkflows.__taskPipelinesWorkflowHooks ?? []) {
  unsubscribe()
}
globalForWorkflows.__taskPipelinesWorkflowHooks = [
  statusHooks.before((event) => {
    const scope = scopeFor(event.inv.ctx, event.inv)
    beforeStatusChange(scope.db, scope.projectKey, change(event))
  }),
  statusHooks.after(async (event) => {
    try {
      await afterStatusChange(await engineEnv(event.inv.ctx, event.inv), change(event))
    } finally {
      broadcastTasksChanged(event.instanceId, [event.task.key], 'workflow')
    }
  }),
]
