// Seam owned by versions. The server entry spreads `versionActions` into the
// `tasks` App's actions: list, create, edit (and archive) and release.

import type { VersionActionId } from '../../shared/versions.ts'
import { scopedActions } from '../actions.ts'
import { createVersion, listVersions, releaseVersion, updateVersion } from './store.ts'

export const versionActions = scopedActions<VersionActionId>({
  version_list: (s, input) => listVersions(s, input),
  version_create: (s, input) => createVersion(s, input),
  version_update: (s, input) => updateVersion(s, input),
  version_release: (s, input) => releaseVersion(s, input),
})
