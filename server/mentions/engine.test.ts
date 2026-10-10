import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LOOP_ROUNDS } from '../../shared/mentions.ts'
import type { Actor } from '../../shared/types.ts'
import { makeScope } from '../attachments/testing.ts'
import { createTask, getTask } from '../service.ts'
import type { ChatsPort } from '../workflows/engine.ts'
import {
  deliverMentions,
  listMentionSessions,
  type MentionEnv,
  type MentionedAgent,
  PAUSED_NOTE,
  planMentions,
} from './engine.ts'
import { mentionOpeningMessage } from './messages.ts'

const QA: MentionedAgent = { id: 'agent_qa', name: 'Ace (QA)' }
const DEV: MentionedAgent = { id: 'agent_dev', name: 'Ace (Dev)' }
const OUTSIDER: MentionedAgent = { id: 'agent_far', name: 'Zed' }
const ALICE: Actor = { kind: 'person', name: 'Alice' }

/**
 * The host's group chats as the task manager sees them: the space's chat
 * (`testing`, the test App's space) with QA and Dev in it, and another chat
 * with Zed. `outsider` leaves the task manager out of the space's chat.
 */
function fakeChats(fail?: { start?: string; send?: string }, outsider = false) {
  const started: Array<{ chat: string; agentNodeId: string; title?: string; message: string }> = []
  const sent: Array<{ thread: string; message: string; queue?: 'wait' | 'push' }> = []
  const unarchived: string[] = []
  // Each agent's thread titles, as `<chat> <agent> <title>`: the host refuses a second of one name in a chat.
  const titles = new Set<string>()
  const port: ChatsPort = {
    unarchive: async (ref) => {
      unarchived.push(ref)
    },
    list: async () => [
      {
        ref: 'chat-other',
        slug: 'elsewhere',
        name: 'Elsewhere',
        agents: [{ nodeId: OUTSIDER.id, name: OUTSIDER.name }],
      },
      ...(outsider
        ? []
        : [
            {
              ref: 'chat-1',
              slug: 'testing',
              name: 'Testing',
              agents: [QA, DEV].map((agent) => ({ nodeId: agent.id, name: agent.name })),
            },
          ]),
    ],
    startThread: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (fail?.start) throw new Error(fail.start)
      const named = `${input.chat} ${input.agentNodeId} ${input.title}`
      if (titles.has(named)) {
        throw Object.assign(new Error(`This agent already has a thread named "${input.title}" here`), {
          code: 'slug-taken',
        })
      }
      titles.add(named)
      started.push(input)
      const threadId = `thread-${started.length}`
      return { thread: { ref: `testing.${threadId}`, threadId, chat: { ref: 'chat-1', slug: 'testing' } } }
    },
    send: async (input) => {
      if (fail?.send) throw new Error(fail.send)
      sent.push(input)
      return {}
    },
  }
  return { port, started, sent, unarchived, titles }
}

async function setup(options: { outsider?: boolean; fail?: { start?: string; send?: string } } = {}) {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  const { key, number } = (
    await createTask(scope, { summary: 'Check on a phone', description: 'The board at 375 px.' })
  ).result
  let clock = Date.parse('2026-09-26T16:00:00.000Z')
  const chats = fakeChats(options.fail, options.outsider)
  const changed: string[][] = []
  const env: MentionEnv = {
    db: scope.db,
    app: 'testing.tasks',
    chats: chats.port,
    spaceSlug: 'testing',
    now: () => new Date(clock).toISOString(),
    changed: (keys) => changed.push(keys),
  }
  const facts = {
    key,
    summary: 'Check on a phone',
    description: 'The board at 375 px.',
    status: 'To Do',
    assignee: null,
  }
  let commentId = 100
  const mention = async (
    actor: Actor,
    agents: MentionedAgent[],
    body = `@${agents.map((a) => a.name).join(' @')} please look`,
  ) => {
    const planned = planMentions(
      env,
      {
        task: { key, number },
        comment: { id: commentId++, author: actor, body, createdAt: '', updatedAt: '' },
        actor,
        agents,
      },
      facts,
    )
    await deliverMentions(env, planned)
    return planned
  }
  const sessions = () => {
    const { id } = scope.db.prepare('SELECT id FROM task WHERE number = ?').get(number) as { id: number }
    return listMentionSessions(scope.db, id)
  }
  return { scope, key, env, chats, changed, mention, sessions, advance: (ms: number) => (clock += ms) }
}

