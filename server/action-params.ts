// Every action's parameters are checked against the input schema extension.json
// declares for it, before its handler runs. A caller that guessed a parameter
// name — usually an agent — is told what is missing, what is unknown with the
// closest real name, and what has the wrong type or a value outside its enum,
// rather than whatever the handler makes of the mistake. Only the top level is
// checked: a nested value, such as a workflow definition, is left to the
// handler that owns its shape. `ActionInputs` is generated from the same
// schemas (scripts/action-inputs.ts) and types exactly what this check proves.

import type { AppActionContext, AppActionHandler } from '@opencroft/server/apps'

import type { ActionId, ActionInputs } from '../shared/action-inputs.ts'
import { closestNames } from './closest-names.ts'
import { inputSchemas, type ParamSchema, typesOf } from './input-schemas.ts'
import { TaskError } from './service.ts'

// A wrong parameter name costs one refused call, and the refusal lists every
// real name, so its hint may reach further than a hint for a value.
const PARAMETER_TYPO_EDITS = 2

/** A value's type, as a refusal names it. */
function jsonType(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'array' : typeof value
}

/** Each type a schema may name, and the values that are one. A whole number is both an integer and a number. */
const SATISFIES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  null: (value) => value === null,
}

const fits = (types: readonly string[], value: unknown) => types.some((type) => SATISFIES[type]?.(value) ?? false)

const article = (type: string) => (type === 'null' ? 'null' : /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`)

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`)

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
function orList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : (items[0] ?? '')
}

/** What is wrong with the type of one parameter's value, or with its value against the enum, if anything. */
function typeProblem(name: string, schema: ParamSchema, value: unknown): string | undefined {
  const allowed = typesOf(schema)
  if (allowed.length > 0 && !fits(allowed, value)) {
    return `"${name}" must be ${orList(allowed.map(article))}, not ${article(jsonType(value))}.`
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `"${name}" must be one of ${orList(schema.enum.map((option) => JSON.stringify(option)))}, not ${JSON.stringify(value)}.`
  }
  const itemTypes = schema.items ? typesOf(schema.items) : []
  if (Array.isArray(value) && itemTypes.length > 0) {
    const at = value.findIndex((item) => !fits(itemTypes, item))
    if (at >= 0) {
      return `"${name}" must be a list of ${orList(itemTypes.map((type) => `${type}s`))}; item ${at + 1} is ${article(jsonType(value[at]))}.`
    }
  }
  return undefined
}

/** Refuses `params` with every problem against `schema` named at once, and the parameters `action` takes. */
export function checkParams(action: string, schema: ParamSchema, params: Record<string, unknown>): void {
  const declared = schema.properties ?? {}
  const names = Object.keys(declared)
  const required = schema.required ?? []
  const given = Object.entries(params).filter(([, value]) => value !== undefined)
  const problems: string[] = []

  const missing = required.filter((name) => !given.some(([key]) => key === name))
  if (missing.length > 0) {
    problems.push(`Missing ${missing.length === 1 ? 'parameter' : 'parameters'} ${quoted(missing).join(', ')}.`)
  }
  for (const [key, value] of given) {
    if (!Object.hasOwn(declared, key)) {
      const close = closestNames(key, names, PARAMETER_TYPO_EDITS)
      problems.push(
        `"${key}" isn't a parameter of ${action}${close.length > 0 ? `; did you mean ${orList(quoted(close))}?` : '.'}`,
      )
      continue
    }
    const problem = typeProblem(key, declared[key] ?? {}, value)
    if (problem) {
      problems.push(problem)
    }
  }
  if (problems.length === 0) {
    return
  }
  const accepted = names.map((name) => (required.includes(name) ? `${name} (required)` : name))
  throw new TaskError(
    `${problems.join(' ')} Parameters of ${action}: ${accepted.length > 0 ? accepted.join(', ') : 'none'}.`,
  )
}

/**
 * `params` of `action`, checked against its schema: refused with every problem
 * named when they do not fit it, and typed by it when they do.
 */
export function parseParams<A extends ActionId>(action: A, params: Record<string, unknown>): ActionInputs[A] {
  const schema = inputSchemas[action]
  if (!schema) {
    throw new Error(`Action ${action} has no input schema in extension.json`)
  }
  checkParams(action, schema, params)
  // ActionInputs is generated from this same schema, so the check just made is what this type claims.
  return params as ActionInputs[A]
}

/** One handler per action id, each given its context and its action's parameters as `parseParams` typed them. */
export type TypedHandlers<A extends ActionId, C> = { [K in A]: (context: C, input: ActionInputs[K]) => unknown }

/**
 * `handlers` as App actions: each runs on `contextOf` the call's context and
 * on its parameters once `parseParams` has checked them.
 */
export function typedActions<A extends ActionId, C>(
  handlers: TypedHandlers<A, C>,
  contextOf: (ctx: AppActionContext) => C,
): Record<string, AppActionHandler> {
  const action =
    <K extends A>(id: K): AppActionHandler =>
    (ctx, params) =>
      handlers[id](contextOf(ctx), parseParams(id, params ?? {}))
  return Object.fromEntries((Object.keys(handlers) as A[]).map((id) => [id, action(id)]))
}

/** Fails the load for a parameter typed with a name the checks do not know, which would refuse every value. */
function assertKnownTypes(action: string, schema: ParamSchema): void {
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const unknown = [...typesOf(property), ...(property.items ? typesOf(property.items) : [])].filter(
      (type) => !Object.hasOwn(SATISFIES, type),
    )
    if (unknown.length > 0) {
      throw new Error(
        `Action ${action}: parameter "${name}" has type ${quoted(unknown).join(', ')}; the checks know ${quoted(Object.keys(SATISFIES)).join(', ')}`,
      )
    }
  }
}

/**
 * `actions`, each checking its parameters against its schema before it runs.
 * An action with no schema in the manifest fails the load, so none can go
 * unchecked; so does a schema naming a type the checks do not know.
 */
export function withParamChecks(
  actions: Record<string, AppActionHandler>,
  schemas: Record<string, ParamSchema> = inputSchemas,
): Record<string, AppActionHandler> {
  return Object.fromEntries(
    Object.entries(actions).map(([id, handler]) => {
      const schema = schemas[id]
      if (!schema) {
        throw new Error(`Action ${id} has no input schema in extension.json`)
      }
      assertKnownTypes(id, schema)
      return [
        id,
        (ctx: AppActionContext, params: Record<string, unknown>) => {
          const input = params ?? {}
          checkParams(id, schema, input)
          return handler(ctx, input)
        },
      ]
    }),
  )
}
