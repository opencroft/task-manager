/**
 * "Did you mean" candidates for a name a caller got wrong. Callers are often
 * agents holding a partial name ("Bot" for "Bot (Review)") or a typo ("Reveiw"),
 * so a refusal that offers the likely intended names saves a lookup call.
 *
 * Case, spaces and punctuation are ignored. A name matches when one contains
 * the other (a partial name), or when it is a typo away: one edit, or two for
 * names of eight characters or more, with swapped neighbours counting as one.
 * Kept that tight on purpose: "Doing" must not suggest "Done", because a
 * caller who follows a wrong suggestion moves the task somewhere it did not mean.
 */

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Edits between `a` and `b`, where an edit inserts, deletes or replaces one character, or swaps two neighbours. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  const at = (i: number, j: number) => d[i]?.[j] ?? 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1)
      }
      const row = d[i]
      if (row) {
        row[j] = best
      }
    }
  }
  return at(a.length, b.length)
}

const typoAllowance = (text: string) => (text.length >= 8 ? 2 : 1)

/**
 * Up to three of `names` close to `wanted`: partial matches first, then typos, each in the order given.
 * `maxEdits` widens the typo allowance where following a wrong suggestion writes nothing.
 */
export function closestNames(wanted: string, names: readonly string[], maxEdits?: number): string[] {
  const target = normal(wanted)
  if (!target) {
    return []
  }
  const allowance = maxEdits ?? typoAllowance(target)
  const partial = names.filter((name) => {
    const candidate = normal(name)
    return candidate !== '' && (candidate.includes(target) || target.includes(candidate))
  })
  const typos = names.filter((name) => !partial.includes(name) && editDistance(normal(name), target) <= allowance)
  return [...partial, ...typos].slice(0, 3)
}

/** ` Did you mean A, B?` when anything is close, else empty: appended to a "No such …" message. */
export function didYouMean(wanted: string, names: readonly string[]): string {
  const close = closestNames(wanted, names)
  return close.length > 0 ? ` Did you mean ${close.map((name) => `"${name}"`).join(', ')}?` : ''
}
