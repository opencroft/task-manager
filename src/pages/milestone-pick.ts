// Which milestone the Timeline opens on, as a rule free of the host and of
// React, so it runs in unit tests as it runs in the page.

import type { Milestone } from '../../shared/milestones'

/**
 * The milestone shown when nothing names one: the open milestone whose target
 * is the earliest on or after `todayDate`, else the first open one. `open` is
 * in the listing order (open ones by target date, undated last).
 */
export function defaultMilestone<M extends Pick<Milestone, 'targetDate'>>(
  open: readonly M[],
  todayDate: string,
): M | null {
  return open.find((milestone) => milestone.targetDate !== null && milestone.targetDate >= todayDate) ?? open[0] ?? null
}

export interface MilestonePick<M> {
  milestone: M | null
  /** The URL does not name the milestone shown (or names one while none is shown), so it is rewritten in place, with no history entry. */
  rewrite: boolean
}

/**
 * The milestone to show, from the URL's name, else the one remembered, else
 * the default. A name matches ignoring case, as milestone names are unique
 * that way. A name that resolves to no open milestone (renamed, archived,
 * deleted) gives the fallback and has the URL rewritten.
 */
export function pickMilestone<M extends Pick<Milestone, 'id' | 'name' | 'targetDate'>>(
  open: readonly M[],
  param: string | null,
  rememberedId: string | null,
  todayDate: string,
): MilestonePick<M> {
  const named = param === null ? undefined : open.find((m) => m.name.toLowerCase() === param.toLowerCase())
  if (named) {
    return { milestone: named, rewrite: named.name !== param }
  }
  const milestone = open.find((m) => String(m.id) === rememberedId) ?? defaultMilestone(open, todayDate)
  // With no open milestone at all, a name left in the URL is dropped.
  return { milestone, rewrite: milestone !== null || param !== null }
}
