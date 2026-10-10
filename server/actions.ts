// The `tasks` App's actions: one handler per action id, shared by agents
// (`app_call`, attributed to ctx.callerAgent) and the App's own UI
// (`callAppAction`, attributed to ctx.callerPerson). Input schemas and
// descriptions live in extension.json; each handler gets its parameters
// checked against its schema and typed by it (action-params.ts).

import type { AppActionContext, AppActionHandler } from '@opencroft/server/apps'
import { agents, users } from '@opencroft/server/people'

import type { ActionId } from '../shared/action-inputs.ts'
import { PROJECT_KEY_PATTERN, type TasksActionId } from '../shared/types.ts'
import { type TypedHandlers, typedActions } from './action-params.ts'
import { boardRestriction } from './boards/store.ts'
import { listComments } from './comments.ts'
import { instanceDb } from './db.ts'
import type { Invocation } from './hooks.ts'
import { broadcastTasksChanged } from './live.ts'
import {
  type AgentInfo,
  addComment,
  changeStatus,
  createStatus,
  createTask,
  deleteComment,
  deleteStatus,
  deleteTask,
  getTask,
  listAssignees,
  listAvatars,
  listLabels,
  listParents,
  listStatuses,
  listTasks,
  moveTask,
  type PersonInfo,
  reorderStatuses,
  type Scope,
  TaskError,
  updateComment,
  updateStatus,
  updateTask,
} from './service.ts'

/** The project key an instance was added with, validated. */
export function projectKeyOf(params: Record<string, string>): string {
  const key = (params.id ?? '').trim()
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new TaskError(
      `Project key "${key}" is invalid: 2–10 characters, uppercase letters and digits, starting with a letter (e.g. TASK)`,
    )
  }
  return key
}

// Agent nodes change rarely; a short cache keeps a burst of assignments from
// rescanning every graph.
let agentCache: { at: number; agents: AgentInfo[] } | undefined

async function listAgents(): Promise<AgentInfo[]> {
  if (agentCache && Date.now() - agentCache.at < 10_000) {
    return agentCache.agents
  }
  const named = (await agents.list())
    .map((a) => ({ id: a.id, name: a.name.trim(), avatarUrl: a.avatarUrl }))
    .filter((agent) => agent.name)
  agentCache = { at: Date.now(), agents: named }
  return named
}

// The directory changes rarely too; the same short cache.
let peopleCache: { at: number; people: PersonInfo[] } | undefined

async function listPeople(): Promise<PersonInfo[]> {
  if (peopleCache && Date.now() - peopleCache.at < 10_000) {
    return peopleCache.people
  }
  const people = (await users.list())
    .map((u) => ({ id: u.id, name: u.name.trim(), avatarUrl: u.avatarUrl }))
    .filter((p) => p.name)
  peopleCache = { at: Date.now(), people }
  return people
}

/**
 * The invocation behind one action call: who asked, with what. The host binds
 * the caller — the agent for `app_call`, the signed-in person for the App's
 * own UI — so neither is taken from anything a client sent. A call with
 * neither (an internal one) is recorded as "user", the actor existing history
 * rows name.
 */
export function invocationOf(ctx: AppActionContext): Invocation {
  const bound = ctx.groupChats
  const person = ctx.callerPerson?.name?.trim()
  return {
    ctx,
    actor: ctx.callerAgent ? { kind: 'agent', name: ctx.callerAgent } : { kind: 'person', name: person || 'user' },
    ...(bound ? { groupChats: bound } : {}),
  }
}

/** Everything the service needs for one call against one instance. */
export function scopeFor(ctx: AppActionContext, inv: Invocation = invocationOf(ctx)): Scope {
  return {
    db: instanceDb(ctx.instanceId, ctx.dataDir),
    instanceId: ctx.instanceId,
    dataDir: ctx.dataDir,
    projectKey: projectKeyOf(ctx.params),
    inv,
    notify: (keys, kind) => broadcastTasksChanged(ctx.instanceId, keys, kind),
    agents: listAgents,
    people: listPeople,
  }
}

/** `handlers` as App actions: each runs in the caller's scope, on its parameters once they are checked. */
export function scopedActions<A extends ActionId>(handlers: TypedHandlers<A, Scope>): Record<string, AppActionHandler> {
  return typedActions(handlers, (ctx) => scopeFor(ctx))
}

export const taskActions = scopedActions<TasksActionId>({
  task_list: (s, { board, ...input }) =>
    listTasks(s, input, board === undefined ? undefined : boardRestriction(s, board)),
  task_get: (s, input) => getTask(s, input.key),
  task_comments: (s, input) => listComments(s, input),
  task_create: (s, input) => createTask(s, input),
  task_update: (s, input) => updateTask(s, input),
  task_change_status: (s, input) => changeStatus(s, input),
  task_move: (s, input) => moveTask(s, input),
  task_delete: (s, input) => deleteTask(s, input),
  task_comment: (s, input) => addComment(s, input),
  task_comment_update: (s, input) => updateComment(s, input),
  task_comment_delete: (s, input) => deleteComment(s, input),
  status_list: (s) => listStatuses(s),
  status_create: (s, input) => createStatus(s, input),
  status_update: (s, input) => updateStatus(s, input),
  status_reorder: (s, input) => reorderStatuses(s, input),
  status_delete: (s, input) => deleteStatus(s, input),
  assignee_list: (s) => listAssignees(s),
  avatar_list: (s) => listAvatars(s),
  label_list: (s) => listLabels(s),
  task_parents: (s) => listParents(s),
})
