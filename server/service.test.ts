import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, test } from 'node:test'

import type { Actor, TasksEvent } from '../shared/types.ts'
import { migrate } from './db.ts'
import { type StatusChangeEvent, statusHooks } from './hooks.ts'
import {
  type Scope,
  addComment,
  changeStatus,
  createStatus,
  createTask,
  deleteComment,
  deleteStatus,
  deleteTask,
  getTask,
  listAssignees,
  listAvatars,
  listLabels,
  listParents,
  listTasks,
  moveTask,
  reorderStatuses,
  updateComment,
  updateStatus,
  updateTask,
} from './service.ts'

interface TestScope extends Scope {
  events: Array<{ keys: string[]; kind: TasksEvent['kind'] }>
}

function makeScope(actor: Actor = { kind: 'agent', name: 'Carol' }): TestScope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // Every migration: task reads also return each task's blockers, from the dependencies' table.
  migrate(db)
  const events: TestScope['events'] = []
  return {
    db,
    instanceId: 'inst-1',
    projectKey: 'TASK',
    inv: { ctx: {} as never, actor },
    notify: (keys, kind) => events.push({ keys, kind }),
    agents: async () => [
      { id: 'agent_1', name: 'Bob' },
      { id: 'agent_2', name: 'Alice' },
    ],
    people: async () => [
      { id: 'user_ada', name: 'Ada Lovelace' },
      { id: 'user_grace', name: 'Grace Hopper' },
    ],
    events,
  }
}

let unsubscribe: Array<() => void> = []
beforeEach(() => {
  for (const off of unsubscribe) {
    off()
  }
  unsubscribe = []
})

test('create assigns sequential keys that are never reused', async () => {
  const s = makeScope()
  const a = (await createTask(s, { summary: 'First' })).result
  const b = (await createTask(s, { summary: 'Second' })).result
  assert.equal(a.key, 'TASK-1')
  assert.equal(b.key, 'TASK-2')
  deleteTask(s, { key: 'TASK-2' })
  const c = (await createTask(s, { summary: 'Third' })).result
  assert.equal(c.key, 'TASK-3')
  assert.equal(a.status.name, 'To Do')
  assert.equal(a.priority, 'medium')
  assert.equal(a.type, 'task')
  assert.deepEqual(a.reporter, { kind: 'agent', name: 'Carol' })
})

test('create validates summary, dates and references', async () => {
  const s = makeScope()
  await assert.rejects(createTask(s, { summary: '  ' }), /summary/)
  await assert.rejects(createTask(s, { summary: 'x', startDate: '2026-01-02' }), /both/)
  await assert.rejects(createTask(s, { summary: 'x', startDate: '2026-01-05', endDate: '2026-01-02' }), /before/)
  await assert.rejects(createTask(s, { summary: 'x', startDate: '2026-02-30', endDate: '2026-03-01' }), /real date/)
  await assert.rejects(createTask(s, { summary: 'x', parent: 'TASK-99' }), /No task TASK-99/)
  await assert.rejects(createTask(s, { summary: 'x', parent: 'OTHER-1' }), /belongs to project OTHER/)
  await assert.rejects(createTask(s, { summary: 'x', status: 'Nope' }), /No status "Nope"/)
})

test('a bare assignee name must be a known agent or person; a new person is named explicitly; list offers both', async () => {
  const s = makeScope({ kind: 'agent', name: 'Alice' })
  const a = (await createTask(s, { summary: 'a', assignee: 'bob' })).result
  assert.deepEqual(a.assignee, { kind: 'agent', id: 'agent_1', name: 'Bob' })
  await assert.rejects(
    createTask(s, { summary: 'typo', assignee: 'Bbo' }),
    /No agent or person "Bbo"\. Did you mean "Bob"\? Use assignee_list .* pass \{kind:"person", name\}/,
  )
  const mine = (await createTask(s, { summary: 'mine', assignee: 'me' })).result
  assert.deepEqual(mine.assignee, { kind: 'agent', id: 'agent_2', name: 'Alice' }, '"me" is the calling agent')
  assert.deepEqual(
    listTasks(s, { assignee: ['ME'] }).tasks.map((t) => t.key),
    [mine.key],
  )
  const b = (await createTask(s, { summary: 'b', assignee: { kind: 'person', name: 'Dave' } })).result
  assert.deepEqual(b.assignee, { kind: 'person', name: 'Dave' })
  const known = (await createTask(s, { summary: 'b2', assignee: 'dave' })).result
  assert.deepEqual(known.assignee, { kind: 'person', name: 'Dave' })
  await assert.rejects(createTask(s, { summary: 'c', assignee: { kind: 'agent', id: 'agent_x' } }), /No agent/)
  const options = await listAssignees(s)
  assert.deepEqual(
    options.map((o) => o.assignee.name),
    ['Alice', 'Bob', 'Ada Lovelace', 'Grace Hopper', 'Dave'],
  )
})

