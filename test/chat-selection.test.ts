import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chatSelection } from '../src/chat/chat-selection'

const APP = 'acme.tasks'

function taskItem(key: string) {
  return { kind: 'app', app: APP, action: 'task_get', params: { key }, name: key, noun: ['task', 'tasks'] }
}

test('a page with nothing open or picked is the page, read with task_list', () => {
  assert.deepEqual(chatSelection(APP, { page: 'Board', path: '/board', taskKey: null }, []), {
    items: [{ kind: 'app', app: APP, action: 'task_list', params: {}, name: 'Board', noun: ['page', 'pages'] }],
  })
})

test('a page without a sidebar name is named by its path', () => {
  const [item] = chatSelection(APP, { page: null, path: '/task', taskKey: null }, []).items
  assert.equal(item.kind === 'app' && item.name, '/task')
})

test('the open task is one task_get item', () => {
  assert.deepEqual(chatSelection(APP, { page: null, path: '/task/DEMO-12', taskKey: 'DEMO-12' }, []), {
    items: [taskItem('DEMO-12')],
  })
})

test('picked tasks are one task_get item each, in the order picked', () => {
  const selection = chatSelection(APP, { page: 'Tasks', path: '/tasks', taskKey: null }, ['DEMO-3', 'DEMO-1', 'DEMO-2'])
  assert.deepEqual(selection, { items: [taskItem('DEMO-3'), taskItem('DEMO-1'), taskItem('DEMO-2')] })
})

test('picked tasks take the place of a task open in the peek', () => {
  const selection = chatSelection(APP, { page: 'Board', path: '/board', taskKey: 'DEMO-9' }, ['DEMO-1', 'DEMO-2'])
  assert.deepEqual(selection, { items: [taskItem('DEMO-1'), taskItem('DEMO-2')] })
})

test('the selection names no place, so the quote takes the App name', () => {
  assert.equal(Object.hasOwn(chatSelection(APP, { page: 'Board', path: '/board', taskKey: null }, []), 'place'), false)
})
