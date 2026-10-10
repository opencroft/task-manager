// Type tests for `CheckedActionMap`: the typecheck compiles this file, and
// nothing runs it. Each refused map sits under `@ts-expect-error`, so a
// change that makes the check accept it leaves an unused directive, which is
// itself a type error.
//
// The check reaches the top level of an input only. A nested object that the
// schema gives as `Record<string, unknown>` (a workflow draft, a filter) takes
// any keys there, and the handler checks them.

import type { ActionInputs } from '../shared/action-inputs'
import type { WorkflowDraft } from '../shared/workflows'
import type { CheckedActionMap } from '../src/lib/api'

type AcceptedMap = {
  task_get: { input: ActionInputs['task_get']; output: unknown }
  task_create: { input: Omit<ActionInputs['task_create'], 'priority'> & { priority?: 'high' }; output: unknown }
  inbox_mark_read: { input: { ids: string[] } | { all: true }; output: unknown }
  workflow_save: { input: { workflow: WorkflowDraft }; output: unknown }
}
export type Accepted = CheckedActionMap<AcceptedMap>

type ExtraKeyMap = { task_get: { input: ActionInputs['task_get'] & { bogus?: string }; output: unknown } }
// @ts-expect-error a parameter the schema lacks
export type ExtraKey = CheckedActionMap<ExtraKeyMap>

type UnionExtraKeyMap = {
  inbox_mark_read: { input: { ids: string[] } | { all: true; everything?: boolean }; output: unknown }
}
// @ts-expect-error a parameter the schema lacks, in one member of a union
export type UnionExtraKey = CheckedActionMap<UnionExtraKeyMap>

type WiderEnumMap = {
  task_create: { input: Omit<ActionInputs['task_create'], 'priority'> & { priority?: string }; output: unknown }
}
// @ts-expect-error a value wider than the schema's enum
export type WiderEnum = CheckedActionMap<WiderEnumMap>

type UnknownActionMap = { task_frobnicate: { input: Record<string, never>; output: unknown } }
// @ts-expect-error an action `extension.json` does not declare
export type UnknownAction = CheckedActionMap<UnknownActionMap>

type MissingRequiredMap = { task_get: { input: Omit<ActionInputs['task_get'], 'key'>; output: unknown } }
// @ts-expect-error a required parameter left out
export type MissingRequired = CheckedActionMap<MissingRequiredMap>

type NestedExtraKeyMap = { workflow_save: { input: { workflow: WorkflowDraft; dryRun?: boolean }; output: unknown } }
// @ts-expect-error a parameter the schema lacks, beside a nested shape
export type NestedExtraKey = CheckedActionMap<NestedExtraKeyMap>
