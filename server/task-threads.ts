// One session per agent per task. Every thread the task manager opens for a
// task, for a workflow step or for a mention, is that agent's thread on the
// task: titled with the task key, and continued by whichever of the two
// reaches the agent next, from any step and any run of the task. It opens
// under that title or not at all (see `openTaskThread`).
//
// Only threads the task manager opened itself are found here. The host lets it
// read the usage of, and archive, only those, so a thread a person started by
// hand under the same title stays theirs and is never adopted. A recorded
// thread can still be gone when it is reached again (a person deleted it), or
// be one the host does not count as the task manager's (opened under another
// extension id, or with no opener on record):
// `reopenTaskThread` says so, and the caller opens a new one under the task
// key, which a thread still holding that name refuses.

import type { Db } from './db.ts'

/** The host's refusal of a second thread of one name for the agent in the chat. */
const isTitleTaken = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'slug-taken'

/** A thread as the host's `activity` lists it: what a taken title is checked by. */
export interface ListedThread {
  ref: string
  threadId: string
  title: string | null
  agent: { nodeId: string }
  chat?: { ref: string }
  archived: boolean
  /** When its session last had an event; null when it never had one. Absent on a host that does not say. */
  lastTurnAt?: string | null
}

/** The parts of the host's group chats a taken title is checked with; each is absent on a host without it. */
export interface TakenTitleChecker {
  activity?(options: {
    chat?: string
    limit?: number
    cursor?: string
    includeArchived?: boolean
  }): Promise<{ threads: ListedThread[]; nextCursor: string | null }>
  usage?(ref: string): Promise<{ turns: unknown[]; busy: boolean }>
  unarchive?(ref: string): Promise<unknown>
}

/** Where the agent's thread on a task opens, named as a person reads them. */
export interface TaskThreadPlace {
  taskKey: string
  chat: { ref: string; name: string }
  agent: { nodeId: string; name: string }
}

/**
 * The agent's thread on the task can't open: a thread of its name is there
 * and isn't one the task manager may take over. A person resolves it; the
 * task manager never opens one under another name beside it.
 */
export class TaskThreadTaken extends Error {}

// Pages of a chat's threads read to find the one holding a title; past them the title is refused unchecked.
const THREAD_PAGES = 10
const THREAD_PAGE_SIZE = 500

/**
 * Open the agent's thread on the task under the task key. When the agent
 * already has a thread of that name, there are two answers:
 * - `{ unstarted }`: it is the thread the task manager itself opened for the
 *   task whose session never started (the host keeps a thread whose first
 *   message could not be delivered, and the failed start recorded no ref).
 *   It comes back out of the archive if it is there, and the caller sends
 *   into it, so a retry goes on where the first try stopped.
 * - otherwise `TaskThreadTaken`, saying why it can't be used: a thread a
 *   person or another agent started, or one already used, is never written to,
 *   and no thread opens under another name.
 * Any other refusal of the start is thrown as it is.
 */
export async function openTaskThread<T>(
  chats: TakenTitleChecker,
  place: TaskThreadPlace,
  start: (title: string) => Promise<T>,
): Promise<{ started: T } | { unstarted: TaskThread }> {
  try {
    return { started: await start(place.taskKey) }
  } catch (error) {
    if (!isTitleTaken(error)) {
      throw error
    }
  }
  const checked = await checkTakenTitle(chats, place)
  if ('unstarted' in checked) {
    const { ref, threadId, chat, archived } = checked.unstarted
    if (archived) {
      await chats.unarchive?.(ref)
    }
    return { unstarted: { ref, threadId, chatRef: chat?.ref ?? place.chat.ref } }
  }
  throw new TaskThreadTaken(
    `${place.agent.name} already has a thread named "${place.taskKey}" in "${place.chat.name}" (${checked.why}): rename or delete that thread`,
  )
}

/** The thread holding the task key's title, if the task manager may take it over, or why not. */
async function checkTakenTitle(
  chats: TakenTitleChecker,
  place: TaskThreadPlace,
): Promise<{ unstarted: ListedThread } | { why: string }> {
  if (!chats.activity || !chats.usage) {
    return { why: "this host can't show the task manager whose thread it is" }
  }
  const found = await findThread(chats.activity, place)
  if (found === 'not-listed') {
    // The host compares addresses, not titles: "task-1" takes the address of "TASK-1".
    return { why: 'its name differs only in case or punctuation' }
  }
  if (found === 'cut') {
    return { why: 'the chat has too many threads for the task manager to find it' }
  }
  let usage: { turns: unknown[]; busy: boolean }
  try {
    // The host answers the usage only of a thread this extension opened, so this
    // decides who opened it before anything says whether it was used.
    usage = await chats.usage(found.ref)
  } catch (error) {
    if (isUnreachable(error)) {
      return { why: 'the task manager did not open it' }
    }
    throw error
  }
  // A start whose session failed to open leaves no event behind (measured 2026-11-17: no session
  // event, queue entry or transcript row). Recorded turns alone can't tell: some agents record none.
  const used = Boolean(found.lastTurnAt) || usage.turns.length > 0 || usage.busy
  return used ? { why: 'it is already in use' } : { unstarted: found }
}

async function findThread(
  activity: NonNullable<TakenTitleChecker['activity']>,
  place: TaskThreadPlace,
): Promise<ListedThread | 'not-listed' | 'cut'> {
  let cursor: string | null = null
  for (let page = 0; page < THREAD_PAGES; page += 1) {
    const result = await activity({
      chat: place.chat.ref,
      limit: THREAD_PAGE_SIZE,
      includeArchived: true,
      ...(cursor ? { cursor } : {}),
    })
    const found = result.threads.find((t) => t.agent.nodeId === place.agent.nodeId && t.title === place.taskKey)
    if (found) {
      return found
    }
    cursor = result.nextCursor
    if (!cursor) {
      return 'not-listed'
    }
  }
  return 'cut'
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
 * task's mention sessions. A thread a step was given by its workflow is not
 * the agent's thread on the task, so it never counts.
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
           AND s.thread_given = 0
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
