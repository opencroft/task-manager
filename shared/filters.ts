// One filter model for every task list: the Tasks page, the board, a saved
// view, a board's preset filter and `task_list` hold a field's filter the
// same way, as the values to include and the values to exclude.

/**
 * One field's filter. A task passes when it has none of `exclude` and, if
 * `include` has any values, at least one of them: an exclude wins over an
 * include.
 *
 * A type rather than an interface, as every object shape `task_list` takes:
 * an interface is not assignable to the `Record<string, unknown>` its
 * generated input gives a nested object.
 */
export type FieldFilter<T> = {
  include?: T[]
  exclude?: T[]
}

/**
 * A field's filter in any form the server reads: a plain list, or a single
 * value, is the values to include. `task_list` takes a single value for
 * `parent` only; `fieldFilterOf`, `compactFilter` and the server's
 * `checkedFieldFilter` read every form.
 */
export type FieldFilterInput<T> = FieldFilterList<T> | T

/**
 * A field as the pages send most of them, to `task_list` and in a saved
 * view's or a board's filter: a plain list is the values to include.
 * `task_list`'s schema refuses a single value; the stored filters would take
 * one, but the pages share `task_list`'s type for them.
 */
export type FieldFilterList<T> = FieldFilter<T> | T[]

/** The fields of a saved view's filter that are a `FieldFilter`. */
export const VIEW_FIELD_FILTER_KEYS = ['status', 'assignee', 'type', 'priority', 'label', 'version', 'parent'] as const

/** Whether `value` is the object form, rather than a plain list or a single value. */
export function isFieldFilter(value: unknown): value is FieldFilter<unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Both lists of a field's filter, each without repeats. A value in both is
 * only excluded, since the exclude wins anyway.
 */
export function fieldFilterOf<T>(input: FieldFilterInput<T> | null | undefined): { include: T[]; exclude: T[] } {
  if (input === undefined || input === null || input === '') {
    return { include: [], exclude: [] }
  }
  if (isFieldFilter(input)) {
    const exclude = [...new Set(input.exclude ?? [])]
    return { include: [...new Set(input.include ?? [])].filter((value) => !exclude.includes(value)), exclude }
  }
  return { include: [...new Set(Array.isArray(input) ? input : [input as T])], exclude: [] }
}

/** A field's filter as it is stored: only its non-empty lists, or undefined when it filters nothing. */
export function compactFieldFilter<T>(input: FieldFilterInput<T> | null | undefined): FieldFilter<T> | undefined {
  const { include, exclude } = fieldFilterOf(input)
  if (include.length === 0 && exclude.length === 0) {
    return undefined
  }
  return { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) }
}

/**
 * `filter` with each of its `VIEW_FIELD_FILTER_KEYS` in the stored form: a
 * plain list or a single value becomes the values to include, and a field
 * that filters nothing is left out. Other fields pass through as they are.
 */
export function compactFilter<F extends object>(filter: F): F {
  const out: Record<string, unknown> = { ...(filter as Record<string, unknown>) }
  for (const key of VIEW_FIELD_FILTER_KEYS) {
    if (!(key in out)) {
      continue
    }
    const compact = compactFieldFilter(out[key])
    if (compact) {
      out[key] = compact
    } else {
      delete out[key]
    }
  }
  return out as F
}

/**
 * `filter` with `from` in `key`'s lists replaced by `to`, or dropped when
 * `to` is null; the same filter when `from` is not in them.
 */
export function replaceFilterValue<F extends object>(
  filter: F,
  key: (typeof VIEW_FIELD_FILTER_KEYS)[number],
  from: string,
  to: string | null,
): F {
  const { include, exclude } = fieldFilterOf((filter as Record<string, unknown>)[key] as FieldFilterInput<string>)
  if (!include.includes(from) && !exclude.includes(from)) {
    return filter
  }
  const swap = (values: string[]) => values.flatMap((value) => (value === from ? (to === null ? [] : [to]) : [value]))
  return compactFilter({ ...filter, [key]: { include: swap(include), exclude: swap(exclude) } })
}
