// How the UI names an assignee back to the server, and tells two apart: by id
// wherever there is one (every agent, a person from the user directory), by
// name only for a person outside the directory.

import type { AssigneeInput } from '../../shared/types'

/** An assignee as the pages and the kit's menus carry it. */
export interface AssigneeRef {
  kind: 'agent' | 'person'
  id?: string
  name: string
}

/** A stable key for pickers: one per assignee, never shared by a namesake. */
export function assigneeKey(assignee: AssigneeRef | null): string {
  if (!assignee) {
    return 'none'
  }
  return assignee.id ? `${assignee.kind}:${assignee.id}` : `${assignee.kind}-name:${assignee.name}`
}

/** The input that assigns exactly this assignee. */
export function assigneeInput(assignee: AssigneeRef | null): AssigneeInput | null {
  if (!assignee) {
    return null
  }
  if (assignee.kind === 'agent') {
    return { kind: 'agent', id: assignee.id, name: assignee.name }
  }
  return assignee.id ? { kind: 'person', id: assignee.id } : { kind: 'person', name: assignee.name }
}
