import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { changesForDrop } from '../src/components/ui/timeline/timeline-drop'
import {
  backlogTasks,
  childSpans,
  dropZone,
  isWithin,
  placementFor,
  type TimelineTask,
  treeKeyIntent,
  visibleRows,
} from '../src/components/ui/timeline/timeline-model'
import {
  anchoredScroll,
  fitPxPerDay,
  formatRange,
  fromDay,
  isWeekend,
  MAX_PX_PER_DAY,
  MIN_PX_PER_DAY,
  scaleRange,
  ticks,
  tiersFor,
  toDay,
  today,
  unitStart,
} from '../src/components/ui/timeline/timeline-scale'

function task(key: string, fields: Partial<TimelineTask> = {}): TimelineTask {
  return {
    key,
    summary: key,
    parentKey: null,
    rank: key,
    startDate: null,
    endDate: null,
    status: { name: 'To do', category: 'todo' },
    assignee: null,
    ...fields,
  }
}

describe('timeline scale', () => {
  it('round-trips calendar dates through day numbers, across a leap day, DST changes and a year end', () => {
    for (const date of ['1970-01-01', '2024-02-29', '2026-03-29', '2026-10-25', '2026-12-31', '2027-01-01']) {
      assert.equal(fromDay(toDay(date)), date)
    }
    assert.equal(toDay('2026-03-01') - toDay('2026-02-28'), 1)
    assert.equal(toDay('2024-03-01') - toDay('2024-02-28'), 2)
  })

  it("takes today from the viewer's local calendar date", () => {
    assert.equal(fromDay(today(new Date(2026, 8, 26, 23, 59))), '2026-09-26')
    assert.equal(fromDay(today(new Date(2026, 8, 26, 0, 1))), '2026-09-26')
  })

  it('marks Saturdays and Sundays as weekend', () => {
    // 2026-09-26 is a Saturday.
    assert.deepEqual(
      ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map((d) => isWeekend(toDay(d))),
      [false, true, true, false],
    )
  })

  it('starts weeks on Monday and quarters on their first month', () => {
    assert.equal(fromDay(unitStart('week', toDay('2026-09-27'))), '2026-09-21')
    assert.equal(fromDay(unitStart('week', toDay('2026-09-21'))), '2026-09-21')
    assert.equal(fromDay(unitStart('quarter', toDay('2026-09-27'))), '2026-07-01')
    assert.equal(fromDay(unitStart('month', toDay('2026-09-27'))), '2026-09-01')
  })

  it('moves the header from days to weeks to months to quarters as the zoom narrows', () => {
    assert.deepEqual(
      [MAX_PX_PER_DAY, 20, 19, 6, 5, 1.6, 1.5, MIN_PX_PER_DAY].map((px) => tiersFor(px)),
      [
        { top: 'month', bottom: 'day' },
        { top: 'month', bottom: 'day' },
        { top: 'month', bottom: 'week' },
        { top: 'month', bottom: 'week' },
        { top: 'year', bottom: 'month' },
        { top: 'year', bottom: 'month' },
        { top: 'year', bottom: 'quarter' },
        { top: 'year', bottom: 'quarter' },
      ],
    )
  })

  it('covers a range with whole ticks and labels them for their row', () => {
    const months = ticks('month', toDay('2026-09-10'), toDay('2026-11-02'), 10, 'top')
    assert.deepEqual(
      months.map((t) => [fromDay(t.start), fromDay(t.end), t.label]),
      [
        ['2026-09-01', '2026-10-01', 'September 2026'],
        ['2026-10-01', '2026-11-01', 'October 2026'],
        ['2026-11-01', '2026-12-01', 'November 2026'],
      ],
    )
    assert.deepEqual(
      ticks('quarter', toDay('2026-01-01'), toDay('2026-12-31'), 1, 'bottom').map((t) => t.label),
      ['Q1', 'Q2', 'Q3', 'Q4'],
    )
    assert.deepEqual(
      ticks('day', toDay('2026-09-26'), toDay('2026-09-28'), 40, 'bottom').map((t) => t.label),
      ['S 26', 'S 27'],
    )
  })

  it('keeps the day under the anchor in place across a zoom', () => {
    const scrollLeft = 1000
    const anchor = 300
    const next = anchoredScroll(scrollLeft, anchor, 20, 50)
    assert.equal((next + anchor) / 50, (scrollLeft + anchor) / 20)
    assert.equal(anchoredScroll(0, 10, 20, 5), 0, 'never scrolls before the start')
  })

  it('fits a span into a width, within the zoom limits', () => {
    assert.equal(fitPxPerDay(10, 500), 50)
    assert.equal(fitPxPerDay(1, 5000), MAX_PX_PER_DAY)
    assert.equal(fitPxPerDay(10_000, 100), MIN_PX_PER_DAY)
  })

  it('spans whole years around today and every date, with room on both sides', () => {
    const range = scaleRange(['2027-03-10', '2026-02-01'], toDay('2026-09-26'))
    assert.equal(fromDay(range.from), '2025-01-01')
    assert.equal(fromDay(range.to), '2028-01-01')
  })

  it('formats ranges briefly, with years only when they differ', () => {
    assert.equal(formatRange('2026-09-21', '2026-09-25'), 'Sep 21 – Sep 25')
    assert.equal(formatRange('2026-09-21', '2026-09-21'), 'Sep 21')
    assert.equal(formatRange('2026-12-30', '2027-01-02'), 'Dec 30, 2026 – Jan 2, 2027')
  })
})

