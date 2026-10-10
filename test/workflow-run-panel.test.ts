import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compactionText } from '../src/components/ui/workflows/workflow-run-panel'

const failed = { outcome: 'failed', threshold: 200_000, before: 350_000, after: null } as const

test('a compaction that failed on its own reads as followed by the message', () => {
  assert.equal(
    compactionText({ ...failed, error: 'That agent is no longer a member of this group chat' }, true),
    'Compaction failed: That agent is no longer a member of this group chat; the message was sent anyway',
  )
})

test('a compaction a restart cut off reads as not followed by the message, which restarting the step sends', () => {
  const restarted = { ...failed, error: 'The server restarted while the session was compacting', unsent: true }
  assert.equal(
    compactionText(restarted, true),
    'Compaction failed: The server restarted while the session was compacting; the round’s message was not sent; restart the step to send it',
  )
  assert.equal(
    compactionText(restarted, false),
    'Compaction failed: The server restarted while the session was compacting; the round’s message was not sent',
    'a round that has ended offers no restart',
  )
})

test('a compaction followed by a session that could not be messaged says the message was not sent', () => {
  assert.equal(
    compactionText(
      { outcome: 'compacted', threshold: 200_000, before: 350_000, after: 20_000, error: null, unsent: true },
      true,
    ),
    'Session compacted before the round: 350k → 20k; the round’s message was not sent; restart the step to send it',
  )
  assert.equal(
    compactionText({ outcome: 'compacted', threshold: 200_000, before: 350_000, after: 20_000, error: null }, true),
    'Session compacted before the round: 350k → 20k',
  )
})