test('people come from the user directory: by id, by name or bare name, each carrying their user id', async () => {
  const s = makeScope({ kind: 'person', name: 'Grace Hopper' })
  const byId = (await createTask(s, { summary: 'a', assignee: { kind: 'person', id: 'user_ada' } })).result
  assert.deepEqual(byId.assignee, { kind: 'person', id: 'user_ada', name: 'Ada Lovelace' })
  const byName = (await createTask(s, { summary: 'b', assignee: { kind: 'person', name: 'ada lovelace' } })).result
  assert.deepEqual(byName.assignee, { kind: 'person', id: 'user_ada', name: 'Ada Lovelace' })
  const bare = (await createTask(s, { summary: 'c', assignee: 'grace hopper' })).result
  assert.deepEqual(bare.assignee, { kind: 'person', id: 'user_grace', name: 'Grace Hopper' })
  await assert.rejects(
    createTask(s, { summary: 'd', assignee: { kind: 'person', id: 'user_nobody' } }),
    /No person with id user_nobody\. Use assignee_list/,
  )

  // Changing the person to a namesake outside the directory is a change: identity is the id.
  const updated = await updateTask(s, { key: byId.key, assignee: { kind: 'person', name: 'Someone Else' } })
  assert.deepEqual(updated.result.assignee, { kind: 'person', name: 'Someone Else' })
  assert.deepEqual(
    (await updateTask(s, { key: bare.key, assignee: { kind: 'person', id: 'user_grace' } })).result.activity.length,
    bare.activity.length,
    're-assigning the same person records nothing',
  )

  // The reporter is the directory person who called, listed once — not again as a free-text name.
  assert.deepEqual(byId.reporter, { kind: 'person', name: 'Grace Hopper' })
  const people = (await listAssignees(s)).filter((o) => o.assignee.kind === 'person').map((o) => o.assignee)
  assert.deepEqual(people, [
    { kind: 'person', id: 'user_ada', name: 'Ada Lovelace' },
    { kind: 'person', id: 'user_grace', name: 'Grace Hopper' },
    { kind: 'person', name: 'Someone Else' },
  ])
})

test('avatars list every agent and directory person with their picture or null; assignee options carry none', async () => {
  const s = makeScope()
  s.agents = async () => [
    { id: 'agent_1', name: 'Bob', avatarUrl: 'data:image/png;base64,AAAA' },
    { id: 'agent_2', name: 'Alice', avatarUrl: null },
  ]
  s.people = async () => [
    { id: 'user_ada', name: 'Ada Lovelace', avatarUrl: 'data:image/jpeg;base64,ADA' },
    { id: 'user_grace', name: 'Grace Hopper' },
  ]
  assert.deepEqual(await listAvatars(s), [
    { kind: 'agent', id: 'agent_1', name: 'Bob', avatarUrl: 'data:image/png;base64,AAAA' },
    { kind: 'agent', id: 'agent_2', name: 'Alice', avatarUrl: null },
    { kind: 'person', id: 'user_ada', name: 'Ada Lovelace', avatarUrl: 'data:image/jpeg;base64,ADA' },
    { kind: 'person', id: 'user_grace', name: 'Grace Hopper', avatarUrl: null },
  ])
  // Pictures are often inline images: an agent choosing an assignee is not handed them.
  assert.deepEqual(await listAssignees(s), [
    { assignee: { kind: 'agent', id: 'agent_2', name: 'Alice' } },
    { assignee: { kind: 'agent', id: 'agent_1', name: 'Bob' } },
    { assignee: { kind: 'person', id: 'user_ada', name: 'Ada Lovelace' } },
    { assignee: { kind: 'person', id: 'user_grace', name: 'Grace Hopper' } },
  ])
})