describe('timeline model', () => {
  const tasks = [
    task('T-1', { rank: 'b' }),
    task('T-2', { rank: 'a' }),
    task('T-3', { parentKey: 'T-1', rank: 'b', startDate: '2026-09-21', endDate: '2026-09-23' }),
    task('T-4', { parentKey: 'T-1', rank: 'a' }),
    task('T-5', { parentKey: 'T-4', rank: 'a', startDate: '2026-09-28', endDate: '2026-10-02' }),
    task('T-6', { parentKey: 'T-99', rank: 'c' }),
  ]

  const shape = (rows: ReturnType<typeof visibleRows>) =>
    rows.map((r) =>
      r.kind === 'task'
        ? `${'  '.repeat(r.depth)}${r.task.key}${r.expanded ? '-' : ''}`
        : `${'  '.repeat(r.depth)}+${r.parentKey ?? ''}`,
    )

  it('lists the tree in rank order, with a create row under each open parent and one at the end', () => {
    assert.deepEqual(shape(visibleRows(tasks, new Set(['T-1', 'T-4']), null)), [
      'T-2',
      'T-1-',
      '  T-4-',
      '    T-5',
      '    +T-4',
      '  T-3',
      '  +T-1',
      'T-6',
      '+',
    ])
  })

  it('hides the children of a collapsed parent and opens a create row under a leaf being given a subtask', () => {
    assert.deepEqual(shape(visibleRows(tasks, new Set(), 'T-2')), ['T-2-', '  +T-2', 'T-1', 'T-6', '+'])
  })

  it("rolls each parent's span up from every scheduled task below it", () => {
    assert.deepEqual(childSpans(tasks), {
      'T-1': { start: '2026-09-21', end: '2026-10-02' },
      'T-4': { start: '2026-09-28', end: '2026-10-02' },
    })
  })

  it('puts every unscheduled task in the backlog, in rank order', () => {
    assert.deepEqual(
      backlogTasks(tasks).map((t) => t.key),
      ['T-2', 'T-4', 'T-1', 'T-6'],
    )
  })

  it('knows what sits below a task, and survives a cycle in the data', () => {
    assert.equal(isWithin(tasks, 'T-5', 'T-1'), true)
    assert.equal(isWithin(tasks, 'T-1', 'T-5'), false)
    assert.equal(isWithin(tasks, 'T-1', 'T-1'), true)
    const cyclic = [task('A', { parentKey: 'B' }), task('B', { parentKey: 'A' })]
    assert.equal(isWithin(cyclic, 'A', 'C'), false)
  })

  it('reads a drop zone from where on the row the pointer is', () => {
    assert.deepEqual(
      [0, 7, 8, 24, 25, 31].map((y) => dropZone(y, 32)),
      ['before', 'before', 'inside', 'inside', 'after', 'after'],
    )
  })

  it('places a dropped task next to or inside the target, and refuses to nest a task in itself', () => {
    const t3 = tasks[2]
    assert.deepEqual(placementFor(tasks, 'T-2', t3, 'before'), { parent: 'T-1', before: 'T-3' })
    assert.deepEqual(placementFor(tasks, 'T-2', t3, 'after'), { parent: 'T-1', after: 'T-3' })
    assert.deepEqual(placementFor(tasks, 'T-2', t3, 'inside'), { parent: 'T-3' })
    assert.equal(placementFor(tasks, 'T-1', tasks[4], 'inside'), null)
    assert.equal(placementFor(tasks, 'T-1', tasks[4], 'before'), null)
  })
})

