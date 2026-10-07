// Reading every project the caller can see, one after another, in the request
// that asked. Pure: instances and a reader in, results tagged with their
// project out — the host is reached only through ./index.ts, so this runs
// under `node --test`.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import { PROJECTS_READ_MAX, type ProjectRef, type ProjectsRead } from '../../shared/projects.ts'
import { TaskError } from '../service.ts'

/** One task-manager App, as the host lists it. */
export interface ProjectInstance {
  instanceId: string
  spaceSlug: string
  name: string
  slug: string
  params: Record<string, string>
  dataDir: string
}

export function projectRefOf(instance: ProjectInstance): ProjectRef {
  return { key: (instance.params.id ?? '').trim(), name: instance.name, app: `${instance.spaceSlug}.${instance.slug}` }
}

export interface Across<T> {
  /** Each project read, in the order given. */
  parts: Array<{ project: ProjectRef; value: T }>
  projects: ProjectsRead
}

/**
 * `read` for each of the first `max` instances. A project whose read throws
 * is reported under `unavailable` and the rest still answer; the instances
 * past `max` are counted in `total`, so the cut shows.
 */
export async function acrossProjects<T>(
  instances: ProjectInstance[],
  read: (instance: ProjectInstance) => T | Promise<T>,
  max = PROJECTS_READ_MAX,
): Promise<Across<T>> {
  const asked = instances.slice(0, max)
  const parts: Across<T>['parts'] = []
  const unavailable: NonNullable<ProjectsRead['unavailable']> = []
  for (const instance of asked) {
    const project = projectRefOf(instance)
    try {
      parts.push({ project, value: await read(instance) })
    } catch (error) {
      unavailable.push({ ...project, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { parts, projects: { read: asked.length, total: instances.length, ...(unavailable.length > 0 ? { unavailable } : {}) } }
}

/**
 * An action taking `scope`: the action as it was for `"this"` (or none), with
 * the parameter taken off; `across` for `"all"`; anything else refused.
 */
export function scoped(own: AppActionHandler, across: (ctx: AppActionContext, params: Record<string, unknown>) => unknown): AppActionHandler {
  return (ctx, params) => {
    const { scope, ...rest } = params ?? {}
    if (scope === undefined || scope === 'this') {
      return own(ctx, rest)
    }
    if (scope === 'all') {
      return across(ctx, rest)
    }
    throw new TaskError('scope is "this" (the default: this project) or "all" (every project you can see)')
  }
}

/** Every item of every part, each carrying its part's project. */
export function tagged<T extends object>(parts: Array<{ project: ProjectRef; value: T[] }>): Array<T & { project: ProjectRef }> {
  return parts.flatMap(({ project, value }) => value.map((item) => ({ ...item, project })))
}