test('ranks: before/after positioning, default last', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'one' })
  await createTask(s, { summary: 'two' })
  await createTask(s, { summary: 'zero', before: 'TASK-1' })
  await createTask(s, { summary: 'one and a half', after: 'TASK-1' })
  assert.deepEqual(
    listTasks(s).tasks.map((t) => t.summary),
    ['zero', 'one', 'one and a half', 'two'],
  )
  moveTask(s, { key: 'TASK-3', after: 'TASK-2' })
  assert.deepEqual(
    listTasks(s).tasks.map((t) => t.summary),
    ['one', 'one and a half', 'two', 'zero'],
  )
})

test('move reparents with position, refuses cycles', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'epic', type: 'epic' })
  await createTask(s, { summary: 'story', parent: 'TASK-1' })
  await createTask(s, { summary: 'sub', parent: 'TASK-2' })
  await createTask(s, { summary: 'loose' })
  assert.throws(() => moveTask(s, { key: 'TASK-1', parent: 'TASK-3' }), /cycle/)
  assert.throws(() => moveTask(s, { key: 'TASK-1', parent: 'TASK-1' }), /own parent/)
  const moved = moveTask(s, { key: 'TASK-4', parent: 'TASK-2', before: 'TASK-3' }).result
  assert.equal(moved.parentKey, 'TASK-2')
  const story = getTask(s, 'TASK-2')
  assert.deepEqual(
    story.subtasks.map((t) => t.key),
    ['TASK-4', 'TASK-3'],
  )
  assert.equal(story.childCount, 2)
  const sub = getTask(s, 'TASK-3')
  assert.deepEqual(
    sub.ancestors.map((a) => a.key),
    ['TASK-1', 'TASK-2'],
  )
  moveTask(s, { key: 'TASK-4', parent: null })
  assert.equal(getTask(s, 'TASK-4').parentKey, null)
  assert.ok(getTask(s, 'TASK-2').activity.some((a) => a.kind === 'subtask_removed' && a.from === 'TASK-4'))
})

test('delete refuses a parent unless withSubtasks, then removes the subtree', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'parent' })
  await createTask(s, { summary: 'child', parent: 'TASK-1' })
  await createTask(s, { summary: 'grandchild', parent: 'TASK-2' })
  assert.throws(() => deleteTask(s, { key: 'TASK-1' }), /2 subtask/)
  assert.deepEqual(deleteTask(s, { key: 'TASK-1', withSubtasks: true }).result.deleted, ['TASK-1', 'TASK-2', 'TASK-3'])
  assert.equal(listTasks(s).total, 0)
})

test('update records field activity and applies partial dates', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'plan', startDate: '2026-10-01', endDate: '2026-10-05' })
  const t = (await updateTask(s, { key: 'TASK-1', summary: 'Plan it', endDate: '2026-10-09', priority: 'high', labels: ['ui', 'ui', ' api '] }))
    .result
  assert.equal(t.summary, 'Plan it')
  assert.equal(t.startDate, '2026-10-01')
  assert.equal(t.endDate, '2026-10-09')
  assert.deepEqual(t.labels, ['api', 'ui'])
  const fields = t.activity.filter((a) => a.kind === 'field').map((a) => a.field)
  assert.deepEqual(fields.sort(), ['dates', 'labels', 'priority', 'summary'])
  const cleared = (await updateTask(s, { key: 'TASK-1', startDate: null })).result
  assert.equal(cleared.startDate, null)
  assert.equal(cleared.endDate, null)
  await assert.rejects(updateTask(s, { key: 'TASK-1', endDate: '2026-10-09' }), /both/)
  assert.deepEqual(listLabels(s), ['api', 'ui'])
})

test('listParents lists exactly the tasks with subtasks, in key order', async () => {
  const s = makeScope()
  assert.deepEqual(listParents(s), [], 'an empty project has no parents')
  await createTask(s, { summary: 'Epic' })
  await createTask(s, { summary: 'Leaf' })
  await createTask(s, { summary: 'Story', parent: 'TASK-1' })
  await createTask(s, { summary: 'Step', parent: 'TASK-3' })
  assert.deepEqual(listParents(s), [
    { key: 'TASK-1', summary: 'Epic' },
    { key: 'TASK-3', summary: 'Story' },
  ])
  await deleteTask(s, { key: 'TASK-4' })
  assert.deepEqual(listParents(s), [{ key: 'TASK-1', summary: 'Epic' }], 'a task whose last subtask is gone is no longer a parent')
})

