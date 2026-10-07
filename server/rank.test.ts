import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rankBetween } from './rank.ts'

test('rankBetween orders between bounds, open on either side', () => {
  const mid = rankBetween(null, null)
  const after = rankBetween(mid, null)
  const before = rankBetween(null, mid)
  assert.ok(before < mid && mid < after)
  const between = rankBetween(before, mid)
  assert.ok(before < between && between < mid)
})

test('repeated inserts at the same spot stay ordered', () => {
  let lower = rankBetween(null, null)
  const upper = rankBetween(lower, null)
  const keys: string[] = []
  for (let i = 0; i < 200; i++) {
    const key = rankBetween(lower, upper)
    assert.ok(lower < key && key < upper, `${lower} < ${key} < ${upper}`)
    keys.push(key)
    lower = key
  }
  let head = rankBetween(null, null)
  for (let i = 0; i < 200; i++) {
    const key = rankBetween(null, head)
    assert.ok(key < head)
    head = key
  }
  assert.ok(keys.every((key) => !key.endsWith('0')))
})

test('rankBetween refuses inverted or malformed bounds', () => {
  assert.throws(() => rankBetween('b', 'a'))
  assert.throws(() => rankBetween('a', 'a'))
  assert.throws(() => rankBetween('a0', null))
})

test('evenRanks are ascending, fixed-width and never end in the zero digit', async () => {
  const { evenRanks } = await import('./rank.ts')
  for (const count of [0, 1, 5, 61, 62, 500, 4000]) {
    const keys = evenRanks(count)
    assert.equal(keys.length, count)
    for (let i = 1; i < keys.length; i++) {
      assert.ok(keys[i - 1] < keys[i], `${keys[i - 1]} < ${keys[i]}`)
    }
    assert.ok(keys.every((key) => !key.endsWith('0') && key.length === keys[0].length))
    if (count) {
      rankBetween(null, keys[0])
      rankBetween(keys.at(-1) as string, null)
    }
  }
})
