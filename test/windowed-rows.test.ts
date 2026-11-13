import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { rowOffsets, windowRange, windowSlice } from '../src/components/ui/tasks/use-windowed-rows'
import { isSidewaysWheel } from '../src/components/ui/timeline/use-timeline-zoom'

describe('windowed rows', () => {
  it('keeps the last row rendered when a row is added after it', () => {
    // Five 10px rows, all in view, no overscan: the window covers the whole list.
    const range = windowRange(rowOffsets(5, 10), { top: 0, height: 100 }, 0)
    assert.deepEqual(windowSlice(range, 5), { start: 0, end: 5 })
    // A sixth row arrives before the next measure: the old last row (index 4) and the new one both render.
    assert.deepEqual(windowSlice(range, 6), { start: 0, end: 6 })
  })

  it('renders only the rows in view plus the overscan in a long list', () => {
    // A hundred 10px rows, a 50px view scrolled to row 20, two rows of overscan.
    const range = windowRange(rowOffsets(100, 10), { top: 200, height: 50 }, 2)
    assert.deepEqual(windowSlice(range, 100), { start: 18, end: 28 })
    // Rows added at the far end change nothing in view.
    assert.deepEqual(windowSlice(range, 101), { start: 18, end: 28 })
  })
})

describe('timeline wheel', () => {
  const wheel = { deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false }

  it('takes a sideways swipe and Shift + vertical wheel for a horizontal scroll', () => {
    assert.equal(isSidewaysWheel({ ...wheel, deltaX: 300 }), true)
    assert.equal(isSidewaysWheel({ ...wheel, deltaY: 400, shiftKey: true }), true)
  })

  it('leaves a plain vertical wheel and a zoom alone', () => {
    assert.equal(isSidewaysWheel({ ...wheel, deltaY: 400 }), false)
    assert.equal(isSidewaysWheel({ ...wheel, deltaY: 400, shiftKey: true, ctrlKey: true }), false)
    assert.equal(isSidewaysWheel({ ...wheel, deltaX: 300, metaKey: true }), false)
  })
})
