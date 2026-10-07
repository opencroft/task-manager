// Typed access to the `tasks` App's actions from the UI. Every call goes
// through the host's `callAppAction`, which runs the same handler an agent's
// `app_call` does, as the signed-in person — the UI has no private data path,
// and does not say who it is: the host does.

import { callAppAction } from '@opencroft/client'

import type { AttachmentActionMap } from '../../shared/attachments'
import type { BoardActionMap } from '../../shared/boards'
import { DETAIL_ACTIONS } from '../../shared/compact'
import type { DependencyActionMap } from '../../shared/dependencies'
import type { ForgeActionMap } from '../../shared/forge'
import type { MentionActionMap } from '../../shared/mentions'
import type { MyWorkActionMap } from '../../shared/my-work'
import type { OpenProjectActionMap } from '../../shared/openproject'
import type { SettingsActionMap } from '../../shared/settings'
import type { TasksActionMap } from '../../shared/types'
import type { VersionActionMap } from '../../shared/versions'
import type { ViewActionMap } from '../../shared/views'

/** The task actions a page calls: the task manager's, the dependencies', the saved views', the boards', My work's, the attachments', the mentions', the settings', the versions', the OpenProject import's and the forge links'. */
type ActionMap = TasksActionMap &
  DependencyActionMap &
  ViewActionMap &
  BoardActionMap &
  MyWorkActionMap &
  AttachmentActionMap &
  MentionActionMap &
  SettingsActionMap &
  VersionActionMap &
  OpenProjectActionMap &
  ForgeActionMap
type ActionId = keyof ActionMap

export function callTasks<A extends ActionId>(instanceId: string, action: A, params: ActionMap[A]['input']): Promise<ActionMap[A]['output']> {
  return callAppAction<ActionMap[A]['output']>(instanceId, action, withFullDetail(action, params as unknown as Record<string, unknown>))
}

const DETAIL = new Set<string>(DETAIL_ACTIONS)

/**
 * The parameters, asking for the full shape where the action has a compact
 * one: agents get compact rows by default, and the pages render from the
 * full records the types here describe.
 */
export function withFullDetail(action: string, params: Record<string, unknown>): Record<string, unknown> {
  return DETAIL.has(action) ? { ...params, detail: 'full' } : params
}

/** A bound client for one App instance: `api.task_list({...})`. */
export type TasksApi = {
  [A in ActionId]: (params: ActionMap[A]['input']) => Promise<ActionMap[A]['output']>
}

export function tasksApi(instanceId: string): TasksApi {
  return new Proxy({} as TasksApi, {
    get: (_target, action: string) => (params: never) => callTasks(instanceId, action as ActionId, params),
  })
}

/** The message of an error thrown by an action, without the transport's prefixes. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^(Error|TaskError):\s*/, '')
}
