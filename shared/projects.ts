// Answers that span projects: `task_list` and `my_work` with `scope: "all"`
// read every task-manager App the caller can see, in one request, and tag
// each row with the App it came from.

/** Whose tasks an answer covers: the App called (default), or every one the caller can see. */
export type ProjectScope = 'this' | 'all'

/** The task-manager App a row comes from, on an answer across projects. */
export interface ProjectRef {
  /** The project key, the prefix of its task keys. */
  key: string
  /** The App's name. */
  name: string
  /** `<space>.<app>`: what `app_call` takes, and where the task opens. */
  app: string
}

/** Which projects an answer across projects read, so a cut is never silent. */
export interface ProjectsRead {
  /** Projects asked, the unavailable ones among them. */
  read: number
  /** Every project the caller can see; more than `read` when the answer stopped at `PROJECTS_READ_MAX`. */
  total: number
  /** Projects that could not be read, and why; the rest of the answer stands. */
  unavailable?: Array<ProjectRef & { error: string }>
}

/** How many projects one answer reads at most, oldest first. */
export const PROJECTS_READ_MAX = 50

/** `task_list`'s default page across projects, and its largest. */
export const ACROSS_LIST_DEFAULT = 50
export const ACROSS_LIST_MAX = 200