test('status changes run before (veto, in transaction) and after hooks', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'hooked' })
  const seen: StatusChangeEvent[] = []
  unsubscribe.push(
    statusHooks.before((e) => {
      if (e.to.name === 'Done' && e.from.name === 'To Do') {
        throw new Error('Finish review first')
      }
    }),
    statusHooks.after((e) => {
      seen.push(e)
    }),
  )
  await assert.rejects(changeStatus(s, { key: 'TASK-1', status: 'done' }), /Finish review first/)
  assert.equal(getTask(s, 'TASK-1').status.name, 'To Do')
  assert.equal(seen.length, 0)
  const moved = await changeStatus(s, { key: 'TASK-1', status: 'In Progress', comment: 'Starting' })
  assert.equal(moved.result.status.name, 'In Progress')
  assert.equal(moved.result.comments[0].body, 'Starting')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].from.name, 'To Do')
  assert.equal(seen[0].to.name, 'In Progress')
  assert.equal(seen[0].task.status.name, 'In Progress')
  assert.deepEqual(seen[0].actor, { kind: 'agent', name: 'Carol' })
  // Status through update takes the same path.
  await updateTask(s, { key: 'TASK-1', status: 'In Review' })
  assert.equal(seen.length, 2)
  // Same status is a no-op.
  await changeStatus(s, { key: 'TASK-1', status: 'In Review' })
  assert.equal(seen.length, 2)
})

test('a failing after hook is a warning, not a rollback', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'x' })
  unsubscribe.push(
    statusHooks.after(() => {
      throw new Error('engine down')
    }),
  )
  const result = await changeStatus(s, { key: 'TASK-1', status: 'Done' })
  assert.deepEqual(result.warnings, ['engine down'])
  assert.equal(getTask(s, 'TASK-1').status.name, 'Done')
})

test('list filters, search and sort', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'Fix login bug', type: 'bug', priority: 'high', labels: ['auth'], assignee: 'Bob' })
  await createTask(s, { summary: 'Timeline zoom', description: 'ctrl + wheel', startDate: '2026-10-01', endDate: '2026-10-02' })
  await createTask(s, { summary: 'Board columns', parent: 'TASK-2' })
  await changeStatus(s, { key: 'TASK-3', status: 'Done' })
  const titles = (input: Parameters<typeof listTasks>[1]) => listTasks(s, input).tasks.map((t) => t.key)
  assert.deepEqual(titles({ query: 'login' }), ['TASK-1'])
  assert.deepEqual(titles({ query: 'wheel' }), ['TASK-2'])
  assert.deepEqual(titles({ query: 'TASK-3' }), ['TASK-3'])
  assert.deepEqual(titles({ query: 'zo' }), ['TASK-2'])
  assert.deepEqual(titles({ type: ['bug'] }), ['TASK-1'])
  assert.deepEqual(titles({ assignee: ['bob'] }), ['TASK-1'])
  assert.deepEqual(titles({ assignee: ['none'] }), ['TASK-2', 'TASK-3'])
  assert.deepEqual(titles({ label: ['auth'] }), ['TASK-1'])
  assert.deepEqual(titles({ parent: 'TASK-2' }), ['TASK-3'])
  assert.deepEqual(titles({ parent: 'none' }), ['TASK-1', 'TASK-2'])
  assert.deepEqual(titles({ scheduled: true }), ['TASK-2'])
  assert.deepEqual(titles({ statusCategory: ['done'] }), ['TASK-3'])
  assert.deepEqual(titles({ status: ['to do'] }), ['TASK-1', 'TASK-2'])
  assert.deepEqual(titles({ sort: { field: 'priority', dir: 'desc' } })[0], 'TASK-1')
  assert.deepEqual(titles({ sort: { field: 'summary', dir: 'asc' } }), ['TASK-3', 'TASK-1', 'TASK-2'])
  const page = listTasks(s, { limit: 1, offset: 1 })
  assert.equal(page.tasks.length, 1)
  assert.equal(page.total, 3)
  const parent = listTasks(s, { query: 'Timeline' }).tasks[0]
  assert.equal(parent.childCount, 1)
  assert.equal(parent.childDoneCount, 1)
})