describe('timeline drops', () => {
  const tasks = [
    task('T-1', { startDate: '2026-09-21', endDate: '2026-09-23' }),
    task('T-2'),
    task('T-3', { parentKey: 'T-1' }),
  ]
  const day = toDay('2026-10-05')

  it('shifts a dragged bar by the days it moved', () => {
    assert.deepEqual(
      changesForDrop({ tasks, key: 'T-1', source: 'bar', target: { kind: 'scale', day }, shiftDays: 3 }),
      [{ type: 'schedule', key: 'T-1', start: '2026-09-24', end: '2026-09-26' }],
    )
    assert.deepEqual(
      changesForDrop({ tasks, key: 'T-1', source: 'bar', target: { kind: 'scale', day }, shiftDays: 0 }),
      [],
    )
  })

  it("schedules a backlog item from the drop day for the default length, and keeps a scheduled task's length", () => {
    assert.deepEqual(changesForDrop({ tasks, key: 'T-2', source: 'backlog', target: { kind: 'scale', day } }), [
      { type: 'schedule', key: 'T-2', start: '2026-10-05', end: '2026-10-09' },
    ])
    assert.deepEqual(changesForDrop({ tasks, key: 'T-1', source: 'row', target: { kind: 'scale', day } }), [
      { type: 'schedule', key: 'T-1', start: '2026-10-05', end: '2026-10-07' },
    ])
  })

  it('unschedules a bar dropped on the backlog, and moves it next to an item it lands on', () => {
    assert.deepEqual(changesForDrop({ tasks, key: 'T-1', source: 'bar', target: { kind: 'backlog' } }), [
      { type: 'unschedule', key: 'T-1' },
    ])
    assert.deepEqual(
      changesForDrop({
        tasks,
        key: 'T-1',
        source: 'bar',
        target: { kind: 'backlog-item', key: 'T-2', zone: 'before' },
      }),
      [
        { type: 'unschedule', key: 'T-1' },
        { type: 'move', key: 'T-1', placement: { before: 'T-2' } },
      ],
    )
  })

  it('reorders the backlog without touching dates, and ignores a drop on itself', () => {
    assert.deepEqual(
      changesForDrop({
        tasks,
        key: 'T-2',
        source: 'backlog',
        target: { kind: 'backlog-item', key: 'T-3', zone: 'after' },
      }),
      [{ type: 'move', key: 'T-2', placement: { after: 'T-3' } }],
    )
    assert.deepEqual(
      changesForDrop({
        tasks,
        key: 'T-2',
        source: 'backlog',
        target: { kind: 'backlog-item', key: 'T-2', zone: 'after' },
      }),
      [],
    )
    assert.deepEqual(changesForDrop({ tasks, key: 'T-2', source: 'backlog', target: { kind: 'backlog' } }), [])
  })

  it('moves rows in the tree, but never a bar, and never a task into its own subtree', () => {
    assert.deepEqual(
      changesForDrop({ tasks, key: 'T-2', source: 'row', target: { kind: 'row', key: 'T-1', zone: 'inside' } }),
      [{ type: 'move', key: 'T-2', placement: { parent: 'T-1' } }],
    )
    assert.deepEqual(
      changesForDrop({ tasks, key: 'T-1', source: 'bar', target: { kind: 'row', key: 'T-2', zone: 'inside' } }),
      [],
    )
    assert.deepEqual(
      changesForDrop({ tasks, key: 'T-1', source: 'row', target: { kind: 'row', key: 'T-3', zone: 'inside' } }),
      [],
    )
  })

  it('does nothing without a target', () => {
    assert.deepEqual(changesForDrop({ tasks, key: 'T-1', source: 'bar', target: null, shiftDays: 4 }), [])
  })
})

describe('tree keys', () => {
  // P-1 has a child C-1; S-1 is a second top-level task.
  const tasks = [task('P-1', { rank: 'a' }), task('C-1', { parentKey: 'P-1', rank: 'b' }), task('S-1', { rank: 'c' })]
  const open = visibleRows(tasks, new Set(['P-1']), null)
  const folded = visibleRows(tasks, new Set(), null)

  it('moves the selection down and up through the task rows, skipping create rows, and stops at the ends', () => {
    assert.deepEqual(treeKeyIntent('ArrowDown', open, null), { kind: 'select', key: 'P-1' })
    assert.deepEqual(treeKeyIntent('ArrowDown', open, 'P-1'), { kind: 'select', key: 'C-1' })
    assert.deepEqual(treeKeyIntent('ArrowDown', open, 'C-1'), { kind: 'select', key: 'S-1' })
    assert.deepEqual(treeKeyIntent('ArrowDown', open, 'S-1'), { kind: 'select', key: 'S-1' })
    assert.deepEqual(treeKeyIntent('ArrowUp', open, 'P-1'), { kind: 'select', key: 'P-1' })
    assert.deepEqual(treeKeyIntent('ArrowUp', folded, 'S-1'), { kind: 'select', key: 'P-1' })
  })

  it('unfolds with right, folds with left, and steps out to the parent from a child', () => {
    assert.deepEqual(treeKeyIntent('ArrowRight', folded, 'P-1'), { kind: 'toggle', key: 'P-1' })
    assert.equal(treeKeyIntent('ArrowRight', open, 'P-1'), null)
    assert.deepEqual(treeKeyIntent('ArrowLeft', open, 'P-1'), { kind: 'toggle', key: 'P-1' })
    assert.deepEqual(treeKeyIntent('ArrowLeft', open, 'C-1'), { kind: 'select', key: 'P-1' })
    assert.equal(treeKeyIntent('ArrowLeft', open, 'S-1'), null)
  })

  it('opens and deletes the selected task, and leaves other keys alone', () => {
    assert.deepEqual(treeKeyIntent('Enter', open, 'C-1'), { kind: 'open', key: 'C-1' })
    assert.deepEqual(treeKeyIntent('Backspace', open, 'C-1'), { kind: 'delete', key: 'C-1' })
    assert.equal(treeKeyIntent('Enter', open, null), null)
    assert.equal(treeKeyIntent('x', open, 'C-1'), null)
  })
})
