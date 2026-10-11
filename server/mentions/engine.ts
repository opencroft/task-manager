// An agent @mentioned in a new comment gets the comment in its own session on
// the task, in the space's chat (see ../space-chat.ts): the agent's thread on
// the task (see ../task-threads.ts), shared with the workflow steps it works
// there. The first mention of an agent with no such thread opens one.
//
// Two halves. `planMentions` runs in the comment's own call, synchronously:
// it applies the guards, records the deliveries and the session rows, and says
// what to send. `deliverMentions` then opens or reuses each thread; it can take
// seconds, so the caller does not wait for it, and what goes wrong is kept on
// the session as its `note`, which the task shows.
//
// Guards:
// - only a new comment triggers (the caller only calls this for one);
// - an agent mentioning itself is left out;
// - agents mentioning each other stop after LOOP_ROUNDS comments on one task
//   within LOOP_WINDOW_MS. A person's mention starts the count again.

import { LOOP_ROUNDS, LOOP_WINDOW_MS, type MentionSession } from '../../shared/mentions.ts'
import type { Actor, Comment } from '../../shared/types.ts'
import type { Db } from '../db.ts'
import { spaceChatFor } from '../space-chat.ts'
import { agentTaskThread, oneThreadAtATime, openTaskThread, reopenTaskThread } from '../task-threads.ts'
import type { ChatsPort } from '../workflows/engine.ts'
import { type MentionMessageInput, mentionFollowUpMessage, mentionOpeningMessage } from './messages.ts'

export interface MentionEnv {
  db: Db
  /** `<space>.<app>`, for the `app_call` an agent is told to make. */
  app: string
  /** Null when the host offers no group chats: sessions then note why they could not open. */
  chats: ChatsPort | null
  /** The App's space: sessions open in that space's chat. */
  spaceSlug: string
  now: () => string
  /** Tell open pages that a task's sessions changed. */
  changed: (keys: string[]) => void
}

export interface MentionedAgent {
  id: string
  name: string
}

export interface CommentEvent {
  task: { key: string; number: number }
  comment: Comment
  actor: Actor
  /** The agents the comment @names. */
  agents: MentionedAgent[]
}

interface SessionRow {
  task_id: number
  agent_id: string
  agent_name: string
  chat_ref: string | null
  chat_slug: string | null
  thread_id: string | null
  thread_ref: string | null
  started_at: string
  last_at: string
  note: string | null
}

export interface PlannedDelivery {
  taskId: number
  taskKey: string
  agent: MentionedAgent
  input: MentionMessageInput
}

function toSession(row: SessionRow): MentionSession {
  return {
    agent: { id: row.agent_id, name: row.agent_name },
    chatRef: row.chat_ref,
    chatSlug: row.chat_slug,
    threadId: row.thread_id,
    threadRef: row.thread_ref,
    startedAt: row.started_at,
    lastAt: row.last_at,
    note: row.note,
  }
}

/** A task's mention sessions, most recently active first. */
export function listMentionSessions(db: Db, taskId: number): MentionSession[] {
  const rows = db
    .prepare('SELECT * FROM mention_session WHERE task_id = ? ORDER BY last_at DESC, agent_name')
    .all(taskId) as unknown as SessionRow[]
  return rows.map(toSession)
}

/** Create the session row, or bring its name and time up to date; `note` replaces the last one. */
function touchSession(db: Db, taskId: number, agent: MentionedAgent, at: string, note: string | null): void {
  db.prepare(
    `INSERT INTO mention_session (task_id, agent_id, agent_name, started_at, last_at, note) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, agent_id) DO UPDATE SET agent_name = excluded.agent_name, last_at = excluded.last_at, note = excluded.note`,
  ).run(taskId, agent.id, agent.name, at, at, note)
}

