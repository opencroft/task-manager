// Seam owned by agent mentions. The server entry spreads `mentionActions` into
// the `tasks` App's actions and imports this module once, so the comment
// listener registered here is live for every instance. Sessions open in the
// space's chat, like workflow steps, as the extension's own identity.

import type { AppActionContext } from '@opencroft/server/apps'
import { groupChats } from '@opencroft/server/chat'

import type { MentionActionId } from '../../shared/mentions.ts'
import { scopedActions, scopeFor } from '../actions.ts'
import { onTaskEvent } from '../hooks.ts'
import { broadcastTasksChanged } from '../live.ts'
import { getTask } from '../service.ts'
import type { ChatsPort } from '../workflows/engine.ts'
import { deliverMentions, listMentionSessions, type MentionEnv, planMentions } from './engine.ts'
import { mentionedIn } from './mentioned.ts'

const now = () => new Date().toISOString()

function chats(): ChatsPort {
  return groupChats
}

function envFor(ctx: AppActionContext): MentionEnv {
  return {
    db: scopeFor(ctx).db,
    app: `${ctx.spaceSlug}.${ctx.slug}`,
    chats: chats(),
    spaceSlug: ctx.spaceSlug,
    now,
    changed: (keys) => broadcastTasksChanged(ctx.instanceId, keys, 'task'),
  }
}

export const mentionActions = scopedActions<MentionActionId>({
  mention_sessions: (scope, input) => {
    const task = getTask(scope, input.key)
    const { id } = scope.db.prepare('SELECT id FROM task WHERE number = ?').get(task.number) as { id: number }
    return { sessions: listMentionSessions(scope.db, id) }
  },
})

// Registered once per process; a hot-reloaded copy drops the previous copy's
// listener first, or every mention would be sent twice.
const globalForMentions = globalThis as unknown as { __taskPipelinesMentionHooks?: Array<() => void> }
for (const unsubscribe of globalForMentions.__taskPipelinesMentionHooks ?? []) {
  unsubscribe()
}
globalForMentions.__taskPipelinesMentionHooks = [
  onTaskEvent(async (event) => {
    if (event.kind !== 'commented') {
      return
    }
    const scope = scopeFor(event.inv.ctx, event.inv)
    const mentioned = await mentionedIn(event.comment.body)
    const agents = mentioned.flatMap((party) =>
      party.kind === 'agent' && party.id ? [{ id: party.id, name: party.name }] : [],
    )
    if (agents.length === 0) {
      return
    }
    const env = envFor(event.inv.ctx)
    const full = getTask(scope, event.task.key)
    const planned = planMentions(
      env,
      { task: event.task, comment: event.comment, actor: event.actor, agents },
      {
        key: full.key,
        summary: full.summary,
        description: full.description,
        status: full.status.name,
        assignee: full.assignee?.name ?? null,
      },
    )
    // Not awaited: opening a thread takes seconds, and the comment is already saved.
    void deliverMentions(env, planned)
  }),
]