test('the first mention opens one thread per task and agent, and a later mention goes into the same thread', async () => {
  const { key, chats, mention, sessions, changed } = await setup()
  await mention(ALICE, [QA], '@Ace (QA) can you check this on a phone?')
  assert.equal(chats.started.length, 1)
  const [start] = chats.started
  assert.deepEqual(
    [start?.chat, start?.agentNodeId, start?.title],
    ['chat-1', 'agent_qa', key],
    'titled with the task key alone',
  )
  assert.match(
    start?.message ?? '',
    /\*\*Alice\*\* mentioned you in a comment on TASK-1:\n\n> @Ace \(QA\) can you check this on a phone\?/,
  )
  assert.match(start?.message ?? '', /Status: To Do\. Assignee: nobody\./)
  assert.match(start?.message ?? '', /> The board at 375 px\./)
  assert.match(
    start?.message ?? '',
    /app_call \{ app: "testing.tasks", action: "task_comment", params: \{"key":"TASK-1"/,
  )

  await mention(ALICE, [QA], '@Ace (QA) and at 320 px?')
  assert.equal(chats.started.length, 1, 'no second thread')
  assert.deepEqual(
    chats.sent.map((s) => s.thread),
    ['testing.thread-1'],
  )
  assert.match(
    chats.sent[0]?.message ?? '',
    /\*\*Alice\*\* mentioned you again on TASK-1 \(To Do\):\n\n> @Ace \(QA\) and at 320 px\?/,
  )

  const [session] = sessions()
  assert.deepEqual(
    { ...session, startedAt: typeof session?.startedAt, lastAt: typeof session?.lastAt },
    {
      agent: QA,
      chatRef: 'chat-1',
      chatSlug: 'testing',
      threadId: 'thread-1',
      threadRef: 'testing.thread-1',
      startedAt: 'string',
      lastAt: 'string',
      note: null,
    },
  )
  assert.ok(changed.length > 0 && changed.every((keys) => keys[0] === key), 'the task is announced as changed')
})

test("an agent's thread already named with the task key is left alone: the mention opens one beside it, and the next mention goes there", async () => {
  const { key, chats, mention, sessions } = await setup()
  // Started by hand, before any mention.
  chats.titles.add(`chat-1 agent_qa ${key}`)
  await mention(ALICE, [QA], '@Ace (QA) can you check this on a phone?')
  await mention(ALICE, [QA], '@Ace (QA) and at 320 px?')
  assert.deepEqual(
    chats.started.map((s) => s.title),
    [`${key} (task manager)`],
  )
  assert.deepEqual(
    chats.sent.map((s) => s.thread),
    ['testing.thread-1'],
  )
  assert.deepEqual(
    sessions().map((s) => [s.threadRef, s.note]),
    [['testing.thread-1', null]],
  )
})

test('two mentions in quick succession still open only one thread', async () => {
  const { scope, key, env, chats } = await setup()
  const number = getTask(scope, key).number
  const plan = (id: number) =>
    planMentions(
      env,
      {
        task: { key, number },
        comment: { id, author: ALICE, body: '@Ace (QA)', createdAt: '', updatedAt: '' },
        actor: ALICE,
        agents: [QA],
      },
      {
        key,
        summary: 's',
        description: '',
        status: 'To Do',
        assignee: null,
      },
    )
  await Promise.all([deliverMentions(env, plan(1)), deliverMentions(env, plan(2))])
  assert.equal(chats.started.length, 1)
  assert.equal(chats.sent.length, 1)
})

test('an agent mentioning itself sends nothing; the other agents it names still get it', async () => {
  const { chats, mention } = await setup()
  const self = await mention({ kind: 'agent', name: 'Ace (QA)' }, [QA])
  assert.deepEqual(self, [])
  await mention({ kind: 'agent', name: 'Ace (QA)' }, [QA, DEV])
  assert.deepEqual(
    chats.started.map((s) => s.agentNodeId),
    ['agent_dev'],
  )
})

test("when the task manager isn't in the space's chat nothing is sent, and the session says who has to act", async () => {
  const { chats, mention, sessions } = await setup({ outsider: true })
  await mention(ALICE, [QA])
  assert.deepEqual(
    [chats.started.length, sessions()[0]?.note],
    [
      0,
      `Not sent: The task manager isn't in this space's chat ("testing") yet: a person grants it in the task manager's Settings → Chat`,
    ],
  )
})

test("an agent who isn't in the space's chat is not reached, not even in a chat it is in; the others are", async () => {
  const { chats, mention, sessions } = await setup()
  await mention(ALICE, [OUTSIDER, QA])
  assert.deepEqual(
    chats.started.map((s) => [s.chat, s.agentNodeId]),
    [['chat-1', QA.id]],
  )
  const notes = Object.fromEntries(sessions().map((s) => [s.agent.name, s.note]))
  assert.deepEqual(notes, { Zed: "Not sent: Zed isn't in this space's chat", 'Ace (QA)': null })
})

test('a session opened in another chat before is left there: the next mention opens one in the space chat', async () => {
  const { scope, chats, mention, sessions } = await setup()
  await mention(ALICE, [QA])
  scope.db
    .prepare(
      "UPDATE mention_session SET chat_slug = 'old-project-chat', chat_ref = 'chat-old', thread_ref = 'old-project-chat.old'",
    )
    .run()
  chats.titles.clear()
  await mention(ALICE, [QA], '@Ace (QA) again')
  assert.deepEqual([chats.started.length, chats.sent.length], [2, 0], 'a new thread, nothing sent into the old one')
  assert.deepEqual([sessions()[0]?.chatSlug, sessions()[0]?.threadRef], ['testing', 'testing.thread-2'])
})

test('a session that cannot open is noted on the session, with the reason', async () => {
  const opening = await setup({ fail: { start: 'Not available' } })
  await opening.mention(ALICE, [QA])
  assert.equal(opening.sessions()[0]?.note, 'Could not open a session in "Testing": Not available')
  assert.equal(opening.sessions()[0]?.threadId, null)
})

test(`agents mentioning each other stop after ${LOOP_ROUNDS} rounds in 10 minutes; a person's mention or the window's end starts it again`, async () => {
  const { chats, mention, sessions, advance, scope, key } = await setup()
  const qa: Actor = { kind: 'agent', name: 'Ace (QA)' }
  const dev: Actor = { kind: 'agent', name: 'Ace (Dev)' }
  for (let round = 0; round < LOOP_ROUNDS; round++) {
    await mention(round % 2 ? dev : qa, [round % 2 ? QA : DEV])
    advance(60_000)
  }
  const deliveredBefore = chats.started.length + chats.sent.length
  assert.equal(deliveredBefore, LOOP_ROUNDS)
  assert.deepEqual(await mention(dev, [QA]), [], `round ${LOOP_ROUNDS + 1} is cut`)
  assert.equal(chats.started.length + chats.sent.length, deliveredBefore)
  assert.equal(sessions().find((s) => s.agent.id === QA.id)?.note, PAUSED_NOTE)
  assert.deepEqual(
    getTask(scope, key)
      .activity.filter((a) => a.field === 'agent mentions')
      .map((a) => [a.actor.name, a.from, a.to]),
    [['Ace (Dev)', 'on', `paused (${LOOP_ROUNDS} agent rounds in 10 minutes)`]],
    'a visible note in the history',
  )

  await mention(ALICE, [QA])
  assert.equal(
    sessions().find((s) => s.agent.id === QA.id)?.note,
    null,
    "a person's mention goes through and clears the note",
  )
  assert.equal((await mention(qa, [DEV])).length, 1, 'and agents may answer again')

  advance(11 * 60_000)
  for (let round = 0; round < LOOP_ROUNDS - 1; round++) {
    assert.equal((await mention(dev, [QA])).length, 1)
  }
})

test('one comment naming two agents opens a session for each', async () => {
  const { mention, chats } = await setup()
  await mention(ALICE, [QA, DEV])
  assert.deepEqual(chats.started.map((s) => s.agentNodeId).sort(), [DEV.id, QA.id])
})

test("a mention goes into the agent's workflow thread on the task, brought back from the archive, queued", async () => {
  const { scope, key, chats, mention, sessions } = await setup()
  const { id } = scope.db.prepare('SELECT id FROM task WHERE number = ?').get(getTask(scope, key).number) as {
    id: number
  }
  scope.db
    .prepare(
      `INSERT INTO workflow_run (id, task_id, workflow_id, workflow_name, state, started_by_kind, started_by_name, started_at, ended_at)
       VALUES ('run-1', ?, NULL, 'Standard', 'finished', 'person', 'Ada', '2026-09-26T10:00:00.000Z', '2026-09-26T11:00:00.000Z')`,
    )
    .run(id)
  scope.db
    .prepare(
      `INSERT INTO workflow_run_step (run_id, step_id, position, name, state, agent_node_id, agent_name, chat_ref, chat_slug, thread_ref, thread_id, started_at)
       VALUES ('run-1', 'qa', 0, 'QA', 'done', ?, ?, 'chat-1', 'testing', 'testing.step-thread', 'step-thread', '2026-09-26T10:00:00.000Z')`,
    )
    .run(QA.id, QA.name)

  await mention({ kind: 'person', name: 'Ada' }, [QA])
  assert.equal(chats.started.length, 0, 'no thread of its own')
  assert.deepEqual(chats.unarchived, ['testing.step-thread'])
  assert.deepEqual(
    chats.sent.map((s) => [s.thread, s.queue]),
    [['testing.step-thread', 'wait']],
  )
  assert.deepEqual([sessions()[0]?.threadRef, sessions()[0]?.threadId], ['testing.step-thread', 'step-thread'])
})

test('the opening message leaves out an empty description and names the assignee', () => {
  const text = mentionOpeningMessage({
    app: 'a.b',
    task: { key: 'P-1', summary: 'S', description: '  ', status: 'In Progress', assignee: 'Ada' },
    comment: { author: 'Ada', body: 'hi' },
  })
  assert.doesNotMatch(text, /Description/)
  assert.match(text, /Assignee: Ada\./)
  assert.match(text, /Writing @Ada in your comment notifies them\./)
})
