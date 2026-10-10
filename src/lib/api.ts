// Typed access to the `tasks` App's actions from the UI. Every call goes
// through the host's `callAppAction`, which runs the same handler an agent's
// `app_call` does, as the signed-in person — the UI has no private data path,
// and does not say who it is: the host does.

import { callAppAction } from '@opencroft/client/actions'

import type { ActionInputs } from '../../shared/action-inputs'
import type { AttachmentActionMap } from '../../shared/attachments'
import type { BoardActionMap } from '../../shared/boards'
import { DETAIL_ACTIONS } from '../../shared/compact'
import type { DependencyActionMap } from '../../shared/dependencies'
import type { ForgeActionMap } from '../../shared/forge'
import type { InboxActionMap } from '../../shared/inbox'
import type { MentionActionMap } from '../../shared/mentions'
import type { MyWorkActionMap } from '../../shared/my-work'
import type { OpenProjectActionMap } from '../../shared/openproject'
import type { SettingsActionMap } from '../../shared/settings'
import type { TasksActionMap } from '../../shared/types'
import type { VersionActionMap } from '../../shared/versions'
import type { ViewActionMap } from '../../shared/views'

/** Every key of `T`, of each member when it is a union. */
type KeysOf<T> = T extends unknown ? keyof T : never

/**
 * What the boundary check accepts as action `A`'s parameters, for a page's
 * input type `I`: the action's generated `ActionInputs` entry, and none of the
 * parameters its schema lacks. The check refuses an unknown parameter, while
 * an object type is assignable with extra keys, so the second half names them.
 */
type Accepted<A, I> = A extends keyof ActionInputs
  ? ActionInputs[A] & { [P in Exclude<KeysOf<I>, keyof ActionInputs[A]>]?: never }
  : never

type InputOf<T> = T extends { input: infer I } ? I : never

/**
 * `M`, once each of its actions is one `extension.json` declares and each
 * input is one the boundary check accepts, so a call that type-checks is not
 * refused there. An input may say more than the schema (a nested shape, which
 * the check leaves to the handler); it may not allow what the check refuses.
 */
export type CheckedActionMap<M extends { [A in keyof M]: { input: Accepted<A, InputOf<M[A]>>; output: unknown } }> = M

/** The task actions a page calls: the task manager's, the dependencies', the saved views', the boards', My work's, the inbox's, the attachments', the mentions', the settings', the versions', the OpenProject import's and the forge links'. */
type ActionMap = CheckedActionMap<
  TasksActionMap &
    DependencyActionMap &
    ViewActionMap &
    BoardActionMap &
    MyWorkActionMap &
    InboxActionMap &
    AttachmentActionMap &
    MentionActionMap &
    SettingsActionMap &
    VersionActionMap &
    OpenProjectActionMap &
    ForgeActionMap
>
type ActionId = keyof ActionMap

export function callTasks<A extends ActionId>(
  instanceId: string,
  action: A,
  params: ActionMap[A]['input'],
): Promise<ActionMap[A]['output']> {
  return callAppAction<ActionMap[A]['output']>(
    instanceId,
    action,
    withFullDetail(action, params as unknown as Record<string, unknown>),
  )
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
