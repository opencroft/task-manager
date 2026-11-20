import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  type ListedThread,
  openTaskThread,
  reopenTaskThread,
  type TakenTitleChecker,
  TaskThreadTaken,
} from './task-threads.ts'

const taken = (title: string) =>
  Object.assign(new Error(`This agent already has a thread named "${title}" here`), { code: 'slug-taken' })

const PLACE = { taskKey: 'TASK-7', chat: { ref: 'chat-1', name: 'Dev' }, agent: { nodeId: 'agent_bob', name: 'Bob' } }

/** A thread of Bob's in the chat, as the host lists it. */
const listed = (ref: string, fields: Partial<ListedThread> = {}): ListedThread => ({
  ref,
  threadId: `id-${ref}`,
  title: 'TASK-7',
  agent: { nodeId: 'agent_bob' },
  chat: { ref: 'chat-1' },
  archived: false,
  lastTurnAt: null,
  ...fields,
})

/**
 * The host's chats with the given threads, one page each when `pages` splits
 * them. Only refs in `opened` are the task manager's: the host answers their
 * usage, from `turns`, and refuses every other thread's as "Not available".
 */
function host(
  pages: ListedThread[][],
  opts: { opened?: string[]; turns?: Record<string, number>; busy?: string[] } = {},
): TakenTitleChecker & { asked: string[]; unarchived: string[] } {
  const asked: string[] = []
  const unarchived: string[] = []
  return {
    asked,
    unarchived,
    activity: async ({ chat, cursor, includeArchived }) => {
      asked.push(`${chat} ${cursor ?? 'first'} ${includeArchived ? 'with archived' : 'live only'}`)
      const page = cursor ? Number(cursor) : 0
      return { threads: pages[page] ?? [], nextCursor: page + 1 < pages.length ? String(page + 1) : null }
    },
    usage: async (ref) => {
      if (!opts.opened?.includes(ref)) {
        throw new Error('Not available')
      }
      return { turns: Array.from({ length: opts.turns?.[ref] ?? 0 }), busy: opts.busy?.includes(ref) ?? false }
    },
    unarchive: async (ref) => {
      unarchived.push(ref)
    },
  }
}

const takenStart = async (title: string): Promise<string> => {
  throw taken(title)
}

test('the thread opens under the task key when it is free, and nothing else is asked', async () => {
  const tried: string[] = []
  const chats = host([])
  const opened = await openTaskThread(chats, PLACE, async (t) => {
    tried.push(t)
    return t
  })
  assert.deepEqual(opened, { started: 'TASK-7' })
  assert.deepEqual([tried, chats.asked], [['TASK-7'], []])
})

test('a taken title is answered with the unstarted thread the task manager opened, never a second start', async () => {
  const tried: string[] = []
  const chats = host([[listed('dev.bob.other', { title: 'TASK-8' }), listed('dev.bob.task-7')]], {
    opened: ['dev.bob.task-7'],
  })
  const opened = await openTaskThread(chats, PLACE, async (t) => {
    tried.push(t)
    throw taken(t)
  })
  assert.deepEqual(opened, { unstarted: { ref: 'dev.bob.task-7', threadId: 'id-dev.bob.task-7', chatRef: 'chat-1' } })
  assert.deepEqual(tried, ['TASK-7'])
  assert.deepEqual(chats.asked, ['chat-1 first with archived'])
  assert.deepEqual(chats.unarchived, [])
})

test('an unstarted thread in the archive is brought back before it is answered', async () => {
  const chats = host([[listed('dev.bob.task-7', { archived: true })]], { opened: ['dev.bob.task-7'] })
  const opened = await openTaskThread(chats, PLACE, takenStart)
  assert.ok('unstarted' in opened)
  assert.deepEqual(chats.unarchived, ['dev.bob.task-7'])
})

test('the thread holding the title is looked for on every page of the chat', async () => {
  const chats = host([[listed('dev.bob.a', { title: 'A' })], [listed('dev.bob.task-7')]], {
    opened: ['dev.bob.task-7'],
  })
  const opened = await openTaskThread(chats, PLACE, takenStart)
  assert.deepEqual('unstarted' in opened && opened.unstarted.ref, 'dev.bob.task-7')
  assert.deepEqual(chats.asked, ['chat-1 first with archived', 'chat-1 1 with archived'])
})

