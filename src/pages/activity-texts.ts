// A task read leaves a description edit's texts out of its history and marks
// the entry `textsAvailable`; the History tab fetches them with
// `task_activity_texts` and puts them back. An edit folded into an entry keeps
// the entry's id and moves its time, so fetched texts are keyed by both: a
// stamp `<id>@<at>` (an ISO time holds no `@`).

import type { ActivityEntry, ActivityTexts } from '../../shared/types'

function stampOf(entry: Pick<ActivityEntry, 'id' | 'at'>): string {
  return `${entry.id}@${entry.at}`
}

/** The stamps of the entries whose texts the History tab needs, comma-separated: one value for an effect to depend on. */
export function textsWanted(entries: ActivityEntry[]): string {
  return entries
    .filter((entry) => entry.textsAvailable)
    .map(stampOf)
    .join(',')
}

/**
 * The fetched texts by the stamp each entry had when they were asked for
 * (`wanted`, from `textsWanted`). Texts of an entry that was not asked for are dropped.
 */
export function textsByStamp(wanted: string, fetched: ActivityTexts[]): Map<string, ActivityTexts> {
  const stampById = new Map(
    (wanted ? wanted.split(',') : []).map((stamp) => [Number(stamp.slice(0, stamp.indexOf('@'))), stamp]),
  )
  const byStamp = new Map<string, ActivityTexts>()
  for (const texts of fetched) {
    const stamp = stampById.get(texts.id)
    if (stamp !== undefined) {
      byStamp.set(stamp, texts)
    }
  }
  return byStamp
}

/** Whether some entry in `wanted` has no texts fetched for its current version. */
export function textsMissing(wanted: string, byStamp: Map<string, ActivityTexts>): boolean {
  return wanted !== '' && wanted.split(',').some((stamp) => !byStamp.has(stamp))
}

/** The entries with their texts in place where they were fetched for the entry's current version. */
export function withActivityTexts(entries: ActivityEntry[], byStamp: Map<string, ActivityTexts>): ActivityEntry[] {
  return entries.map((entry) => {
    const texts = entry.textsAvailable ? byStamp.get(stampOf(entry)) : undefined
    return texts ? { ...entry, from: texts.from, to: texts.to } : entry
  })
}
