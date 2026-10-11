// One session per agent per task. Every thread the task manager opens for a
// task, for a workflow step or for a mention, is that agent's thread on the
// task: titled with the task key alone (or with a suffix when that title is
// taken, see `openTaskThread`), and continued by whichever of the two reaches
// the agent next, from any step and any run of the task.
//
// Only threads the task manager opened itself are found here. The host lets it
// read the usage of, and archive, only those, so a thread a person started by
// hand under the same title stays theirs and is never adopted. A recorded
// thread can still be gone when it is reached again (a person deleted it), or
// be one the host does not count as the task manager's (opened under another
// extension id, or with no opener on record):
// `reopenTaskThread` says so, and the caller opens a new one.

import type { Db } from './db.ts'

/**
 * The titles the agent's thread on a task may open under, in order: the key
 * alone, then the key with a suffix for when that is taken. The suffix names the
 * task manager, not the workflow, because a mention opens the same thread.
 * Bounded: with all of them taken, something other than one stray thread holds
 * the names, and the step waits with the host's reason for a person to look.
 */
const taskThreadTitles = (taskKey: string): string[] => [
  taskKey,
  `${taskKey} (task manager)`,
  `${taskKey} (task manager 2)`,
  `${taskKey} (task manager 3)`,
]

/** The host's refusal of a second thread of one name for the agent in the chat. */
const isTitleTaken = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'slug-taken'

/**
 * Open the agent's thread on the task under the first free title. A thread the
 * agent already has under the task key, started by hand or left over from
 * before, keeps its title and is never written to: the task manager opens its
 * own beside it, and every later step and mention finds that one by its
 * recorded ref, never by its title.
 */
export async function openTaskThread<T>(taskKey: string, start: (title: string) => Promise<T>): Promise<T> {
  let taken: unknown
  for (const title of taskThreadTitles(taskKey)) {
    try {
      return await start(title)
    } catch (error) {
      if (!isTitleTaken(error)) {
        throw error
      }
      taken = error
    }
  }
  throw taken
}

export interface TaskThread {
  ref: string
  threadId: string | null
  chatRef: string | null
}

/**
 * The host's refusal of a chat or thread the task manager cannot reach. The
 * host gives one answer, "Not available", for one that does not exist and one
 * it may not use, so the two are never told apart here.
 */
export const isUnreachable = (error: unknown): boolean =>
  /not available/i.test(error instanceof Error ? error.message : String(error))

/** The parts of the host's group chats a recorded thread is reopened with; each is absent on a host without it. */
export interface ThreadReopener {
  thread?(ref: string): Promise<{ archived: boolean }>
  unarchive?(ref: string): Promise<unknown>
}

/**
 * Make the agent's recorded thread on the task ready to write to, back from
 * the archive when it is there. False when the host refuses the thread as
 * unreachable: the caller opens a new one, since the space's chat itself was
 * just found. Any other failure throws.
 *
 * Only an archived thread is unarchived. The host lets the task manager
 * unarchive only threads it counts as the task manager's, while any member
 * may write to a live one, so a live thread it does not count as the task
 * manager's is still continued. A host that cannot say whether a thread is
 * archived gets the unarchive every time: nothing changes on a live thread
 * the task manager opened, and one it did not is refused, so a new one opens.
 */
export async function reopenTaskThread(chats: ThreadReopener, ref: string): Promise<boolean> {
  try {
    const thread = chats.thread ? await chats.thread(ref) : null
    if (!thread || thread.archived) {
      await chats.unarchive?.(ref)
    }
    return true
  } catch (error) {
    if (isUnreachable(error)) {
      return false
    }
    throw error
  }
}

/**
 * The agent's most recently used thread on the task in this chat, or null.
 * Both places a thread is recorded count: a workflow run's steps and the
 * task's mention sessions.
 */
export function agentTaskThread(
  db: Db,
  input: { taskId: number; agentId: string; chatSlug: string },
): TaskThread | null {
  const { taskId, agentId, chatSlug } = input
  const row = db
    .prepare(
      `SELECT thread_ref, thread_id, chat_ref FROM (
         SELECT s.thread_ref, s.thread_id, s.chat_ref, coalesce(s.started_at, '') AS used_at
         FROM workflow_run_step s JOIN workflow_run r ON r.id = s.run_id
         WHERE r.task_id = ? AND s.agent_node_id = ? AND s.chat_slug = ? AND s.thread_ref IS NOT NULL
         UNION ALL
         SELECT thread_ref, thread_id, chat_ref, last_at AS used_at
         FROM mention_session
         WHERE task_id = ? AND agent_id = ? AND chat_slug = ? AND thread_ref IS NOT NULL
       ) ORDER BY used_at DESC LIMIT 1`,
    )
    .get(taskId, agentId, chatSlug, taskId, agentId, chatSlug) as
    | { thread_ref: string; thread_id: string | null; chat_ref: string | null }
    | undefined
  return row ? { ref: row.thread_ref, threadId: row.thread_id, chatRef: row.chat_ref } : null
}

// One find-or-open at a time per task and agent, whether a step or a mention
// asks, so two arriving together cannot open two threads. On globalThis so a
// hot-reloaded module keeps the queue.
const globalForThreads = globalThis as unknown as { __taskPipelinesThreadQueue?: Map<string, Promise<void>> }
globalForThreads.__taskPipelinesThreadQueue ??= new Map()
const queues = globalForThreads.__taskPipelinesThreadQueue

/** Run `work` after every earlier call for the same app, task and agent has settled. */
export function oneThreadAtATime<T>(
  scope: { app: string; taskId: number; agentId: string },
  work: () => Promise<T>,
): Promise<T> {
  const key = `${scope.app}:${scope.taskId}:${scope.agentId}`
  const result = (queues.get(key) ?? Promise.resolve()).then(work, work)
  const done = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, done)
  void done.then(() => {
    if (queues.get(key) === done) {
      queues.delete(key)
    }
  })
  return result
}
