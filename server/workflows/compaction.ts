/**
 * Compacting a step's session before a round, so a step that comes back to
 * a session it already has (a rework, or the agent's next step on the task)
 * does not re-read everything the session collected on every turn.
 *
 * The session is compacted when the step's threshold (`compactAbove`) is
 * below the context it holds, through the host's own compaction: the same
 * job an agent's `group_chat_compact` runs, which waits for a running turn
 * to end and re-delivers the thread's standing context. Nothing here decides
 * whether the round goes ahead: a compaction that fails, cannot be told or is
 * still running when the wait gives up is recorded, and the message is sent.
 */

import { randomUUID } from 'node:crypto'

import { type CompactionOutcome, compactThreshold, type StepSessionOptions } from '../../shared/workflows.ts'
import type { UsagePort } from './usage.ts'

/**
 * This process's mark, recorded on every compaction it starts. It lives on
 * globalThis, exactly as long as the compactions in flight do: a reloaded
 * module (a deploy) keeps the mark of those still running here, and a
 * restarted process gets a new one, so a `running` compaction with another
 * mark has no process left to finish it.
 */
export function processMark(): string {
  const global = globalThis as unknown as { __taskPipelinesProcessMark?: string }
  global.__taskPipelinesProcessMark ??= randomUUID()
  return global.__taskPipelinesProcessMark
}

/** Why a compaction a restart cut off is recorded as failed, and what the step it held up says. */
export const INTERRUPTED_COMPACTION = 'The server restarted while the session was compacting'
export const INTERRUPTED_ROUND =
  "The server restarted while this step's session was compacting, so the round's message was never sent. Restart the step to send it."

/** How a compaction ended — the host's `groupChats.compact` answer. */
export interface CompactResult {
  outcome: Exclude<CompactionOutcome, 'running'>
  contextBefore: number | null
  contextAfter: number | null
  error?: string
}

/** The part of the host's group chats that compacts; absent on a host without it. */
export interface CompactPort {
  compact?(thread: string): Promise<CompactResult>
}

/**
 * The session's context and the step's threshold, when the step compacts,
 * the host can, and the context is over the threshold; null otherwise. A
 * context the host does not report is never over it. Never throws.
 */
export async function contextOverThreshold(
  chats: CompactPort & UsagePort,
  options: StepSessionOptions,
  thread: string,
  now: string,
): Promise<{ threshold: number; tokens: number } | null> {
  const threshold = compactThreshold(options)
  if (threshold === null || !chats.compact || !chats.usage) {
    return null
  }
  try {
    // Only the context is wanted: turns since now are none.
    const tokens = (await chats.usage(thread, { since: now })).context?.usedTokens
    return tokens !== undefined && tokens > threshold ? { threshold, tokens } : null
  } catch (error) {
    console.error('[task-pipelines] reading a step session’s context failed', error)
    return null
  }
}

/** Compact the session and say how it ended. Never throws: a host refusal is a `failed` compaction. */
export async function compactSession(chats: CompactPort, thread: string): Promise<CompactResult> {
  try {
    if (!chats.compact) {
      throw new Error('This host cannot compact a session')
    }
    return await chats.compact(thread)
  } catch (error) {
    return {
      outcome: 'failed',
      contextBefore: null,
      contextAfter: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
