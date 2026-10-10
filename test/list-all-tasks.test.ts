import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TASK_LIST_MAX_LIMIT, type TaskListInput, type TaskListResult, type TaskSummary } from '../shared/types'
import type { TasksApi } from '../src/lib/api'
import { listAllTasks } from '../src/lib/task-list'

/** A client over `count` tasks that records the offset of every page asked for, in call order, grouped by round. */
function fakeApi(count: { value: number }) {
  const rounds: number[][] = []
  let open = 0
  const api = {
    task_list: async (input: TaskListInput): Promise<TaskListResult> => {
      // Calls made while none of the previous round has answered yet belong to the same round.
      if (open === 0) {
        rounds.push([])
      }
      open++
      rounds[rounds.length - 1].push(input.offset ?? 0)
      await Promise.resolve()
      open--
      const offset = input.offset ?? 0
      const end = Math.min(count.value, offset + (input.limit ?? 200))
      const tasks = Array.from(
        { length: Math.max(0, end - offset) },
        (_, i) => ({ key: `T-${offset + i + 1}` }) as TaskSummary,
      )
      return { tasks, total: count.value }
    },
  } as unknown as TasksApi
  return { api, rounds }
}

describe('listAllTasks', () => {
  it('asks for one page first, then for every page the last answer said there are, all in one round', async () => {
    const count = { value: 2 * TASK_LIST_MAX_LIMIT + 5 }
    const { api, rounds } = fakeApi(count)

    const first = await listAllTasks(api, { status: [1] })
    assert.equal(first.length, count.value)
    assert.deepEqual(rounds, [[0], [TASK_LIST_MAX_LIMIT, 2 * TASK_LIST_MAX_LIMIT]])

    rounds.length = 0
    const again = await listAllTasks(api, { status: [1] })
    assert.deepEqual(
      again.map((task) => task.key),
      first.map((task) => task.key),
    )
    assert.deepEqual(rounds, [[0, TASK_LIST_MAX_LIMIT, 2 * TASK_LIST_MAX_LIMIT]], 'a known total is one round trip')
  })

  it('fetches only the pages past the known ones when the project grew, and every task exactly once', async () => {
    const count = { value: TASK_LIST_MAX_LIMIT + 1 }
    const { api, rounds } = fakeApi(count)
    await listAllTasks(api)

    count.value = 3 * TASK_LIST_MAX_LIMIT + 1
    rounds.length = 0
    const grown = await listAllTasks(api)
    assert.deepEqual(rounds, [
      [0, TASK_LIST_MAX_LIMIT],
      [2 * TASK_LIST_MAX_LIMIT, 3 * TASK_LIST_MAX_LIMIT],
    ])
    assert.equal(new Set(grown.map((task) => task.key)).size, count.value)
  })

  it('returns what is there when the project shrank below a known page', async () => {
    const count = { value: 2 * TASK_LIST_MAX_LIMIT }
    const { api } = fakeApi(count)
    await listAllTasks(api)
    count.value = 10
    assert.equal((await listAllTasks(api)).length, 10)
  })

  it('keeps each query’s total apart: a filtered list does not size the unfiltered one', async () => {
    const count = { value: 2 * TASK_LIST_MAX_LIMIT }
    const { api, rounds } = fakeApi(count)
    await listAllTasks(api)
    rounds.length = 0
    await listAllTasks(api, { query: 'never seen' })
    assert.deepEqual(rounds[0], [0], 'an unknown query starts with one page')
  })
})
