// Which sections a board column shows. At rest, those of its statuses that
// have cards, in the setup's order. While a card is dragged, every status of
// the column, so each is a drop place: those with no cards follow at the
// bottom. A column of one status leaves its section unlabelled, since the
// column's header already names it.

export interface ShownSection<S> {
  status: S
  labelled: boolean
}

export function shownSections<S>(statuses: readonly S[], hasCards: (status: S) => boolean, dragging: boolean): ShownSection<S>[] {
  const labelled = statuses.length > 1
  const filled = statuses.filter(hasCards)
  const empty = dragging ? statuses.filter((status) => !hasCards(status)) : []
  return [...filled, ...empty].map((status) => ({ status, labelled }))
}
