// Versions: the project's semantic releases that tasks are planned into. A
// version is named by its semver (unique in the project), is planned until it
// is released, and is archived once nobody plans against it any more. A task
// has at most one. The actions' shapes, shared by the server seam
// (server/versions) and the UI.

import type { ActionInputs } from './action-inputs.ts'
import type { CalendarDate, MutationResult, TaskKey } from './types.ts'

export type VersionState = 'planned' | 'released' | 'archived'
export const VERSION_STATES: readonly VersionState[] = ['planned', 'released', 'archived']

/**
 * `MAJOR.MINOR.PATCH` with an optional `-pre` of dot-separated identifiers, as
 * semver.org defines them: no leading zeros in a number, no build metadata.
 */
export const VERSION_NAME_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** One version of the project, as `version_list` returns it with `detail: "full"`. */
export interface Version {
  id: number
  name: string
  state: VersionState
  /** When it is meant to ship; null when not set. */
  targetDate: CalendarDate | null
  /** The day it was released; null until then. */
  releasedAt: CalendarDate | null
  /** One line. */
  description: string
  /** Its tasks whose status is not in the done category. */
  openCount: number
  /** Its tasks whose status is in the done category. */
  doneCount: number
  createdAt: string
  updatedAt: string
}

/** A version as a compact row: empty fields left out, counts only when non-zero. */
export interface VersionRow {
  name: string
  state: VersionState
  targetDate?: CalendarDate
  releasedAt?: CalendarDate
  description?: string
  open?: number
  done?: number
}

/** A version as an input: its name, or its id. */
export type VersionRef = string | number

export interface VersionReleaseResult {
  version: Version
  /** The open tasks moved off it, and where to (null: out of any version). */
  moved: { keys: TaskKey[]; to: string | null }
  /** The version's done tasks grouped by type, as markdown. */
  notes: string
}

export interface VersionActionMap {
  version_list: { input: ActionInputs['version_list']; output: { versions: Version[] } }
  version_create: { input: ActionInputs['version_create']; output: MutationResult<Version> }
  version_update: { input: ActionInputs['version_update']; output: MutationResult<Version> }
  version_release: { input: ActionInputs['version_release']; output: MutationResult<VersionReleaseResult> }
}

export type VersionActionId = keyof VersionActionMap

/** Semver precedence: numbers by value, then a pre-release before its release, identifiers compared as semver.org orders them. */
export function compareVersionNames(a: string, b: string): number {
  const pa = VERSION_NAME_PATTERN.exec(a)
  const pb = VERSION_NAME_PATTERN.exec(b)
  if (!pa || !pb) {
    return a.localeCompare(b)
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) {
      return Math.sign(diff)
    }
  }
  const preA = pa[4]
  const preB = pb[4]
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1
  }
  const idsA = preA.split('.')
  const idsB = preB.split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i]
    const y = idsB[i]
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1
    }
    const numX = /^\d+$/.test(x)
    const numY = /^\d+$/.test(y)
    if (numX && numY) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) {
        return Math.sign(diff)
      }
    } else if (numX !== numY) {
      return numX ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
