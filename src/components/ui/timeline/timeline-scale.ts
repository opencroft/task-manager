export type CalendarDate = string

// Date and zoom math for the timeline. Pure and DOM-free.
//
// A calendar date (`YYYY-MM-DD`, no time zone) is handled as a DAY NUMBER: whole days since 1970-01-01,
// computed in UTC so no local offset or DST change can move a date. An x
// position on the scale is `(day - origin) * pxPerDay`.

const MS_PER_DAY = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Narrowest and widest day, in pixels. The narrow end shows quarters, the wide end single days. */
export const MIN_PX_PER_DAY = 1
export const MAX_PX_PER_DAY = 96
export const DEFAULT_PX_PER_DAY = 28

/** How long a task scheduled by a drop or a menu runs, in days. */
export const DEFAULT_SPAN_DAYS = 5

export function toDay(date: CalendarDate): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

export function fromDay(day: number): CalendarDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Today in the viewer's own time zone, as a day number. */
export function today(now: Date = new Date()): number {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY)
}

function parts(day: number): { year: number; month: number; date: number; weekday: number } {
  const d = new Date(day * MS_PER_DAY)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), weekday: d.getUTCDay() }
}

function dayOf(year: number, month: number, date = 1): number {
  return Math.round(Date.UTC(year, month, date) / MS_PER_DAY)
}

export function isWeekend(day: number): boolean {
  const { weekday } = parts(day)
  return weekday === 0 || weekday === 6
}

export function clampPxPerDay(px: number): number {
  return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, px))
}

/** A short human form of an inclusive range, e.g. `Sep 21 – Sep 25`, or `Sep 21` for one day. */
export function formatRange(start: CalendarDate, end: CalendarDate): string {
  const a = parts(toDay(start))
  const b = parts(toDay(end))
  const crossesYear = a.year !== b.year
  const label = (p: typeof a) => `${MONTHS[p.month]} ${p.date}${crossesYear ? `, ${p.year}` : ''}`
  return start === end ? label(a) : `${label(a)} – ${label(b)}`
}

export type ScaleUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** One labelled span on a header row. `start` inclusive, `end` exclusive, in days. */
export interface ScaleTick {
  start: number
  end: number
  label: string
}

export interface ScaleTiers {
  top: ScaleUnit
  bottom: ScaleUnit
}

/**
 * Which units the two header rows show at a zoom level, chosen so the lower
 * row's labels keep their room: a day needs ~20px, a week ~42px, a month ~48px.
 */
export function tiersFor(pxPerDay: number): ScaleTiers {
  if (pxPerDay >= 20) {
    return { top: 'month', bottom: 'day' }
  }
  if (pxPerDay >= 6) {
    return { top: 'month', bottom: 'week' }
  }
  if (pxPerDay >= 1.6) {
    return { top: 'year', bottom: 'month' }
  }
  return { top: 'year', bottom: 'quarter' }
}

const UNIT_NAMES: Record<ScaleUnit, string> = {
  day: 'Days',
  week: 'Weeks',
  month: 'Months',
  quarter: 'Quarters',
  year: 'Years',
}

/** The zoom level's name, for the toolbar. */
export function zoomLabel(pxPerDay: number): string {
  return UNIT_NAMES[tiersFor(pxPerDay).bottom]
}

/** First day of the unit containing `day`. Weeks start on Monday. */
export function unitStart(unit: ScaleUnit, day: number): number {
  const p = parts(day)
  switch (unit) {
    case 'day':
      return day
    case 'week':
      return day - ((p.weekday + 6) % 7)
    case 'month':
      return dayOf(p.year, p.month)
    case 'quarter':
      return dayOf(p.year, p.month - (p.month % 3))
    case 'year':
      return dayOf(p.year, 0)
  }
}

function nextUnit(unit: ScaleUnit, start: number): number {
  const p = parts(start)
  switch (unit) {
    case 'day':
      return start + 1
    case 'week':
      return start + 7
    case 'month':
      return dayOf(p.year, p.month + 1)
    case 'quarter':
      return dayOf(p.year, p.month + 3)
    case 'year':
      return dayOf(p.year + 1, 0)
  }
}

/** The week, month or quarter containing `day`: its first and last day, and its name. */
export function periodOf(unit: 'week' | 'month' | 'quarter', day: number): { start: number; end: number; label: string } {
  const start = unitStart(unit, day)
  const p = parts(start)
  const label =
    unit === 'week'
      ? `the week of ${MONTHS[p.month]} ${p.date}`
      : unit === 'month'
        ? `${MONTHS_LONG[p.month]} ${p.year}`
        : `Q${Math.floor(p.month / 3) + 1} ${p.year}`
  return { start, end: nextUnit(unit, start) - 1, label }
}

/** A day as a menu names it: "Mon, Sep 28". */
export function dayLabel(day: number): string {
  return new Date(day * MS_PER_DAY).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function tickLabel(unit: ScaleUnit, start: number, pxPerDay: number, row: 'top' | 'bottom'): string {
  const p = parts(start)
  switch (unit) {
    case 'day':
      return pxPerDay >= 36 ? `${WEEKDAYS[p.weekday]} ${p.date}` : String(p.date)
    case 'week':
      return `${MONTHS[p.month]} ${p.date}`
    case 'month':
      return row === 'top' ? `${MONTHS_LONG[p.month]} ${p.year}` : MONTHS[p.month]
    case 'quarter':
      return `Q${Math.floor(p.month / 3) + 1}`
    case 'year':
      return String(p.year)
  }
}

/** The ticks of one unit covering the day range `[from, to)`, whole units at both ends. */
export function ticks(unit: ScaleUnit, from: number, to: number, pxPerDay: number, row: 'top' | 'bottom'): ScaleTick[] {
  const out: ScaleTick[] = []
  for (let start = unitStart(unit, from); start < to; ) {
    const end = nextUnit(unit, start)
    out.push({ start, end, label: tickLabel(unit, start, pxPerDay, row) })
    start = end
  }
  return out
}

/** Weekends are only worth shading once a day is wide enough to see. */
export function showsWeekends(pxPerDay: number): boolean {
  return pxPerDay >= 6
}

/**
 * The scroll offset that keeps the day under an anchor at the same screen
 * position across a zoom — which is what zooming around the pointer means.
 * `anchorX` is measured from the scale's visible left edge.
 */
export function anchoredScroll(scrollLeft: number, anchorX: number, fromPx: number, toPx: number): number {
  const daysUnderAnchor = (scrollLeft + anchorX) / fromPx
  return Math.max(0, daysUnderAnchor * toPx - anchorX)
}

/** The zoom that fits `days` into `width` pixels, clamped to the allowed range. */
export function fitPxPerDay(days: number, width: number): number {
  return clampPxPerDay(width / Math.max(1, days))
}

/**
 * The day range the scale spans: every date given and today, padded so there
 * is room to schedule before and after, widened to whole years so the header
 * never starts in the middle of a label. `to` is exclusive.
 */
export function scaleRange(dates: CalendarDate[], todayDay: number, padDays = 120): { from: number; to: number } {
  let min = todayDay
  let max = todayDay
  for (const date of dates) {
    const day = toDay(date)
    min = Math.min(min, day)
    max = Math.max(max, day)
  }
  return { from: unitStart('year', min - padDays), to: nextUnit('year', unitStart('year', max + padDays)) }
}
