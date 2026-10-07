// Seam owned by versions. The server entry spreads `versionActions` into the
// `tasks` App's actions: list, create, edit (and archive) and release.

import type { AppActionHandler } from '@opencroft/server'

import type { VersionActionId } from '../../shared/versions.ts'
import { scopeFor } from '../actions.ts'
import type { Scope } from '../service.ts'
import { createVersion, listVersions, releaseVersion, updateVersion } from './store.ts'

// biome-ignore lint/suspicious/noExplicitAny: inputs are validated by the store
const handlers: Record<VersionActionId, (scope: Scope, params: any) => unknown> = {
  version_list: (s, params) => listVersions(s, params),
  version_create: (s, params) => createVersion(s, params),
  version_update: (s, params) => updateVersion(s, params),
  version_release: (s, params) => releaseVersion(s, params),
}

export const versionActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx, params) => handler(scopeFor(ctx), params ?? {})]),
)
