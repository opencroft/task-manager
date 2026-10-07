// The task manager's shared contract: the shapes the server
// stores and returns, the inputs every action takes, and the live-refresh
// payload. Isomorphic and free of runtime imports, so the server, the client
// and every page (Tasks, Timeline, Board, Workflows) read the same definitions.

import type { CommentRow } from './compact.ts'
import type { FieldFilterInput } from './filters.ts'
import type { ProjectRef, ProjectScope, ProjectsRead } from './projects.ts'

/** `<project id>-<number>`, e.g. `TASK-12`. Numbers are never reused within a project. */
export type TaskKey = string

/** `YYYY-MM-DD`, a calendar date with no time zone. End dates are inclusive. */
export type CalendarDate = string

export type StatusCategory = 'todo' | 'in_progress' | 'done'
export const STATUS_CATEGORIES: readonly StatusCategory[] = ['todo', 'in_progress', 'done']

export type TaskType = 'task' | 'bug' | 'story' | 'epic'
export const TASK_TYPES: readonly TaskType[] = ['task', 'bug', 'story', 'epic']

export type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest'
export const PRIORITIES: readonly Priority[] = ['lowest', 'low', 'medium', 'high', 'highest']

/** Who did something: an agent (by its name, as the host reports the caller) or a person. */
export interface Actor {
  kind: 'agent' | 'person'
  name: string
}

/**
 * Who a task is assigned to. An agent is identified by its agent node id (the
 * durable identifier a workflow addresses); `name` is the display name at the
 * time of assignment. A person from the user directory carries their user
 * `id`; a person named in free text (and assignments made before the
 * directory) carries a name only.
 */
export type Assignee = { kind: 'agent'; id: string; name: string } | { kind: 'person'; id?: string; name: string }

export interface Status {
  id: number
  name: string
  category: StatusCategory
  /** CSS color token or hex; null means the category's default color. */
  color: string | null
  position: number
}

/** One task as lists return it — enough to render a table row, a tree node, a card or a bar. */
export interface TaskSummary {
  key: TaskKey
  number: number
  summary: string
  status: Status
  type: TaskType
  priority: Priority
  assignee: Assignee | null
  /** Who created the task. */
  reporter: Actor
  parentKey: TaskKey | null
  childCount: number
  /** Direct children whose status category is `done`. */
  childDoneCount: number
  labels: string[]
  /** The version the task is planned into, by name and state; null for none. */
  version: { name: string; state: 'planned' | 'released' | 'archived' } | null
  startDate: CalendarDate | null
  endDate: CalendarDate | null
  /** Opaque fractional order key. Compare as strings; never compute one client-side. */
  rank: string
  createdAt: string
  updatedAt: string
  /** Every task that blocks this one; `open` while the blocker's status is not in the done category. */
  blockers: Array<{ key: TaskKey; open: boolean }>
  /** The pull requests that mention this task, counted by state. */
  prs: PullRequestCounts
  /** The App the task is in; only on answers across projects. */
  project?: ProjectRef
}

/** A forge pull request's state: merged is a closed one whose change landed. */
export type PullRequestState = 'open' | 'merged' | 'closed'

/** A pull request that mentions a task's key in its title, body or branch. */
export interface LinkedPullRequest {
  /** `owner/name` on the forge. */
  repo: string
  number: number
  title: string
  state: PullRequestState
  /** The forge login of whoever opened it. */
  author: string
  url: string
  /** The head branch, as it was while the pull request was open; null when never seen. */
  branch: string | null
  updatedAt: string
}

/** How many of a task's linked pull requests are in each state. */
export interface PullRequestCounts {
  open: number
  merged: number
  closed: number
}

export interface Comment {
  id: number
  author: Actor
  /** Markdown. */
  body: string
  createdAt: string
  updatedAt: string
  /** True when the caller wrote it: only its author can edit or delete a comment. */
  mine?: boolean
}

export type ActivityKind =
  | 'created'
  | 'field'
  | 'comment'
  | 'moved'
  | 'subtask_added'
  | 'subtask_removed'
  | 'attachment_added'
  | 'attachment_removed'

export interface ActivityEntry {
  id: number
  actor: Actor
  kind: ActivityKind
  /** For `field`: which field changed (`summary`, `status`, `assignee`, …). */
  field: string | null
  from: string | null
  to: string | null
  at: string
}

