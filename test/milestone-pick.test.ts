import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { defaultMilestone, pickMilestone } from '../src/pages/milestone-pick'

// Open milestones in the listing order: by target date, undated last.
const alpha = { id: 1, name: 'Alpha', targetDate: '2026-11-01' }
const beta = { id: 2, name: 'Beta', targetDate: '2026-12-20' }
const gamma = { id: 3, name: 'Gamma', targetDate: null }
const open = [alpha, beta, gamma]
const today = '2026-11-13'

describe('the milestone the Timeline opens on', () => {
  it('defaults to the earliest target on or after today, else the first open one, else none', () => {
    assert.equal(defaultMilestone(open, today), beta)
    assert.equal(defaultMilestone(open, '2026-12-20'), beta)
    assert.equal(defaultMilestone(open, '2026-12-21'), alpha)
    assert.equal(defaultMilestone([gamma], today), gamma)
    assert.equal(defaultMilestone([], today), null)
  })

  it('shows the milestone the URL names, ignoring case, and rewrites the URL only to fix the case', () => {
    assert.deepEqual(pickMilestone(open, 'Gamma', '1', today), { milestone: gamma, rewrite: false })
    assert.deepEqual(pickMilestone(open, 'gamma', '1', today), { milestone: gamma, rewrite: true })
  })

  it('falls back to the remembered one, then the default, when the URL names none or one not open', () => {
    assert.deepEqual(pickMilestone(open, null, '1', today), { milestone: alpha, rewrite: true })
    assert.deepEqual(pickMilestone(open, null, null, today), { milestone: beta, rewrite: true })
    assert.deepEqual(pickMilestone(open, 'Renamed away', '9', today), { milestone: beta, rewrite: true })
  })

  it('shows none in a project with no open milestone, dropping a name left in the URL', () => {
    assert.deepEqual(pickMilestone([], 'Beta', '2', today), { milestone: null, rewrite: true })
    assert.deepEqual(pickMilestone([], null, null, today), { milestone: null, rewrite: false })
  })
})
