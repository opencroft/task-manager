// Pull requests on the forge (Forgejo), linked to the tasks they mention. The
// App's server reads the forge once a minute and keeps the links; pages see
// them on the tasks they already load. The connection holds the name of a
// Secrets Store key, never the token, and only a person sets it.

import type { ActionInputs } from './action-inputs.ts'
import type { LinkedPullRequest, TaskKey } from './types.ts'

/** Where pull requests are read from. `secretKey` names the Secrets Store key holding a read token. */
export interface ForgeConnection {
  /** The forge's address, e.g. `https://git.example.com`. */
  url: string
  /** The organisation or user whose repositories are read, e.g. `my-org`. */
  owner: string
  secretKey: string
}

export interface ForgeStatus {
  connection: ForgeConnection | null
  /** When the last read finished, whether or not it found changes; null before the first. */
  lastSyncAt: string | null
  /** Why the last read failed; null when it did not. */
  lastError: string | null
  /** Pull requests read so far, and how many of them mention a task here. */
  pullRequests: number
  linked: number
}

export interface ForgeActionMap {
  task_prs: { input: ActionInputs['task_prs']; output: { key: TaskKey; pullRequests: LinkedPullRequest[] } }
  forge_status: { input: ActionInputs['forge_status']; output: ForgeStatus }
  forge_connect: { input: ActionInputs['forge_connect']; output: ForgeStatus }
  forge_disconnect: { input: ActionInputs['forge_disconnect']; output: ForgeStatus }
}

export type ForgeActionId = keyof ForgeActionMap

/** Secrets Store keys the forge connection may name: a forge token, not any secret. */
export const FORGE_SECRET_PREFIX = 'FORGEJO_'

/** How often the server reads the forge. */
export const FORGE_POLL_SECONDS = 60