/** One task in full, as `task_get` returns it. */
export interface Task extends TaskSummary {
  /** Markdown. */
  description: string
  /** Ancestors from the root down to the direct parent, for breadcrumbs. */
  ancestors: Array<Pick<TaskSummary, 'key' | 'summary'>>
  subtasks: TaskSummary[]
  // The related tasks, each list in backlog order.
  /** The tasks this one blocks. */
  blocks: TaskSummary[]
  /** The tasks blocking this one: the only relation that holds a task back. */
  blockedBy: TaskSummary[]
  /** The tasks this one comes after. */
  follows: TaskSummary[]
  /** The tasks that come after this one. */
  precedes: TaskSummary[]
  /** The tasks this one duplicates. */
  duplicates: TaskSummary[]
  /** The tasks that duplicate this one. */
  duplicatedBy: TaskSummary[]
  /** The tasks related to this one, either way round. */
  relatesTo: TaskSummary[]
  comments: Comment[]
  activity: ActivityEntry[]
  /** The pull requests that mention this task, open ones first, then the most recently updated. */
  pullRequests: LinkedPullRequest[]
}

// ─── Action inputs ─────────────────────────────────────────────────────────

/** A status reference: its id, or its name (case-insensitive). */
export type StatusRef = number | string

/**
 * An assignee as an input: an agent by node id or by name, or a person by user
 * id or by name. A bare string must name someone `assignee_list` offers: an
 * agent first, then a person. `{kind:"person", name}` naming nobody in the
 * directory assigns that name as free text.
 */
export type AssigneeInput =
  | string
  | { kind: 'agent'; id?: string; name?: string }
  | { kind: 'person'; id?: string; name?: string }

export type TaskSortField =
  | 'rank'
  | 'key'
  | 'summary'
  | 'status'
  | 'type'
  | 'priority'
  | 'assignee'
  | 'reporter'
  | 'startDate'
  | 'endDate'
  | 'createdAt'
  | 'updatedAt'

export interface TaskSort {
  field: TaskSortField
  dir: 'asc' | 'desc'
}

/**
 * The filters combine with AND. Each list-valued one is a `FieldFilterInput`:
 * a plain list matches any of its values, and `{ include, exclude }` also
 * hides a task with any excluded value, whatever it includes.
 */
export interface TaskListInput {
  /** Full-text substring search over key, summary and description. */
  query?: string
  status?: FieldFilterInput<StatusRef>
  statusCategory?: FieldFilterInput<StatusCategory>
  /** Assignee names; `'me'` is the caller, `'none'` matches unassigned. */
  assignee?: FieldFilterInput<string>
  type?: FieldFilterInput<TaskType>
  priority?: FieldFilterInput<Priority>
  label?: FieldFilterInput<string>
  /** Version names; `'none'` matches tasks in no version. */
  version?: FieldFilterInput<string>
  /** Direct children of these keys; `'none'` matches top-level tasks. */
  parent?: FieldFilterInput<TaskKey | 'none'>
  /** true: only tasks with dates; false: only tasks without. */
  scheduled?: boolean
  /** true: only tasks an open pull request mentions; false: only tasks none does. */
  hasOpenPr?: boolean
  sort?: TaskSort
  /** Only the tasks a board shows: in its statuses and matching its filter, as well as the filters above. Its id or name. */
  board?: string
  /** Default 200, at most `TASK_LIST_MAX_LIMIT`. */
  limit?: number
  offset?: number
  /**
   * `all`: every project the caller can see, newest change first after exact
   * key matches. Takes only the filters that mean the same in every project.
   */
  scope?: ProjectScope
}

/** The most tasks one `task_list` call returns; page with `offset` past it. */
export const TASK_LIST_MAX_LIMIT = 1000

export interface TaskListResult {
  tasks: TaskSummary[]
  total: number
  /** Only across projects. */
  projects?: ProjectsRead
}

/** A task that has subtasks, as a parent filter lists it. */
export interface TaskParent {
  key: TaskKey
  summary: string
}

export interface TaskGetInput {
  key: TaskKey
  /** How many of the latest comments the compact answer holds, 1–50. Default 5. */
  commentsLimit?: number
}

export interface TaskCommentsInput {
  key: TaskKey
  /** The `next` of the page before: the comments older than that page. Omitted: the newest. */
  before?: string
  /** 1–50. Default 10. */
  limit?: number
}

/** One page of a task's comments, newest first. */
export interface TaskCommentsResult {
  key: TaskKey
  comments: CommentRow[]
  /** Every comment on the task. */
  total: number
  /** Pass as `before` for the older ones; absent on the last page. */
  next?: string
}

/** Where a created or moved task lands in rank order. Neither = last. */
export interface Position {
  before?: TaskKey
  after?: TaskKey
}

export interface TaskCreateInput extends Position {
  summary: string
  description?: string
  type?: TaskType
  priority?: Priority
  status?: StatusRef
  assignee?: AssigneeInput | null
  parent?: TaskKey | null
  labels?: string[]
  /** A version's name or id; null or `"none"` for none. */
  version?: string | number | null
  startDate?: CalendarDate | null
  endDate?: CalendarDate | null
}