function setNote(db: Db, taskId: number, agentId: string, note: string | null): void {
  db.prepare('UPDATE mention_session SET note = ? WHERE task_id = ? AND agent_id = ?').run(note, taskId, agentId)
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * How many agent-written comments sent mentions on this task within the
 * window, counted since the last mention a person sent (which restarts it).
 */
function agentRounds(db: Db, taskId: number, now: string): number {
  const windowStart = new Date(Date.parse(now) - LOOP_WINDOW_MS).toISOString()
  const lastPerson = db
    .prepare('SELECT max(at) AS at FROM mention_delivery WHERE task_id = ? AND by_agent = 0')
    .get(taskId) as { at: string | null }
  const since = lastPerson.at && lastPerson.at > windowStart ? lastPerson.at : windowStart
  const row = db
    .prepare(
      'SELECT count(DISTINCT comment_id) AS n FROM mention_delivery WHERE task_id = ? AND by_agent = 1 AND at > ?',
    )
    .get(taskId, since) as { n: number }
  return row.n
}

export const PAUSED_NOTE = `Paused: agents mentioned each other ${LOOP_ROUNDS} times on this task within ${LOOP_WINDOW_MS / 60000} minutes. A person's mention starts it again.`

/**
 * The comment's own call: decide who gets it and record that, synchronously.
 * `task` carries what the opening message tells the agent.
 */
export function planMentions(
  env: MentionEnv,
  event: CommentEvent,
  task: MentionMessageInput['task'],
): PlannedDelivery[] {
  const { db } = env
  const agents = event.agents.filter(
    (agent) => !(event.actor.kind === 'agent' && (same(agent.name, event.actor.name) || agent.id === event.actor.name)),
  )
  if (agents.length === 0) {
    return []
  }
  const taskId = (db.prepare('SELECT id FROM task WHERE number = ?').get(event.task.number) as { id: number }).id
  const at = env.now()
  const byAgent = event.actor.kind === 'agent'

  if (byAgent && agentRounds(db, taskId, at) >= LOOP_ROUNDS) {
    for (const agent of agents) {
      touchSession(db, taskId, agent, at, PAUSED_NOTE)
    }
    db.prepare(
      `INSERT INTO activity (task_id, actor_kind, actor_name, kind, field, from_value, to_value, at)
       VALUES (?, ?, ?, 'field', 'agent mentions', 'on', ?, ?)`,
    ).run(
      taskId,
      event.actor.kind,
      event.actor.name,
      `paused (${LOOP_ROUNDS} agent rounds in ${LOOP_WINDOW_MS / 60000} minutes)`,
      at,
    )
    env.changed([event.task.key])
    return []
  }

  const input: MentionMessageInput = {
    app: env.app,
    task,
    comment: { author: event.comment.author.name, body: event.comment.body },
  }
  const record = db.prepare(
    'INSERT INTO mention_delivery (task_id, comment_id, agent_id, by_agent, at) VALUES (?, ?, ?, ?, ?)',
  )
  for (const agent of agents) {
    record.run(taskId, event.comment.id, agent.id, byAgent ? 1 : 0, at)
    touchSession(db, taskId, agent, at, null)
  }
  env.changed([event.task.key])
  return agents.map((agent) => ({ taskId, taskKey: event.task.key, agent, input }))
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open or reuse each planned session and send it the mention. Never throws: a failure becomes the session's note. */
export function deliverMentions(env: MentionEnv, planned: PlannedDelivery[]): Promise<void> {
  return Promise.all(
    planned.map((delivery) =>
      oneThreadAtATime({ app: env.app, taskId: delivery.taskId, agentId: delivery.agent.id }, async () => {
        const { db } = env
        const where = await spaceChatFor(env.chats, env.spaceSlug, {
          nodeId: delivery.agent.id,
          name: delivery.agent.name,
        }).catch((error) => ({ problem: reason(error) }))
        if ('problem' in where || !env.chats) {
          setNote(
            db,
            delivery.taskId,
            delivery.agent.id,
            `Not sent: ${'problem' in where ? where.problem : 'this host offers no group chats'}`,
          )
          env.changed([delivery.taskKey])
          return
        }
        const { chat } = where
        // A session in a chat other than the space's stays readable where it is; the next mention opens one here.
        const recorded = agentTaskThread(db, {
          taskId: delivery.taskId,
          agentId: delivery.agent.id,
          chatSlug: chat.slug,
        })
        const saveThread = db.prepare(
          'UPDATE mention_session SET chat_ref = ?, chat_slug = ?, thread_id = ?, thread_ref = ? WHERE task_id = ? AND agent_id = ?',
        )
        let reuse = recorded
        try {
          // A thread archived when the task closed takes no messages until it is back; one the
          // host refuses as unreachable is left, and the mention opens a new thread.
          reuse = recorded && (await reopenTaskThread(env.chats, recorded.ref)) ? recorded : null
          if (reuse) {
            await env.chats.send({ thread: reuse.ref, message: mentionFollowUpMessage(delivery.input), queue: 'wait' })
            saveThread.run(
              reuse.chatRef ?? chat.ref,
              chat.slug,
              reuse.threadId,
              reuse.ref,
              delivery.taskId,
              delivery.agent.id,
            )
          } else {
            const chats = env.chats
            const { thread } = await openTaskThread(delivery.taskKey, (title) =>
              chats.startThread({
                chat: chat.ref,
                agentNodeId: delivery.agent.id,
                title,
                message: mentionOpeningMessage(delivery.input),
              }),
            )
            saveThread.run(
              thread.chat.ref,
              thread.chat.slug,
              thread.threadId,
              thread.ref,
              delivery.taskId,
              delivery.agent.id,
            )
          }
          setNote(db, delivery.taskId, delivery.agent.id, null)
        } catch (error) {
          const what = reuse ? 'Not sent to its session' : `Could not open a session in "${chat.name}"`
          setNote(db, delivery.taskId, delivery.agent.id, `${what}: ${reason(error)}`)
        }
        env.changed([delivery.taskKey])
      }),
    ),
  ).then(() => undefined)
}
