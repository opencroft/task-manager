import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import { inputSchemas, withParamChecks } from './action-params.ts'

/** The real schemas of `ids`, each wrapped around a handler that records what reached it. */
function checked(...ids: string[]) {
  const reached: Array<[string, Record<string, unknown>]> = []
  const handlers: Record<string, AppActionHandler> = Object.fromEntries(
    ids.map((id) => [id, (_ctx: AppActionContext, params: Record<string, unknown>) => reached.push([id, params])]),
  )
  const actions = withParamChecks(handlers)
  const call = (id: string, params: Record<string, unknown>) => actions[id]!({} as AppActionContext, params)
  return { call, reached }
}

test('a guessed parameter name is refused with what is missing, the closest real names and every parameter', () => {
  const { call, reached } = checked('task_link')
  assert.throws(() => call('task_link', { key: 'TASK-7', form: 'TASK-8' }), {
    name: 'TaskError',
    message:
      'Missing parameters "from", "to". "key" isn\'t a parameter of task_link. ' +
      '"form" isn\'t a parameter of task_link; did you mean "from"? ' +
      'Parameters of task_link: detail, from (required), to (required), type.',
  })
  assert.deepEqual(reached, [], 'the handler never ran')
})

test('a missing required parameter is named on its own', () => {
  const { call } = checked('task_change_status')
  assert.throws(() => call('task_change_status', { key: 'TASK-1', comment: 'Done' }), {
    message: 'Missing parameter "status". Parameters of task_change_status: detail, key (required), status (required), comment.',
  })
  assert.throws(
    () => call('task_change_status', { key: 'TASK-1', status: undefined }),
    { message: /^Missing parameter "status"\./ },
    'undefined counts as not given',
  )
})

test('an unknown parameter is named, with a partial match offered first', () => {
  const { call } = checked('task_list', 'status_list')
  const listParameters = Object.keys(inputSchemas.task_list?.properties ?? {}).join(', ')
  assert.throws(() => call('task_list', { statuses: ['Done'] }), {
    message: `"statuses" isn't a parameter of task_list; did you mean "status"? Parameters of task_list: ${listParameters}.`,
  })
  assert.throws(() => call('status_list', { all: true }), {
    message: '"all" isn\'t a parameter of status_list. Parameters of status_list: none.',
  })
})

test('a wrong type is named with the types allowed, for a value and for a list item', () => {
  const { call } = checked('task_list', 'task_update')
  const listParameters = Object.keys(inputSchemas.task_list?.properties ?? {}).join(', ')
  assert.throws(() => call('task_list', { limit: '10', scheduled: 'yes', status: 'Done' }), {
    message:
      '"limit" must be a number, not a string. "scheduled" must be a boolean, not a string. ' +
      `"status" must be an array or an object, not a string. Parameters of task_list: ${listParameters}.`,
  })
  assert.throws(() => call('task_list', { status: ['Done', true] }), {
    message: `"status" must be a list of strings or numbers; item 2 is a boolean. Parameters of task_list: ${listParameters}.`,
  })
  assert.throws(() => call('task_update', { key: 'TASK-1', status: null }), {
    message: /^"status" must be a string or a number, not null\. /,
  })
})

test('valid parameters reach the handler unchanged, including null where the schema allows it', () => {
  const { call, reached } = checked('task_update', 'task_change_status', 'status_list')
  call('task_update', { key: 'TASK-1', assignee: null, startDate: null, endDate: null })
  call('task_change_status', { key: 'TASK-1', status: 3 })
  call('status_list', {})
  assert.deepEqual(reached, [
    ['task_update', { key: 'TASK-1', assignee: null, startDate: null, endDate: null }],
    ['task_change_status', { key: 'TASK-1', status: 3 }],
    ['status_list', {}],
  ])
})

test('an integer is a whole number, and a whole number is a number too', () => {
  const { call, reached } = checked('import_openproject_sync', 'task_list')
  call('import_openproject_sync', { minutes: 15 })
  call('import_openproject_sync', { minutes: null })
  call('task_list', { limit: 10 })
  assert.throws(() => call('import_openproject_sync', { minutes: 7.5 }), { message: /^"minutes" must be an integer or null, not a number\. / })
  assert.throws(() => call('import_openproject_sync', { minutes: '15' }), { message: /^"minutes" must be an integer or null, not a string\. / })
  assert.deepEqual(reached, [
    ['import_openproject_sync', { minutes: 15 }],
    ['import_openproject_sync', { minutes: null }],
    ['task_list', { limit: 10 }],
  ])
})

test('every declared action has a schema whose required parameters it declares, and an undeclared one fails the load', () => {
  const ids = Object.keys(inputSchemas)
  assert.ok(ids.includes('task_link') && ids.includes('workflow_start'), 'the schemas were read from the manifest')
  for (const id of ids) {
    const schema = inputSchemas[id]!
    for (const name of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, name), `${id} requires "${name}" but does not declare it`)
    }
  }
  // Every manifest schema names only types the checks know: wrapping them all loads.
  assert.equal(Object.keys(withParamChecks(Object.fromEntries(ids.map((id) => [id, () => null])))).length, ids.length)
  assert.throws(() => withParamChecks({ task_frobnicate: () => null }), { message: 'Action task_frobnicate has no input schema in extension.json' })
  assert.throws(() => withParamChecks({ task_frobnicate: () => null }, { task_frobnicate: { properties: { count: { type: 'int' } } } }), {
    message: /^Action task_frobnicate: parameter "count" has type "int"; the checks know "string", "number", "integer"/,
  })
})
