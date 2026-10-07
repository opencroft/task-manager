// The server half of task keys in markdown (see shared/references.ts): which
// projects exist, and the tasks behind a batch of keys, across every
// task-manager App. Pure over its inputs -- the instances and a per-project
// reader come in -- so it runs under `node --test`.

import { projectOfKey, REFERENCE_RESOLVE_MAX, type ReferenceProject, type TaskReference } from '../shared/references.ts'
import type { TaskKey, TaskSummary } from '../shared/types.ts'
import { type ProjectInstance, projectRefOf } from './projects/across.ts'

export function referenceProjects(instances: ProjectInstance[]): ReferenceProject[] {
  return instances
    .map((instance) => {
      const { key, app } = projectRefOf(instance)
      return { key, app, instanceId: instance.instanceId }
    })
    .filter((project) => project.key)
}

/**
 * The tasks behind `keys`, one read per project that owns any of them. A key
 * of no known project, or of a task that does not exist, answers null. A
 * project that cannot be read fails the whole answer rather than reporting its
 * tasks as missing, so the keys are asked again.
 */
export async function resolveReferences(
  instances: ProjectInstance[],
  keys: unknown,
  read: (instance: ProjectInstance, numbers: number[]) => TaskSummary[] | Promise<TaskSummary[]>,
): Promise<Record<TaskKey, TaskReference | null>> {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw new Error('keys is a list of task keys')
  }
  const asked = [...new Set(keys as string[])].slice(0, REFERENCE_RESOLVE_MAX)
  const byProject = new Map<string, number[]>()
  const answer: Record<TaskKey, TaskReference | null> = {}
  for (const key of asked) {
    const parsed = projectOfKey(key)
    answer[key] = null
    if (parsed) {
      byProject.set(parsed.project, [...(byProject.get(parsed.project) ?? []), parsed.number])
    }
  }
  for (const instance of instances) {
    const project = projectRefOf(instance)
    const numbers = byProject.get(project.key)
    if (!numbers) {
      continue
    }
    for (const task of await read(instance, numbers)) {
      answer[task.key] = {
        key: task.key,
        summary: task.summary,
        type: task.type,
        status: { name: task.status.name, category: task.status.category, color: task.status.color },
        app: project.app,
      }
    }
  }
  return answer
}
