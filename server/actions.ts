// The `tasks` App's actions: one handler per action id, shared by agents
// (`app_call`, attributed to ctx.callerAgent) and the App's own UI
// (`callAppAction`, attributed to ctx.callerPerson). Input schemas and
// descriptions live in extension.json.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'
import host from '@opencroft/server'

import { PROJECT_KEY_PATTERN, type TasksActionId } from '../shared/types.ts'
import { boardRestriction } from './boards/store.ts'
import { listComments } from './comments.ts'
import { instanceDb } from './db.ts'
import type { Invocation } from './hooks.ts'
import { broadcastTasksChanged } from './live.ts'
import {
  type AgentInfo,
  type PersonInfo,
  type Scope,
  TaskError,
  addComment,
  changeStatus,
  deleteComment,
  createStatus,
  createTask,
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
  reorderStatuses,
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
  const agents = (await host.agents.list())
    .map((a) => ({ id: a.id, name: a.name.trim(), avatarUrl: a.avatarUrl }))
    .filter((agent) => agent.name)
  agentCache = { at: Date.now(), agents }
  return agents
}

// The directory changes rarely too; the same short cache.
let peopleCache: { at: number; people: PersonInfo[] } | undefined

async function listPeople(): Promise<PersonInfo[]> {
  if (peopleCache && Date.now() - peopleCache.at < 10_000) {
    return peopleCache.people
  }
  const people = (await host.users.list()).map((u) => ({ id: u.id, name: u.name.trim(), avatarUrl: u.avatarUrl })).filter((p) => p.name)
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

type Params = Record<string, unknown>
type Handler = (scope: Scope, params: Params) => unknown

// biome-ignore lint/suspicious/noExplicitAny: inputs are validated by the service
const p = (params: Params) => params as any

const handlers: Record<TasksActionId, Handler> = {
  task_list: (s, params) => {
    const { board, ...input } = p(params)
    return listTasks(s, input, board === undefined ? undefined : boardRestriction(s, board))
  },
  task_get: (s, params) => getTask(s, params.key),
  task_comments: (s, params) => listComments(s, p(params)),
  task_create: (s, params) => createTask(s, p(params)),
  task_update: (s, params) => updateTask(s, p(params)),
  task_change_status: (s, params) => changeStatus(s, p(params)),
  task_move: (s, params) => moveTask(s, p(params)),
  task_delete: (s, params) => deleteTask(s, p(params)),
  task_comment: (s, params) => addComment(s, p(params)),
  task_comment_update: (s, params) => updateComment(s, p(params)),
  task_comment_delete: (s, params) => deleteComment(s, p(params)),
  status_list: (s) => listStatuses(s),
  status_create: (s, params) => createStatus(s, p(params)),
  status_update: (s, params) => updateStatus(s, p(params)),
  status_reorder: (s, params) => reorderStatuses(s, p(params)),
  status_delete: (s, params) => deleteStatus(s, p(params)),
  assignee_list: (s) => listAssignees(s),
  avatar_list: (s) => listAvatars(s),
  label_list: (s) => listLabels(s),
  task_parents: (s) => listParents(s),
}

export const taskActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [
    id,
    (ctx: AppActionContext, params: Params) => handler(scopeFor(ctx), params ?? {}),
  ]),
)
