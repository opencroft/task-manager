// Project settings: what the project is called, and its labels as a managed
// set (counts, colours, rename, merge, delete). Statuses, workflows and the
// space's chat keep their own actions; the settings page gathers them.

import type { MutationResult } from './types.ts'

/** A label's colour: a named palette entry, so every chip stays readable in light and dark. */
export const LABEL_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'sky', 'blue', 'violet', 'pink'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

/** One label of the project. Labels are plain strings on tasks, so the name is the identity. */
export interface ProjectLabel {
  name: string
  /** Null: no colour chosen, a neutral chip. */
  color: LabelColor | null
  /** Tasks carrying it. */
  count: number
}

export interface ProjectInfo {
  /** The App's display name; renamed where the space's apps are edited. */
  name: string
  /** The App's `id` parameter, the prefix of every task key. */
  key: string
  /** Where agents reach the App's actions: `<space>.<slug>`, as `app_call` takes it. */
  address: string
  /** The App's space; its chat (the group chat at the same slug) is where the task manager talks. */
  space: string
}

/** What a label change did: the label as it is now (null once gone), and the tasks it rewrote. */
export interface LabelChange {
  label: ProjectLabel | null
  tasks: number
}

export interface SettingsActionMap {
  project_info: { input: Record<string, never>; output: ProjectInfo }
  label_overview: { input: Record<string, never>; output: { labels: ProjectLabel[] } }
  label_rename: { input: { label: string; to: string }; output: MutationResult<LabelChange> }
  label_merge: { input: { label: string; into: string }; output: MutationResult<LabelChange> }
  label_delete: { input: { label: string }; output: MutationResult<LabelChange> }
  label_color: { input: { label: string; color: LabelColor | null }; output: MutationResult<LabelChange> }
}

export type SettingsActionId = keyof SettingsActionMap
