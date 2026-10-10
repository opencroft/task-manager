// A task list's filters in the URL, so a filtered list is a link: `<field>`
// holds the values to include and `not.<field>` the values to exclude, each
// comma-separated, e.g. `?label=ui&not.label=wontfix`.
//
// Every value is read against a baseline (a saved view's, or nothing): a
// field the URL leaves out shows the baseline's value, and a value is written
// only when it differs from the baseline. A present but empty parameter is
// "nothing", which is how a URL says it differs from a baseline that has
// something.

import { compactFieldFilter, type FieldFilter, fieldFilterOf } from '../../shared/filters'

const excludeParam = (field: string) => `not.${field}`

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : [])

/** Both lists of `filter` as the URL (and the filter bar) spell its values. */
export function selectionOf(filter: FieldFilter<string | number> | undefined): {
  include: string[]
  exclude: string[]
} {
  const { include, exclude } = fieldFilterOf(filter)
  return { include: include.map(String), exclude: exclude.map(String) }
}

const sameValues = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',')

/** One field's filter as the URL holds it against `baseline`, with both lists present. */
export function selectionOfQuery(
  query: URLSearchParams,
  field: string,
  baseline?: FieldFilter<string | number>,
): { include: string[]; exclude: string[] } {
  if (!query.has(field) && !query.has(excludeParam(field))) {
    return selectionOf(baseline)
  }
  return { include: list(query.get(field)), exclude: list(query.get(excludeParam(field))) }
}

/** The URL parameters that hold `selection` for `field` against `baseline`; null removes one. */
export function selectionParams(
  field: string,
  selection: FieldFilter<string | number> | undefined,
  baseline?: FieldFilter<string | number>,
): Record<string, string | null> {
  const next = selectionOf(selection)
  const base = selectionOf(baseline)
  if (sameValues(next.include, base.include) && sameValues(next.exclude, base.exclude)) {
    return { [field]: null, [excludeParam(field)]: null }
  }
  const nothing = next.include.length === 0 && next.exclude.length === 0
  return {
    [field]: next.include.length ? next.include.join(',') : nothing ? '' : null,
    [excludeParam(field)]: next.exclude.length ? next.exclude.join(',') : null,
  }
}

/** The URL parameters that clear every one of `fields` against `baseline`, a filter holding them. */
export function clearedParams(fields: readonly string[], baseline: object = {}): Record<string, string | null> {
  const of = (field: string) => (baseline as Record<string, FieldFilter<string | number> | undefined>)[field]
  return Object.assign({}, ...fields.map((field) => selectionParams(field, undefined, of(field))))
}

/** A single-valued parameter against `baseline`: the URL's value when it has the parameter, else the baseline's. */
export function textOfQuery(query: URLSearchParams, name: string, baseline: string): string {
  return query.get(name) ?? baseline
}

/** The value to write for a single-valued parameter: null when it is the baseline's, else the value, empty for nothing. */
export function textParam(value: string, baseline: string): string | null {
  return value === baseline ? null : value
}

/** One field's filter as `task_list` takes it, values mapped by `as`; undefined when it filters nothing. */
export function fieldInput<T = string>(
  selection: { include: string[]; exclude: string[] },
  as: (value: string) => T = (value) => value as T,
): FieldFilter<T> | undefined {
  return compactFieldFilter({ include: selection.include.map(as), exclude: selection.exclude.map(as) })
}