export interface TaskUpdateInput {
  key: TaskKey
  summary?: string
  description?: string
  type?: TaskType
  priority?: Priority
  /** Goes through the same transition path (and hooks) as `task_change_status`. */
  status?: StatusRef
  assignee?: AssigneeInput | null
  labels?: string[]
  /** A version's name or id; null or `"none"` takes the task out of its version. */
  version?: string | number | null
  startDate?: CalendarDate | null
  endDate?: CalendarDate | null
}

export interface TaskChangeStatusInput {
  key: TaskKey
  status: StatusRef
  /** Optional markdown comment recorded with the transition. */
  comment?: string
}

export interface TaskMoveInput extends Position {
  key: TaskKey
  /** New parent; null makes it top-level; omitted keeps the current parent. */
  parent?: TaskKey | null
}

export interface TaskDeleteInput {
  key: TaskKey
  /** Required when the task has subtasks; deletes the whole subtree. */
  withSubtasks?: boolean
}

export interface TaskCommentInput {
  key: TaskKey
  body: string
}

export interface TaskCommentUpdateInput {
  key: TaskKey
  /** The comment's id, from `task_get`. */
  id: number
  body: string
}

export interface TaskCommentDeleteInput {
  key: TaskKey
  id: number
}

export interface StatusCreateInput {
  name: string
  category: StatusCategory
  color?: string | null
}

export interface StatusUpdateInput {
  status: StatusRef
  name?: string
  category?: StatusCategory
  color?: string | null
}

export interface StatusReorderInput {
  /** Every status, by id or name, in the new order. */
  order: StatusRef[]
}

export interface StatusDeleteInput {
  status: StatusRef
  /** Tasks in the deleted status move here. */
  moveTo: StatusRef
}

export interface AssigneeOption {
  assignee: Assignee
  /** For agents: the space the agent node lives in, when known. */
  detail?: string
}

/** An agent or a person in the host's user directory, with the picture the host shows for them. */
export interface PersonAvatar {
  kind: 'agent' | 'person'
  /** The agent node id, or the account id. */
  id: string
  name: string
  /** An image URL, often an inline `data:` one; null when they have no picture. */
  avatarUrl: string | null
}

/** Every mutating action returns what it changed, plus non-fatal hook warnings. */
export interface MutationResult<T> {
  result: T
  warnings?: string[]
}

// ─── Actions ───────────────────────────────────────────────────────────────

export interface TasksActionMap {
  task_list: { input: TaskListInput; output: TaskListResult }
  task_get: { input: TaskGetInput; output: Task }
  task_comments: { input: TaskCommentsInput; output: TaskCommentsResult }
  task_create: { input: TaskCreateInput; output: MutationResult<Task> }
  task_update: { input: TaskUpdateInput; output: MutationResult<Task> }
  task_change_status: { input: TaskChangeStatusInput; output: MutationResult<Task> }
  task_move: { input: TaskMoveInput; output: MutationResult<TaskSummary> }
  task_delete: { input: TaskDeleteInput; output: MutationResult<{ deleted: TaskKey[] }> }
  task_comment: { input: TaskCommentInput; output: MutationResult<Comment> }
  task_comment_update: { input: TaskCommentUpdateInput; output: MutationResult<Comment> }
  task_comment_delete: { input: TaskCommentDeleteInput; output: MutationResult<{ deleted: number }> }
  status_list: { input: Record<string, never>; output: Status[] }
  status_create: { input: StatusCreateInput; output: MutationResult<Status> }
  status_update: { input: StatusUpdateInput; output: MutationResult<Status> }
  status_reorder: { input: StatusReorderInput; output: MutationResult<Status[]> }
  status_delete: { input: StatusDeleteInput; output: MutationResult<{ moved: number }> }
  assignee_list: { input: Record<string, never>; output: AssigneeOption[] }
  avatar_list: { input: Record<string, never>; output: PersonAvatar[] }
  label_list: { input: Record<string, never>; output: string[] }
  task_parents: { input: Record<string, never>; output: TaskParent[] }
}

export type TasksActionId = keyof TasksActionMap

// ─── Live refresh ──────────────────────────────────────────────────────────

/** The `host.events` name every task-manager change is broadcast under. */
export const TASKS_EVENT = 'tasks.changed'

export interface TasksEvent {
  instanceId: string
  /** Affected task keys; empty for project-wide changes (statuses, label colours, versions). */
  keys: TaskKey[]
  kind: 'task' | 'status' | 'comment' | 'workflow' | 'label' | 'version' | 'board'
}

// ─── Shared helpers ────────────────────────────────────────────────────────

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/
export const TASK_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function assigneeLabel(assignee: Assignee | null): string {
  return assignee ? assignee.name : 'Unassigned'
}
