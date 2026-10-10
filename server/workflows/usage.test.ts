import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attribute, spentOf, sumUsage, type ThreadUsage } from './usage.ts'

const T0 = '2026-09-26T10:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString()
const turn = (minutes: number, total: number, usd: number | null = null): ThreadUsage['turns'][number] => ({
  endedAt: at(minutes),
  tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  cost: usd === null ? null : { amount: usd, currency: 'USD' },
})
const totals = (result: ReturnType<typeof attribute>) => [
  result.state,
  result.usage.turns,
  result.usage.tokens.total,
  result.until,
]

test('a round counts the turns that ended inside it, and its finishing turn, which ends after it did', () => {
  // The round ran 0..10; the agent finished it from inside the turn that ended at 11.
  const usage: ThreadUsage = {
    turns: [turn(-5, 1), turn(4, 100), turn(9, 200), turn(11, 50), turn(30, 7)],
    busy: false,
  }
  assert.deepEqual(totals(attribute(usage, { startedAt: at(0), endedAt: at(10), claim: null })), [
    'settled',
    3,
    350,
    at(11),
  ])
})

test('a round that ended mid-turn is pending until that turn has a record, then settles', () => {
  const window = { startedAt: at(0), endedAt: at(10), claim: null }
  const midTurn: ThreadUsage = { turns: [turn(4, 100)], busy: true }
  assert.deepEqual(totals(attribute(midTurn, window)), ['pending', 1, 100, null])
  const ended: ThreadUsage = { turns: [turn(4, 100), turn(12, 40)], busy: false }
  assert.deepEqual(totals(attribute(ended, window)), ['settled', 2, 140, at(12)])
})

test('an idle session at the round end has nothing still to come: the round is settled as it is, up to its own end', () => {
  // A person moved the card while the agent sat idle.
  const usage: ThreadUsage = { turns: [turn(4, 100)], busy: false }
  assert.deepEqual(totals(attribute(usage, { startedAt: at(0), endedAt: at(10), claim: null })), [
    'settled',
    1,
    100,
    at(10),
  ])
})

test("the next round on a thread, whatever its step, starts after the previous round's finishing turn", () => {
  // Round 1 ran 0..10 and finished from inside the turn that ended at 11. The
  // next step's round began at 10 in the same thread, its message queued
  // behind that turn.
  const usage: ThreadUsage = { turns: [turn(5, 100), turn(11, 10), turn(25, 300), turn(40, 30)], busy: true }
  const first = attribute(usage, { startedAt: at(0), endedAt: at(10), claim: null })
  assert.deepEqual(totals(first), ['settled', 2, 110, at(11)])
  assert.ok(first.until)
  assert.deepEqual(
    totals(attribute(usage, { startedAt: at(10), endedAt: null, claim: { until: first.until, by: 'Development' } })),
    ['live', 2, 330, null],
  )
  // Without the previous round's end the finishing turn would be counted twice.
  assert.deepEqual(totals(attribute(usage, { startedAt: at(10), endedAt: null, claim: null })), ['live', 3, 340, null])
})

test('a round that ended inside a turn an earlier round counted is shared, with no figures, naming that step', () => {
  // The earlier round claimed the turn that ended at 15; this round ran 5..10, inside it.
  const usage: ThreadUsage = { turns: [turn(15, 400)], busy: false }
  const shared = attribute(usage, { startedAt: at(5), endedAt: at(10), claim: { until: at(15), by: 'Development' } })
  assert.deepEqual([...totals(shared), shared.sharedWith], ['shared', 0, 0, at(15), 'Development'])
  // Busy or not, and with a later turn already recorded: the turn it would finish in is counted already.
  const busy = attribute(
    { turns: [turn(15, 400), turn(18, 70)], busy: true },
    { startedAt: at(5), endedAt: at(10), claim: { until: at(15), by: 'Development' } },
  )
  assert.deepEqual([...totals(busy), busy.sharedWith], ['shared', 0, 0, at(15), 'Development'])
  // A round that ended after the claim, with nothing of its own, is a real zero.
  const idle = attribute(usage, { startedAt: at(20), endedAt: at(25), claim: { until: at(15), by: 'Development' } })
  assert.deepEqual([...totals(idle), idle.sharedWith], ['settled', 0, 0, at(25), null])
})

test('cost adds up per currency and never across currencies', () => {
  const summed = sumUsage([
    {
      turns: 1,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: [{ amount: 0.25, currency: 'USD' }],
    },
    {
      turns: 2,
      tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
      cost: [{ amount: 1, currency: 'EUR' }],
    },
    {
      turns: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: [{ amount: 0.5, currency: 'USD' }],
    },
  ])
  assert.deepEqual(summed, {
    turns: 4,
    tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 },
    cost: [
      { amount: 0.75, currency: 'USD' },
      { amount: 1, currency: 'EUR' },
    ],
  })
})

test("spent is every round's wall time, and the usage of the rounds that have any", () => {
  const usage = { turns: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: [] }
  const base = {
    roundNo: 1,
    worker: null,
    startedAt: T0,
    endedAt: T0,
    endedBy: 'transition' as const,
    outcome: null,
    transition: null,
    gate: null,
    decisions: [],
    sessionOptions: null,
    contextTokens: null,
    compaction: null,
  }
  assert.deepEqual(
    spentOf([
      { ...base, timeMs: 1_000, usage: { ...usage, state: 'settled' } },
      { ...base, timeMs: 2_000, usage: { ...usage, state: 'pending' } },
      { ...base, timeMs: 4_000, usage: null },
    ]),
    { timeMs: 7_000, usage: sumUsage([usage, usage]), pending: 1 },
  )
  assert.deepEqual(spentOf([{ ...base, timeMs: 4_000, usage: null }]), { timeMs: 4_000, usage: null, pending: 0 })
  // A shared round adds its time, no figures, and the step it shared a turn with.
  assert.deepEqual(
    spentOf([
      { ...base, timeMs: 1_000, usage: { ...usage, state: 'settled' } },
      {
        ...base,
        timeMs: 2_000,
        usage: {
          ...usage,
          tokens: { ...usage.tokens, total: 0 },
          turns: 0,
          state: 'shared',
          sharedWith: 'Development',
        },
      },
    ]),
    { timeMs: 3_000, usage: sumUsage([usage]), pending: 0, sharedWith: ['Development'] },
  )
})