test('a search finds a task by its key however the key was copied', async () => {
  const s = makeScope()
  await createTask(s, { summary: 'Fix login bug' })
  await createTask(s, { summary: 'Timeline zoom' })
  await createTask(s, { summary: 'Board columns' })
  const keys = (query: string) => listTasks(s, { query }).tasks.map((t) => t.key)

  // A non-breaking hyphen and an em dash.
  for (const query of ['TASK\u{2011}3', 'TASK\u{2014}3', 'TASK-3:', '(TASK-3)', 'task 3', '#3', '3']) {
    assert.deepEqual(keys(query), ['TASK-3'], JSON.stringify(query))
  }
  assert.deepEqual(keys('OTHER-3:'), [], "another project's key names no task here")
  assert.deepEqual(keys('login'), ['TASK-1'], 'summary words still match')

  await createTask(s, { summary: 'Follow-up', description: 'Blocked until TASK-3 and OTHER-9 land.' })
  assert.deepEqual(keys('TASK\u{2011}3:'), ['TASK-3', 'TASK-4'], 'a mention of the key is found as for the key typed plainly')
  assert.deepEqual(keys('OTHER\u{2011}9'), ['TASK-4'], "another project's key is found where it is mentioned")
})

test('a list filter excludes as well as includes, and an exclude wins over an include', async () => {
  // The caller is the assignee of TASK-1, so "me" names them.
  const s = makeScope({ kind: 'agent', name: 'Bob' })
  await createTask(s, { summary: 'One', type: 'bug', labels: ['auth', 'ui'], assignee: 'Bob' })
  await createTask(s, { summary: 'Two', labels: ['ui'] })
  await createTask(s, { summary: 'Three', parent: 'TASK-2', assignee: 'Ada Lovelace' })
  await changeStatus(s, { key: 'TASK-3', status: 'Done' })
  const keys = (input: Parameters<typeof listTasks>[1]) => listTasks(s, input).tasks.map((t) => t.key)

  assert.deepEqual(keys({ label: { include: ['ui'] } }), ['TASK-1', 'TASK-2'], 'include only')
  assert.deepEqual(keys({ label: { exclude: ['auth'] } }), ['TASK-2', 'TASK-3'], 'exclude only keeps a task with no labels')
  assert.deepEqual(keys({ label: { include: ['ui'], exclude: ['auth'] } }), ['TASK-2'], 'TASK-1 has ui but also auth')
  assert.deepEqual(keys({ label: { include: ['ui'], exclude: ['ui'] } }), ['TASK-3'], 'a value in both lists is excluded')
  assert.deepEqual(keys({ type: { include: ['task'] }, assignee: { exclude: ['none'] } }), ['TASK-3'], 'two fields combine with AND')
  assert.deepEqual(keys({ assignee: { exclude: ['bob'] } }), ['TASK-2', 'TASK-3'], 'an unassigned task is not an excluded assignee')
  assert.deepEqual(keys({ assignee: { exclude: ['me'] } }), ['TASK-2', 'TASK-3'], '"me" is the caller')
  assert.deepEqual(keys({ parent: { exclude: ['TASK-2'] } }), ['TASK-1', 'TASK-2'], 'a top-level task is not under an excluded parent')
  assert.deepEqual(keys({ parent: { exclude: ['none'] } }), ['TASK-3'])
  assert.deepEqual(keys({ version: { exclude: ['none'] } }), [], 'no task is in a version')
  assert.deepEqual(keys({ statusCategory: { exclude: ['done'] } }), ['TASK-1', 'TASK-2'])
  assert.deepEqual(keys({ status: { exclude: ['Done'] }, priority: { exclude: ['high'] } }), ['TASK-1', 'TASK-2'])
  assert.equal(listTasks(s, { label: { exclude: ['auth'] } }).total, 2, 'the total counts with the same filter')

  assert.throws(() => listTasks(s, { label: { only: ['ui'] } as never }), /label takes a list, or \{ include, exclude \}/)
  assert.throws(() => listTasks(s, { type: { exclude: ['chore'] } as never }), /Type must be one of/, 'an excluded value is checked like an included one')
})

test('comments and live notifications', async () => {
  const s = makeScope({ kind: 'person', name: 'user' })
  await createTask(s, { summary: 'talk' })
  const c = (await addComment(s, { key: 'TASK-1', body: '**hi**' })).result
  assert.equal(c.author.name, 'user')
  await assert.rejects(addComment(s, { key: 'TASK-1', body: ' ' }), /body/)
  assert.deepEqual(s.events.at(-1), { keys: ['TASK-1'], kind: 'comment' })
  assert.equal(getTask(s, 'TASK-1').comments.length, 1)
})

