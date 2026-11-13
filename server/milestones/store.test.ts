import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeScope } from '../attachments/testing.ts'
import { milestoneRow, taskRow } from '../compact.ts'
import { createTask, getTask, listTasks, updateTask } from '../service.ts'
import { createVersion } from '../versions/store.ts'
import { saveView } from '../views/store.ts'
import { createMilestone, datesOnEntry, deleteMilestone, listMilestones, updateMilestone } from './store.ts'

/** The UTC date `days` from today, as the server reads today. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

test('names are free text, unique ignoring case, and never "none"', () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: '  Beta   launch ' })
  assert.throws(() => createMilestone(scope, { name: 'beta LAUNCH' }), /Milestone Beta launch already exists/)
  assert.throws(() => createMilestone(scope, { name: 'None' }), /"none" cannot name a milestone/)
  assert.throws(() => createMilestone(scope, { name: ' ' }), /needs a name/)
  assert.throws(() => createMilestone(scope, { name: 'x'.repeat(81) }), /at most 80 characters/)
  assert.throws(
    () => createMilestone(scope, { name: 'Late', startDate: '2026-12-20', targetDate: '2026-12-01' }),
    /targetDate 2026-12-01 is before startDate 2026-12-20/,
  )
  assert.equal(listMilestones(scope).milestones[0].name, 'Beta launch')
})

test('listed open first, by target date with undated last, then by name; archived after', () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Undated' })
  createMilestone(scope, { name: 'Later', targetDate: '2027-03-01' })
  createMilestone(scope, { name: 'Sooner', targetDate: '2027-01-01' })
  createMilestone(scope, { name: 'Gone', targetDate: '2026-01-01' })
  updateMilestone(scope, { milestone: 'gone', state: 'archived' })
  assert.deepEqual(
    listMilestones(scope).milestones.map((milestone) => milestone.name),
    ['Sooner', 'Later', 'Undated', 'Gone'],
  )
  assert.deepEqual(
    listMilestones(scope, { state: ['archived'] }).milestones.map((milestone) => milestone.name),
    ['Gone'],
  )
})

test('dates on entry: overlapping dates stay, others move to the later of the start and today, keeping their length', () => {
  const beta = { start_date: '2026-12-01', target_date: '2026-12-20' }
  const today = '2026-11-12'
  assert.deepEqual(datesOnEntry({ startDate: '2025-03-03', endDate: '2025-03-07' }, beta, today), {
    startDate: '2026-12-01',
    endDate: '2026-12-05',
  })
  assert.deepEqual(datesOnEntry({ startDate: '2026-11-25', endDate: '2026-12-03' }, beta, today), {
    startDate: '2026-11-25',
    endDate: '2026-12-03',
  })
  assert.deepEqual(datesOnEntry({ startDate: null, endDate: null }, beta, today), {
    startDate: '2026-12-01',
    endDate: '2026-12-05',
  })
  // No start: the span starts today, and so does the moved task.
  const noStart = { start_date: null, target_date: '2026-12-20' }
  assert.deepEqual(datesOnEntry({ startDate: null, endDate: null }, noStart, today), {
    startDate: '2026-11-12',
    endDate: '2026-11-16',
  })
  // A start already past: the task starts today.
  const started = { start_date: '2026-10-01', target_date: '2026-12-20' }
  assert.deepEqual(datesOnEntry({ startDate: '2026-12-21', endDate: '2026-12-22' }, started, today), {
    startDate: '2026-11-12',
    endDate: '2026-11-13',
  })
  // No target: open-ended, so anything from the start on overlaps.
  const openEnded = { start_date: '2026-12-01', target_date: null }
  assert.deepEqual(datesOnEntry({ startDate: '2030-01-01', endDate: '2030-01-03' }, openEnded, today), {
    startDate: '2030-01-01',
    endDate: '2030-01-03',
  })
})

test('a task entering a milestone takes the subtasks that were where it was, each dated by the rule, in one event', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  const start = inDays(30)
  const target = inDays(60)
  createMilestone(scope, { name: 'Beta', startDate: start, targetDate: target })
  createMilestone(scope, { name: 'Gamma' })
  createVersion(scope, { name: '1.0.0' })
  const parent = (await createTask(scope, { summary: 'Plain task', version: '1.0.0' })).result.key
  const old = (
    await createTask(scope, { summary: 'Last year', parent, startDate: '2025-03-03', endDate: '2025-03-07' })
  ).result.key
  const inside = (await createTask(scope, { summary: 'Inside', parent, startDate: inDays(35), endDate: inDays(40) }))
    .result.key
  const undated = (await createTask(scope, { summary: 'Undated', parent })).result.key
  const elsewhere = (await createTask(scope, { summary: 'Elsewhere', parent, milestone: 'Gamma' })).result.key
  const belowElsewhere = (await createTask(scope, { summary: 'Below elsewhere', parent: elsewhere })).result.key
  const belowOld = (await createTask(scope, { summary: 'Below last year', parent: old })).result.key
  const elsewhereDates = { startDate: getTask(scope, elsewhere).startDate, endDate: getTask(scope, elsewhere).endDate }
  scope.events.length = 0

  const answer = await updateTask(scope, { key: parent, milestone: 'beta' })

  const read = (key: string) => getTask(scope, key)
  assert.deepEqual(read(parent).milestone, { name: 'Beta', state: 'open' })
  assert.deepEqual([read(parent).startDate, read(parent).endDate], [start, inDays(34)])
  assert.deepEqual([read(old).startDate, read(old).endDate], [start, inDays(34)])
  assert.deepEqual([read(inside).startDate, read(inside).endDate], [inDays(35), inDays(40)])
  assert.deepEqual([read(undated).startDate, read(undated).endDate], [start, inDays(34)])
  assert.equal(read(belowOld).milestone?.name, 'Beta')
  // A subtask in another milestone stays, and the subtasks below it with it.
  assert.equal(read(elsewhere).milestone?.name, 'Gamma')
  assert.deepEqual({ startDate: read(elsewhere).startDate, endDate: read(elsewhere).endDate }, elsewhereDates)
  assert.equal(read(belowElsewhere).milestone, null)
  assert.equal(read(parent).version?.name, '1.0.0')

  assert.equal(scope.events.length, 1)
  assert.deepEqual(new Set(scope.events[0].keys), new Set([parent, old, inside, undated, belowOld]))
  assert.deepEqual(
    answer.warnings?.map((warning) => warning.split(' ')[0]),
    [parent, old, undated, belowOld],
  )
  assert.match(answer.warnings?.[1] ?? '', /to fit milestone Beta \(was 2025-03-03 → 2025-03-07\)/)

  const history = read(old).activity.filter((entry) => entry.kind === 'field')
  assert.deepEqual(
    history.map((entry) => [entry.field, entry.from, entry.to]),
    [
      ['milestone', null, 'Beta'],
      ['dates', '2025-03-03 → 2025-03-07', `${start} → ${inDays(34)}`],
    ],
  )
  assert.equal(taskRow(read(old)).milestone, 'Beta')
})

test('leaving a milestone changes no dates, and the subtasks in it leave with the task', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  const parent = (await createTask(scope, { summary: 'Plain task', milestone: 'Beta' })).result.key
  const child = (await createTask(scope, { summary: 'Child', parent, milestone: 'Beta' })).result.key
  const before = [parent, child].map((key) => [getTask(scope, key).startDate, getTask(scope, key).endDate])

  const answer = await updateTask(scope, { key: parent, milestone: null })

  assert.deepEqual(
    [parent, child].map((key) => getTask(scope, key).milestone),
    [null, null],
  )
  assert.deepEqual(
    [parent, child].map((key) => [getTask(scope, key).startDate, getTask(scope, key).endDate]),
    before,
  )
  assert.equal(answer.warnings, undefined)
})

test('withSubtasks false moves the task alone; dates in the same write are used instead of the rule', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  const parent = (await createTask(scope, { summary: 'Plain task' })).result.key
  const child = (await createTask(scope, { summary: 'Child', parent })).result.key

  await updateTask(scope, {
    key: parent,
    milestone: 'Beta',
    withSubtasks: false,
    startDate: '2025-01-01',
    endDate: '2025-01-02',
  })

  assert.equal(getTask(scope, parent).milestone?.name, 'Beta')
  assert.deepEqual([getTask(scope, parent).startDate, getTask(scope, parent).endDate], ['2025-01-01', '2025-01-02'])
  assert.equal(getTask(scope, child).milestone, null)
  assert.equal(getTask(scope, child).startDate, null)
})

test('a task created in a milestone is dated in it; task_list filters by milestone and "none"', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  const a = (await createTask(scope, { summary: 'A', milestone: 'Beta' })).result
  const b = (await createTask(scope, { summary: 'B' })).result.key
  assert.deepEqual([a.startDate, a.endDate], [inDays(30), inDays(34)])
  assert.deepEqual(
    listTasks(scope, { milestone: ['beta'] }).tasks.map((task) => task.key),
    [a.key],
  )
  assert.deepEqual(
    listTasks(scope, { milestone: ['none'] }).tasks.map((task) => task.key),
    [b],
  )
  assert.deepEqual(
    listTasks(scope, { milestone: { exclude: ['Beta'] } }).tasks.map((task) => task.key),
    [b],
  )
  assert.throws(() => listTasks(scope, { milestone: ['Delta'] }), /No milestone "Delta"/)
})

test('archiving hides nothing of its tasks and takes no new ones; restoring takes them again', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  const kept = (await createTask(scope, { summary: 'Kept', milestone: 'Beta' })).result
  const other = (await createTask(scope, { summary: 'Other' })).result.key

  const archived = updateMilestone(scope, { milestone: 'Beta', state: 'archived' }).result

  assert.deepEqual([archived.state, archived.openCount], ['archived', 1])
  const after = getTask(scope, kept.key)
  assert.deepEqual(
    [after.milestone, after.startDate, after.endDate],
    [{ name: 'Beta', state: 'archived' }, kept.startDate, kept.endDate],
  )
  await assert.rejects(updateTask(scope, { key: other, milestone: 'Beta' }), /Milestone Beta is archived/)
  // Naming the milestone the task is already in changes nothing, archived or not.
  await updateTask(scope, { key: kept.key, milestone: 'Beta', summary: 'Kept still' })
  updateMilestone(scope, { milestone: 'Beta', state: 'open' })
  await updateTask(scope, { key: other, milestone: 'Beta' })
  assert.equal(getTask(scope, other).milestone?.name, 'Beta')
})

test('re-planning moves no task; a rename reaches saved views', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  const task = (await createTask(scope, { summary: 'A', milestone: 'Beta' })).result
  const view = saveView(
    scope.db,
    { key: 'person:Alice', name: 'Alice' },
    { name: 'Beta work', page: 'tasks', filter: { milestone: ['Beta'] } },
    new Date().toISOString(),
  )

  const renamed = updateMilestone(scope, {
    milestone: 'beta',
    name: 'Beta 2',
    startDate: inDays(90),
    targetDate: null,
  }).result

  assert.deepEqual([renamed.name, renamed.startDate, renamed.targetDate], ['Beta 2', inDays(90), null])
  assert.deepEqual(
    [getTask(scope, task.key).startDate, getTask(scope, task.key).endDate],
    [task.startDate, task.endDate],
  )
  assert.equal(getTask(scope, task.key).milestone?.name, 'Beta 2')
  const stored = scope.db.prepare('SELECT filter FROM saved_view WHERE id = ?').get(view.id) as { filter: string }
  assert.deepEqual(JSON.parse(stored.filter).milestone, { include: ['Beta 2'] })
  assert.throws(
    () => updateMilestone(scope, { milestone: 'Beta 2', startDate: '2030-01-02', targetDate: '2030-01-01' }),
    /before startDate/,
  )
  assert.deepEqual(milestoneRow(renamed), { name: 'Beta 2', state: 'open', startDate: inDays(90), open: 1 })
})

test('deleting a milestone takes its tasks out with their dates and drops it from saved filters', async () => {
  const scope = makeScope({ kind: 'person', name: 'Alice' })
  createMilestone(scope, { name: 'Beta', startDate: inDays(30), targetDate: inDays(60) })
  createMilestone(scope, { name: 'Gamma' })
  const parent = (await createTask(scope, { summary: 'Plain task', milestone: 'Beta' })).result
  const child = (await createTask(scope, { summary: 'Child', parent: parent.key, milestone: 'Beta' })).result
  const elsewhere = (await createTask(scope, { summary: 'Elsewhere', milestone: 'Gamma' })).result
  const view = saveView(
    scope.db,
    { key: 'person:Alice', name: 'Alice' },
    { name: 'Planned', page: 'tasks', filter: { milestone: ['Beta', 'Gamma'] } },
    new Date().toISOString(),
  )
  updateMilestone(scope, { milestone: 'Beta', state: 'archived' })
  scope.events.length = 0

  const answer = deleteMilestone(scope, { milestone: 'beta' })

  assert.deepEqual(answer.result, { deleted: 'Beta', tasks: [parent.key, child.key] })
  assert.equal(answer.warnings, undefined)
  for (const task of [parent, child]) {
    const after = getTask(scope, task.key)
    assert.deepEqual([after.milestone, after.startDate, after.endDate], [null, task.startDate, task.endDate])
    assert.deepEqual(
      after.activity.filter((entry) => entry.kind === 'field').map((entry) => [entry.field, entry.from, entry.to]),
      [['milestone', 'Beta', null]],
    )
  }
  assert.equal(getTask(scope, elsewhere.key).milestone?.name, 'Gamma')
  assert.deepEqual(
    listMilestones(scope).milestones.map((milestone) => milestone.name),
    ['Gamma'],
  )
  assert.deepEqual(
    scope.events.map((event) => [event.kind, event.keys]),
    [
      ['task', [parent.key, child.key]],
      ['milestone', []],
    ],
  )
  const stored = scope.db.prepare('SELECT filter FROM saved_view WHERE id = ?').get(view.id) as { filter: string }
  assert.deepEqual(JSON.parse(stored.filter).milestone, { include: ['Gamma'] })
  assert.throws(() => deleteMilestone(scope, { milestone: 'Beta' }), /No milestone "Beta"/)
  // The name is free again.
  assert.equal(createMilestone(scope, { name: 'Beta' }).result.openCount, 0)
})
