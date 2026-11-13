import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ActivityEntry } from '../shared/types'
import { textsByStamp, textsMissing, textsWanted, withActivityTexts } from '../src/pages/activity-texts'

const actor = { kind: 'agent' as const, name: 'Bob' }
const edit = (id: number, at: string): ActivityEntry => ({
  id,
  actor,
  kind: 'field',
  field: 'description',
  from: null,
  to: null,
  textsAvailable: true,
  at,
})
const status: ActivityEntry = { id: 2, actor, kind: 'field', field: 'status', from: 'To Do', to: 'Done', at: 'T2' }
// A description edit stored without its texts: nothing to fetch for it.
const bare: ActivityEntry = { ...edit(4, 'T4'), textsAvailable: undefined }

describe('the History tab’s description texts', () => {
  const entries = [edit(1, 'T1'), status, edit(3, 'T3'), bare]

  it('asks for the edits that have texts, by id and time', () => {
    assert.equal(textsWanted(entries), '1@T1,3@T3')
    assert.equal(textsWanted([status, bare]), '')
  })

  it('puts the fetched texts on the entries they were fetched for, and leaves the rest as they are', () => {
    const wanted = textsWanted(entries)
    const byStamp = textsByStamp(wanted, [
      { id: 1, from: 'a', to: 'b' },
      { id: 3, from: 'b', to: 'c' },
      // An entry the page did not ask for.
      { id: 9, from: 'x', to: 'y' },
    ])
    assert.deepEqual([...byStamp.keys()], ['1@T1', '3@T3'])
    assert.equal(textsMissing(wanted, byStamp), false)
    const merged = withActivityTexts(entries, byStamp)
    assert.deepEqual(
      merged.map((entry) => [entry.id, entry.from, entry.to]),
      [
        [1, 'a', 'b'],
        [2, 'To Do', 'Done'],
        [3, 'b', 'c'],
        [4, null, null],
      ],
    )
  })

  it('fetches again for an edit folded into its entry since, and shows no stale texts meanwhile', () => {
    const byStamp = textsByStamp(textsWanted(entries), [
      { id: 1, from: 'a', to: 'b' },
      { id: 3, from: 'b', to: 'c' },
    ])
    // Entry 3 took a later edit: same id, later time, new text on the server.
    const folded = [edit(1, 'T1'), status, edit(3, 'T5'), bare]
    assert.equal(textsMissing(textsWanted(folded), byStamp), true)
    assert.deepEqual(
      withActivityTexts(folded, byStamp).map((entry) => [entry.id, entry.from, entry.to]),
      [
        [1, 'a', 'b'],
        [2, 'To Do', 'Done'],
        [3, null, null],
        [4, null, null],
      ],
    )
  })

  it('needs no fetch when no entry has texts', () => {
    assert.equal(textsMissing('', new Map()), false)
  })
})
