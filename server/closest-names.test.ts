import assert from 'node:assert/strict'
import { test } from 'node:test'

import { closestNames, didYouMean } from './closest-names.ts'

const agents = ['Bot (QA)', 'Bot (Dev)', 'Bot (Docs)', 'Carol', 'Alice']

test('a partial name finds every name containing it, ignoring case and punctuation', () => {
  assert.deepEqual(closestNames('bOT', agents), ['Bot (QA)', 'Bot (Dev)', 'Bot (Docs)'])
  assert.deepEqual(closestNames('bot qa', agents), ['Bot (QA)'])
})

test('a typo is offered after partial matches: one edit, two from eight characters, a swap counting as one', () => {
  const statuses = ['To Do', 'In Progress', 'In Review', 'Done']
  assert.deepEqual(closestNames('Craol', agents), ['Carol'])
  assert.deepEqual(closestNames('In Reveiw', statuses), ['In Review'])
  assert.deepEqual(closestNames('In Progess', statuses), ['In Progress'])
  assert.deepEqual(closestNames('Doing', statuses), [], 'two edits from a short name is a different word, not a typo')
  assert.deepEqual(closestNames('Zebra', agents), [])
  assert.deepEqual(closestNames('  ', agents), [])
})

test('a wider allowance reaches names two edits from a short word', () => {
  assert.deepEqual(closestNames('blocks', ['blocker', 'blocked']), [])
  assert.deepEqual(closestNames('blocks', ['blocker', 'blocked'], 2), ['blocker', 'blocked'])
})

test('didYouMean reads as a sentence to append, or is empty', () => {
  assert.equal(didYouMean('Craol', agents), ' Did you mean "Carol"?')
  assert.equal(didYouMean('Zebra', agents), '')
})