test("only a comment's author edits or deletes it, and reads it as theirs", async () => {
  const ada = makeScope({ kind: 'person', name: 'Ada Lovelace' })
  await createTask(ada, { summary: 'talk' })
  const mine = (await addComment(ada, { key: 'TASK-1', body: 'first' })).result
  // The same database, another caller.
  const bob = { ...makeScope({ kind: 'agent', name: 'Bob' }), db: ada.db }
  const theirs = (await addComment(bob, { key: 'TASK-1', body: 'second' })).result

  assert.deepEqual(getTask(ada, 'TASK-1').comments.map((c) => c.mine), [true, false])
  assert.deepEqual(getTask(bob, 'TASK-1').comments.map((c) => c.mine), [false, true])

  const edited = updateComment(ada, { key: 'TASK-1', id: mine.id, body: ' first, edited ' }).result
  assert.equal(edited.body, 'first, edited')
  assert.equal(edited.createdAt, mine.createdAt)
  assert.deepEqual(ada.events.at(-1), { keys: ['TASK-1'], kind: 'comment' })
  assert.throws(() => updateComment(ada, { key: 'TASK-1', id: theirs.id, body: 'no' }), /Only its author \(Bob\)/)
  assert.throws(() => updateComment(ada, { key: 'TASK-1', id: mine.id, body: ' ' }), /body/)
  assert.throws(() => updateComment(ada, { key: 'TASK-1', id: 999, body: 'x' }), /has no comment 999/)

  assert.throws(() => deleteComment(bob, { key: 'TASK-1', id: mine.id }), /Only its author \(Ada Lovelace\) can delete/)
  assert.equal(deleteComment(bob, { key: 'TASK-1', id: theirs.id }).result.deleted, theirs.id)
  assert.deepEqual(getTask(ada, 'TASK-1').comments.map((c) => c.body), ['first, edited'])
})

test('status CRUD keeps a to-do status and moves tasks through the status path', async () => {
  const s = makeScope()
  const qa = createStatus(s, { name: 'QA', category: 'in_progress', color: '#a855f7' }).result
  assert.equal(qa.position, 5)
  assert.throws(() => createStatus(s, { name: 'qa', category: 'todo' }), /already exists/)
  updateStatus(s, { status: 'QA', name: 'Testing' })
  await createTask(s, { summary: 'x', status: 'Testing' })
  const seen: string[] = []
  unsubscribe.push(statusHooks.after((e) => void seen.push(`${e.from.name}->${e.to.name}`)))
  const deleted = await deleteStatus(s, { status: 'Testing', moveTo: 'In Review' })
  assert.equal(deleted.result.moved, 1)
  assert.deepEqual(seen, ['Testing->In Review'])
  await assert.rejects(deleteStatus(s, { status: 'To Do', moveTo: 'Done' }), /to-do status/)
  assert.throws(() => updateStatus(s, { status: 'To Do', category: 'done' }), /to-do status/)
  const ids = reorderStatuses(s, { order: [5, 4, 3, 2, 1] }).result.map((st) => st.name)
  assert.deepEqual(ids, ['Cancelled', 'Done', 'In Review', 'In Progress', 'To Do'])
  assert.throws(() => reorderStatuses(s, { order: [1, 2] }), /every status/)
  const byName = reorderStatuses(s, { order: ['to do', 'In Progress', 3, 'done', 'Cancelled'] }).result.map((st) => st.name)
  assert.deepEqual(byName, ['To Do', 'In Progress', 'In Review', 'Done', 'Cancelled'])
  assert.throws(() => reorderStatuses(s, { order: ['To Do', 'Doing'] }), /No status "Doing"\. Statuses: /)
})

test('ranks stay short: long runs of appends and inserts at one spot respace the list', async () => {
  const s = makeScope()
  for (let i = 1; i <= 300; i++) {
    await createTask(s, { summary: `t${i}` })
  }
  for (let i = 0; i < 150; i++) {
    await createTask(s, { summary: `before-${i}`, before: 'TASK-2' })
  }
  const { tasks } = listTasks(s, { limit: 1000 })
  assert.ok(tasks.every((task) => task.rank.length <= 12), `longest ${Math.max(...tasks.map((t) => t.rank.length))}`)
  const order = tasks.map((task) => task.summary)
  assert.equal(order[0], 't1')
  assert.deepEqual(order.slice(1, 151), Array.from({ length: 150 }, (_, i) => `before-${i}`))
  assert.equal(order[151], 't2')
  assert.equal(order.at(-1), 't300')
})