test('a taken title the task manager may not take over refuses, saying why', async () => {
  const cases: Array<[string, TakenTitleChecker, string]> = [
    [
      'started by someone else with a message',
      host([[listed('dev.bob.task-7', { lastTurnAt: '2026-09-26T06:00:00.000Z' })]]),
      'the task manager did not open it',
    ],
    [
      'started by someone else, its session never opened',
      host([[listed('dev.bob.task-7')]]),
      'the task manager did not open it',
    ],
    [
      'opened by the task manager and used since',
      host([[listed('dev.bob.task-7')]], { opened: ['dev.bob.task-7'], turns: { 'dev.bob.task-7': 1 } }),
      'it is already in use',
    ],
    [
      'opened by the task manager, its first turn running',
      host([[listed('dev.bob.task-7')]], { opened: ['dev.bob.task-7'], busy: ['dev.bob.task-7'] }),
      'it is already in use',
    ],
    [
      'opened by the task manager, its session active once though it recorded no turn',
      host([[listed('dev.bob.task-7', { lastTurnAt: '2026-09-26T06:00:00.000Z' })]], { opened: ['dev.bob.task-7'] }),
      'it is already in use',
    ],
    [
      "another agent's thread of that title is not Bob's",
      host([[listed('dev.ann.task-7', { agent: { nodeId: 'agent_ann' } })]], { opened: ['dev.ann.task-7'] }),
      'its name differs only in case or punctuation',
    ],
    [
      'a title of the same address',
      host([[listed('dev.bob.task-7', { title: 'task 7' })]], { opened: ['dev.bob.task-7'] }),
      'its name differs only in case or punctuation',
    ],
    [
      'past the pages read',
      host(
        Array.from({ length: 11 }, (_, i) => [listed(`dev.bob.${i}`, { title: `T${i}` })]),
        { opened: ['dev.bob.task-7'] },
      ),
      'the chat has too many threads for the task manager to find it',
    ],
    ['a host without the listing', { usage: async () => ({ turns: [], busy: false }) }, "this host can't show"],
  ]
  for (const [name, chats, why] of cases) {
    await assert.rejects(
      openTaskThread(chats, PLACE, takenStart),
      (error: Error) => {
        assert.ok(error instanceof TaskThreadTaken, name)
        assert.ok(
          error.message.startsWith(`Bob already has a thread named "TASK-7" in "Dev" (${why}`),
          `${name}: ${error.message}`,
        )
        assert.ok(error.message.endsWith('): rename or delete that thread'), name)
        return true
      },
      name,
    )
  }
})

test('any other refusal of the start is thrown as it is, and the title is tried once', async () => {
  const tried: string[] = []
  const chats = host([[listed('dev.bob.task-7')]], { opened: ['dev.bob.task-7'] })
  await assert.rejects(
    openTaskThread(chats, PLACE, async (t) => {
      tried.push(t)
      throw new Error('(SSH) Channel open failure')
    }),
    /Channel open failure/,
  )
  assert.deepEqual([tried, chats.asked], [['TASK-7'], []])
})

test("a usage read failing for any reason but reach is thrown, not read as someone else's thread", async () => {
  const chats: TakenTitleChecker = {
    activity: async () => ({ threads: [listed('dev.bob.task-7')], nextCursor: null }),
    usage: async () => {
      throw new Error('database is locked')
    },
  }
  await assert.rejects(openTaskThread(chats, PLACE, takenStart), /database is locked/)
})

test('a recorded thread is unarchived only when the host says it is archived', async () => {
  const unarchived: string[] = []
  const chats = {
    thread: async (ref: string) => ({ archived: ref === 'dev.archived' }),
    unarchive: async (ref: string) => {
      unarchived.push(ref)
    },
  }
  assert.equal(await reopenTaskThread(chats, 'dev.live'), true)
  assert.equal(await reopenTaskThread(chats, 'dev.archived'), true)
  assert.deepEqual(unarchived, ['dev.archived'])
})

test('a host that cannot say whether a thread is archived has it unarchived every time', async () => {
  const unarchived: string[] = []
  const reopened = await reopenTaskThread(
    {
      unarchive: async (ref) => {
        unarchived.push(ref)
      },
    },
    'dev.live',
  )
  assert.deepEqual([reopened, unarchived], [true, ['dev.live']])
})

test('a thread the host refuses as unreachable is not reopened; any other failure is thrown', async () => {
  const refusing = (message: string) => ({
    thread: async () => {
      throw new Error(message)
    },
  })
  assert.equal(await reopenTaskThread(refusing('Not available'), 'dev.gone'), false)
  await assert.rejects(reopenTaskThread(refusing('database is locked'), 'dev.t1'), /database is locked/)
})
