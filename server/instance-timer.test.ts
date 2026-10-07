import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

import { instanceTimer } from './instance-timer.ts'

test('one timer per instance: a run in flight is shared, the newest tick is the one that runs, and a stopped one runs no more', async () => {
  const intervals = mock.method(globalThis, 'setInterval')
  const timer = instanceTimer('__taskPipelinesTimerTest', 3600)
  try {
    const seen: string[] = []
    let release = () => {}
    timer.setTick((target) => {
      seen.push(`old:${target.params.key ?? ''}`)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    timer.start({ instanceId: 'a', dataDir: '', params: {} })
    // A second start updates what the timer runs with instead of adding another.
    timer.start({ instanceId: 'a', dataDir: '', params: { key: 'X' } })
    assert.equal(intervals.mock.callCount(), 1)

    const first = timer.runNow('a')
    const second = timer.runNow('a')
    assert.equal(first, second)
    release()
    await first
    assert.deepEqual(seen, ['old:X'])

    timer.setTick(async (target) => {
      seen.push(`new:${target.params.key}`)
    })
    await timer.runNow('a')
    assert.deepEqual(seen, ['old:X', 'new:X'])

    timer.stop('a')
    await timer.runNow('a')
    assert.deepEqual(seen, ['old:X', 'new:X'])
  } finally {
    timer.stop('a')
    intervals.mock.restore()
    delete (globalThis as Record<string, unknown>).__taskPipelinesTimerTest
  }
})
