// Seam owned by the inbox. The server entry spreads
// `inboxActions` into the `tasks` App's actions and imports this module once,
// so the listeners registered here are live for every instance. The workflow
// engine is handed `inboxPort` through its env (../workflows/index.ts).

import type { AppActionContext, AppActionHandler } from '@opencroft/server'
import host from '@opencroft/server'

import {
  INBOX_EVENT,
  type InboxEvent,
  type InboxListInput,
  type InboxMarkReadInput,
  type InboxMarkUnreadInput,
  type InboxMuteInput,
} from '../../shared/inbox.ts'
import { scopeFor } from '../actions.ts'
import { type Invocation, onTaskEvent, statusHooks } from '../hooks.ts'
import type { Scope } from '../service.ts'
import {
  type Directory,
  InboxError,
  type NotificationDraft,
  actorParty,
  deliver,
  excerptOf,
  listInbox,
  markRead,
  markUnread,
  mentionedIn,
  recipientKey,
  setMuted,
  statusSnapshot,
} from './store.ts'

const now = () => new Date().toISOString()

function broadcast(instanceId: string): void {
  const payload: InboxEvent = { instanceId }
  try {
    host.events.broadcast(INBOX_EVENT, payload as unknown as Record<string, unknown>)
  } catch (error) {
    console.error('[task-pipelines] inbox broadcast failed', error)
  }
}

function directoryOf(scope: Scope): Directory {
  return { agents: scope.agents, people: scope.people }
}

/** The signed-in person's directory id, when a person called. */
function personIdOf(inv: Invocation): string | null {
  return inv.ctx.callerPerson?.id ?? null
}

/** Record a notification in one instance and tell its open pages. */
export function inboxPort(scope: Scope): (draft: NotificationDraft) => Promise<void> {
  return async (draft) => {
    const delivered = await deliver(scope.db, directoryOf(scope), draft, now())
    if (delivered.length) {
      broadcast(scope.instanceId)
    }
  }
}

/** The caller's own inbox key; an internal call with no caller has none. */
async function callerKey(scope: Scope): Promise<string> {
  const inv = scope.inv
  const key = inv.ctx.callerAgent
    ? await recipientKey(directoryOf(scope), { kind: 'agent', name: inv.ctx.callerAgent })
    : personIdOf(inv)
      ? `person:${personIdOf(inv)}`
      : null
  if (!key) {
    throw new InboxError('An inbox belongs to whoever calls: call as an agent, or from the App signed in')
  }
  return key
}

type Params = Record<string, unknown>

export const inboxActions: Record<string, AppActionHandler> = {
  inbox_list: async (ctx: AppActionContext, params: Params) => {
    const scope = scopeFor(ctx)
    return listInbox(scope.db, scope.projectKey, await callerKey(scope), (params ?? {}) as InboxListInput)
  },
  inbox_mark_read: async (ctx: AppActionContext, params: Params) => {
    const scope = scopeFor(ctx)
    const result = markRead(scope.db, await callerKey(scope), (params ?? {}) as InboxMarkReadInput, now())
    broadcast(scope.instanceId)
    return result
  },
  inbox_mark_unread: async (ctx: AppActionContext, params: Params) => {
    const scope = scopeFor(ctx)
    const result = markUnread(scope.db, await callerKey(scope), (params ?? {}) as unknown as InboxMarkUnreadInput)
    broadcast(scope.instanceId)
    return result
  },
  inbox_mute: async (ctx: AppActionContext, params: Params) => {
    const scope = scopeFor(ctx)
    const result = setMuted(scope.db, scope.projectKey, await callerKey(scope), (params ?? {}) as unknown as InboxMuteInput, now())
    broadcast(scope.instanceId)
    return result
  },
}

// Registered once per process; a hot-reloaded copy drops the previous copy's
// listeners first (the registries outlive module reloads), or every
// notification would be made twice.
const globalForInbox = globalThis as unknown as { __taskPipelinesInboxHooks?: Array<() => void> }
for (const unsubscribe of globalForInbox.__taskPipelinesInboxHooks ?? []) {
  unsubscribe()
}
globalForInbox.__taskPipelinesInboxHooks = [
  statusHooks.after(async (event) => {
    // Logged, not returned: a status hook's throw would reach the mover as a warning.
    try {
      const scope = scopeFor(event.inv.ctx, event.inv)
      await inboxPort(scope)({
        kind: 'status_changed',
        taskNumber: event.task.number,
        recipients: ['reporter', 'assignee'],
        actor: actorParty(event.actor, personIdOf(event.inv)),
        from: statusSnapshot(event.from),
        to: statusSnapshot(event.to),
      })
    } catch (error) {
      console.error(`[task-pipelines] inbox: status notification failed for ${event.task.key}`, error)
    }
  }),
  onTaskEvent(async (event) => {
    const scope = scopeFor(event.inv.ctx, event.inv)
    const actor = actorParty(event.actor, personIdOf(event.inv))
    if (event.kind === 'assigned') {
      await inboxPort(scope)({ kind: 'assigned', taskNumber: event.task.number, recipients: [event.assignee], actor })
      return
    }
    const mentioned = await mentionedIn(event.comment.body, directoryOf(scope))
    if (mentioned.length) {
      await inboxPort(scope)({
        kind: 'mentioned',
        taskNumber: event.task.number,
        recipients: mentioned,
        actor,
        excerpt: excerptOf(event.comment.body),
      })
    }
  }),
]
