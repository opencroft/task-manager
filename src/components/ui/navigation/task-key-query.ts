/** The task a key-shaped search names: `project` is null when only the number was given (`7`, `#7`). */
export interface TaskKeyQuery {
  project: string | null
  number: number
}

// Any dash a copied or typeset key can carry (hyphen, non-breaking hyphen,
// en and em dash, full-width hyphen, and the minus sign) reads as `-`.
const DASHES = /[\p{Pd}\u{2212}]/gu
// Punctuation around the key (`TASK-7:`, `(TASK-7)`, `` `TASK-7` ``) is not part
// of it; a leading `#` is kept, it marks a bare number.
const SURROUNDING = /^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu
const KEY = /^(?:([A-Z][A-Z0-9]*)(?:\s*-\s*|\s+)|#?)(\d+)$/

/**
 * Reads a search as the task key it names, or null for any other text:
 * `TASK-7` with any dash, `task 7`, `TASK-7:` and other surrounding
 * punctuation, `#7` and `7`. The project is upper-cased and not checked
 * against any project.
 */
export function readTaskKeyQuery(query: string): TaskKeyQuery | null {
  const match = KEY.exec(query.replace(DASHES, '-').replace(SURROUNDING, '').toUpperCase())
  return match ? { project: match[1] ?? null, number: Number(match[2]) } : null
}
