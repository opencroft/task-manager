// The project's versions in the shapes the kit's components take. The server
// numbers versions; the kit keys them by string, and the server resolves a
// digit string back to the id, so an id can go either way. Filters and saved
// views name versions, as task_list does.

import type { TaskFilterDef } from '@/components/ui/tasks/task-filter-bar'
import { type TaskVersion, TaskVersionChip, sortVersions } from '@/components/ui/tasks/task-version-chip'

import type { Version } from '../../shared/versions'

export function toTaskVersion(version: Version): TaskVersion {
  return { ...version, id: String(version.id) }
}

/** The Version filter of Tasks and Board: "No version", then every version, archived ones last. */
export function versionFilter(versions: readonly Version[]): TaskFilterDef {
  return {
    id: 'version',
    label: 'Version',
    options: [
      { value: 'none', label: 'No version' },
      ...sortVersions(versions).map((version) => ({
        value: version.name,
        label: version.name,
        icon: <TaskVersionChip name={version.name} state={version.state} variant="outline" />,
      })),
    ],
    emptyText: 'No versions yet',
  }
}
