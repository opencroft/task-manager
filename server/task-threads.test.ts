import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openTaskThread } from './task-threads.ts'

const taken = (title: string) =>
  Object.assign(new Error(`This agent already has a thread named "${title}" here`), { code: 'slug-taken' })

test('the thread opens under the task key alone when it is free', async () => {
  const tried: string[] = []
  const title = await openTaskThread('TASK-7', async (t) => {
    tried.push(t)
    return t
  })
  assert.equal(title, 'TASK-7')
  assert.deepEqual(tried, ['TASK-7'])
})

test('a taken title moves on to the next suffixed one', async () => {
  const tried: string[] = []
  const title = await openTaskThread('TASK-7', async (t) => {
    tried.push(t)
    if (t !== 'TASK-7 (task manager 2)') {
      throw taken(t)
    }
    return t
  })
  assert.equal(title, 'TASK-7 (task manager 2)')
  assert.deepEqual(tried, ['TASK-7', 'TASK-7 (task manager)', 'TASK-7 (task manager 2)'])
})

test('any other refusal is thrown at once, without trying another title', async () => {
  const tried: string[] = []
  await assert.rejects(
    openTaskThread('TASK-7', async (t) => {
      tried.push(t)
      throw new Error('Not available')
    }),
    /Not available/,
  )
  assert.deepEqual(tried, ['TASK-7'])
})

test('with every title taken, the last refusal is thrown', async () => {
  await assert.rejects(
    openTaskThread('TASK-7', async (t) => {
      throw taken(t)
    }),
    { code: 'slug-taken', message: 'This agent already has a thread named "TASK-7 (task manager 3)" here' },
  )
})
