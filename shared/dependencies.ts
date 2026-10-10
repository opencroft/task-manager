// Relations between tasks: one task blocks, duplicates, follows or relates to
// another. The actions' shapes, shared by the server seam (server/dependencies)
// and the UI. Only blocks holds a task back; the others are for reading.

import type { ActionInputs } from './action-inputs.ts'
import type { MutationResult, Task, TaskKey } from './types.ts'

/** Each relation reads "from <type> to"; relates runs both ways. */
export const RELATION_TYPES = ['blocks', 'relates', 'duplicates', 'follows'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** The other end's name for a relation, which swaps from and to. */
export const INVERSE_RELATION_TYPES = {
  blocked_by: 'blocks',
  duplicated_by: 'duplicates',
  precedes: 'follows',
} as const satisfies Record<string, RelationType>
export type RelationTypeName = RelationType | keyof typeof INVERSE_RELATION_TYPES

/**
 * A task's relations as `task_get` groups them, each a list of tasks, and in
 * the order the task page shows them.
 */
export const RELATION_GROUPS = [
  'blockedBy',
  'blocks',
  'follows',
  'precedes',
  'duplicates',
  'duplicatedBy',
  'relatesTo',
] as const
export type RelationGroup = (typeof RELATION_GROUPS)[number]

/** Which relation each group is, and whether the task is its `from` end. */
export const RELATION_GROUP_OF: Record<RelationGroup, { type: RelationType; taskIsFrom: boolean }> = {
  blockedBy: { type: 'blocks', taskIsFrom: false },
  blocks: { type: 'blocks', taskIsFrom: true },
  follows: { type: 'follows', taskIsFrom: true },
  precedes: { type: 'follows', taskIsFrom: false },
  duplicates: { type: 'duplicates', taskIsFrom: true },
  duplicatedBy: { type: 'duplicates', taskIsFrom: false },
  relatesTo: { type: 'relates', taskIsFrom: true },
}

/** How each relation reads from its `from` end, e.g. "TASK-3 relates to TASK-7". */
export const RELATION_WORDS: Record<RelationType, string> = {
  blocks: 'blocks',
  relates: 'relates to',
  duplicates: 'duplicates',
  follows: 'follows',
}

/** The `task_link` input that puts `other` in `group` of the task `key`. */
export function relationInput(
  group: RelationGroup,
  key: TaskKey,
  other: TaskKey,
): { type: RelationType; from: TaskKey; to: TaskKey } {
  const { type, taskIsFrom } = RELATION_GROUP_OF[group]
  return taskIsFrom ? { type, from: key, to: other } : { type, from: other, to: key }
}

export interface DependencyActionMap {
  /** `from` <type> `to`; returns the `to` task. Linking a pair that is already linked changes nothing. */
  task_link: { input: ActionInputs['task_link']; output: MutationResult<Task> }
  /** Returns the `to` task. */
  task_unlink: { input: ActionInputs['task_unlink']; output: MutationResult<Task> }
}

export type DependencyActionId = keyof DependencyActionMap
