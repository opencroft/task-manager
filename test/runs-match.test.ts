import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runsMatchOf, runsMatchParams } from '../src/workflows/runs-match'

const queryOf = (params: Record<string, string | null>) =>
  new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== null))

test('a match written to the address reads back as the same match', () => {
  const matches = [
    { range: '7d', step: 'step-1', exit: 'sent_back', transition: 'Changes requested' },
    { range: 'all', step: 'step-2', rounds: 4 },
    { range: '90d', step: 'step-3', couldntStart: 'not_in_chat' },
    { range: '30d', step: 'step-4', exit: 'open' },
  ] as const
  for (const match of matches) {
    assert.deepEqual(runsMatchOf(queryOf(runsMatchParams(match))), match)
  }
})

test('writing a match clears what an earlier one set, and null clears them all', () => {
  assert.deepEqual(runsMatchParams({ range: '30d', step: 'step-1', rounds: 2 }), {
    range: '30d',
    step: 'step-1',
    exit: null,
    transition: null,
    rounds: '2',
    couldntStart: null,
  })
  assert.deepEqual(runsMatchParams(null), {
    range: null,
    step: null,
    exit: null,
    transition: null,
    rounds: null,
    couldntStart: null,
  })
})

test('an address without a step carries no match, whatever else it has', () => {
  assert.equal(runsMatchOf(new URLSearchParams('tab=runs&range=7d&exit=sent_back')), null)
})

test('values the page does not know are left out, and a missing range is the 30-day default', () => {
  const query = new URLSearchParams('step=step-1&exit=gone&rounds=9&couldntStart=elsewhere&transition=Back')
  assert.deepEqual(runsMatchOf(query), { range: '30d', step: 'step-1' })
})

test('a transition narrows only a sent-back match', () => {
  assert.deepEqual(runsMatchOf(new URLSearchParams('step=step-1&exit=moved_on&transition=Approved')), {
    range: '30d',
    step: 'step-1',
    exit: 'moved_on',
  })
})
