// Agents @mentioned in a task's comments: the session each one gets on the
// task, a thread in the space's chat.

import type { ActionInputs } from './action-inputs.ts'

/** Agent↔agent mentions on one task stop after this many rounds within LOOP_WINDOW_MS. */
export const LOOP_ROUNDS = 3
export const LOOP_WINDOW_MS = 10 * 60 * 1000

/** One agent's session on one task: a thread titled `<KEY> <agent>`, reused by every later mention. */
export interface MentionSession {
  agent: { id: string; name: string }
  /** Null when the session never opened; `note` says why. */
  chatRef: string | null
  chatSlug: string | null
  threadId: string | null
  threadRef: string | null
  /** When the agent was first mentioned on the task, and last sent a mention. */
  startedAt: string
  lastAt: string
  /** Why the last mention did not reach the agent, or that mentions paused; null when all is well. */
  note: string | null
}

export interface MentionActionMap {
  mention_sessions: { input: ActionInputs['mention_sessions']; output: { sessions: MentionSession[] } }
}

export type MentionActionId = keyof MentionActionMap
