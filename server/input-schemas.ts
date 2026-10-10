// The input schemas extension.json declares for the `tasks` App's actions, as
// the boundary check (action-params.ts) applies them and the generated
// parameter types (scripts/action-inputs.ts) read them.

import manifest from '../extension.json' with { type: 'json' }

/** The part of JSON Schema the manifest's input schemas use at the top level. */
export interface ParamSchema {
  type?: string | string[]
  enum?: unknown[]
  items?: ParamSchema
  properties?: Record<string, ParamSchema>
  required?: string[]
}

/** The `tasks` App's input schemas, by action id. */
export const inputSchemas: Record<string, ParamSchema> = Object.fromEntries(
  (manifest.provides.apps.find((app) => app.type === 'tasks')?.actions ?? []).map((action) => [
    action.id,
    action.inputSchema as ParamSchema,
  ]),
)

/** The types a schema names, none when it names no type. */
export const typesOf = (schema: ParamSchema): string[] => (schema.type === undefined ? [] : [schema.type].flat())
