import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inlineCreateAction } from '../src/components/ui/tasks/task-inline-create'
import { milestoneSpanLabel } from '../src/components/ui/timeline/timeline-milestone-row'

describe('inline create field', () => {
  it('creates what was typed on Enter and on leaving the field', () => {
    assert.equal(inlineCreateAction('enter', 'Draft notes'), 'create')
    assert.equal(inlineCreateAction('leave', 'Draft notes'), 'create')
  })

  it('discards what was typed on Escape and on the ×', () => {
    assert.equal(inlineCreateAction('escape', 'Draft notes'), 'close')
    assert.equal(inlineCreateAction('cancel', 'Draft notes'), 'close')
  })

  it('creates nothing from blank text: Enter waits, leaving closes', () => {
    assert.equal(inlineCreateAction('enter', '   '), 'none')
    assert.equal(inlineCreateAction('leave', ''), 'close')
  })
})

describe('timeline milestone row', () => {
  it('names the span, open at either end, or its absence', () => {
    assert.equal(
      milestoneSpanLabel({ name: 'Beta', startDate: '2026-12-01', targetDate: '2026-12-20' }),
      'Dec 1 – Dec 20',
    )
    assert.equal(milestoneSpanLabel({ name: 'Beta', startDate: '2026-12-01' }), 'from Dec 1')
    assert.equal(milestoneSpanLabel({ name: 'Beta', targetDate: '2026-12-20' }), 'until Dec 20')
    assert.equal(milestoneSpanLabel({ name: 'Beta' }), 'no dates')
  })
})
