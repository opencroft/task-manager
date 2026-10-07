import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readTaskKeyQuery } from '../src/components/ui/navigation/task-key-query'

test('a key reads the same however it was copied', () => {
  for (const query of [
    'TASK-7',
    'task-7',
    ' TASK-7 ',
    'TASK\u{2011}7', // non-breaking hyphen
    'TASK\u{2013}7', // en dash
    'TASK\u{2212}7', // minus sign
    'TASK\u{FF0D}7', // full-width hyphen
    'TASK-7:',
    'TASK-7.',
    '(TASK-7)',
    '[TASK-7]',
    '`TASK-7`',
    '"TASK-7",',
    'TASK 7',
    'TASK - 7',
  ]) {
    assert.deepEqual(readTaskKeyQuery(query), { project: 'TASK', number: 7 }, JSON.stringify(query))
  }
})

test('a number alone, with or without #, names a task of no particular project', () => {
  for (const query of ['7', '#7', '#7:', '(#7)']) {
    assert.deepEqual(readTaskKeyQuery(query), { project: null, number: 7 }, JSON.stringify(query))
  }
})

test('other text is not a key', () => {
  for (const query of ['', 'login', 'fix login', 'TASK-', 'TASK-7 login', 'TASK-7a', '##7', '7 8', 'TASK 7 8']) {
    assert.equal(readTaskKeyQuery(query), null, JSON.stringify(query))
  }
})
