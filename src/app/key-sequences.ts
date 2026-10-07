// Matches key presses against a shortcut set given as data: chords (`mod`+K)
// and sequences (G then T). Pure and DOM-free, so the shell's handler, the
// help dialog and the palette's hints all read the one list.

export interface ShortcutDef {
  id: string
  /** Each inner list is one chord pressed together; a later list follows the one before. */
  keys: string[][]
}

/** One key press, as the parts of a keyboard event this reads. */
export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** How long the next key of a sequence may take. */
export const SEQUENCE_TIMEOUT_MS = 1500

const KEY_NAMES: Record<string, string> = { Escape: 'Esc' }

/**
 * The key's name as the shortcut set writes it: a letter upper-cased, Escape
 * as `Esc`. A letter typed on a non-Latin layout is read from its physical
 * key, so J is J on any layout.
 */
export function keyName(press: Pick<KeyPress, 'key' | 'code'>): string {
  const letter = /^Key([A-Z])$/.exec(press.code)
  if (letter && !/^[a-z]$/i.test(press.key)) {
    return letter[1]
  }
  return KEY_NAMES[press.key] ?? (press.key.length === 1 ? press.key.toUpperCase() : press.key)
}

/**
 * A press as a chord string. `mod` is ⌘ on a Mac and Ctrl elsewhere; the other
 * of the two counts as `ctrl`, so a plain-key shortcut never fires under a
 * browser or system chord. Shift is not part of a chord: it is what makes `?`.
 */
export function chordOf(press: KeyPress, mac: boolean): string {
  const modifiers = [
    (mac ? press.metaKey : press.ctrlKey) && 'mod',
    (mac ? press.ctrlKey : press.metaKey) && 'ctrl',
    press.altKey && 'alt',
  ].filter(Boolean)
  return [...modifiers, keyName(press)].join('+')
}

export type MatchResult = { kind: 'match'; ids: string[] } | { kind: 'pending' } | { kind: 'none' }

/**
 * A matcher over a shortcut set. Feed it every press outside a field; it
 * answers the ids a finished sequence names (several when one key means
 * different things on different pages), `pending` while a sequence is half
 * typed, or `none`.
 */
export function createKeyMatcher(shortcuts: ShortcutDef[], timeoutMs = SEQUENCE_TIMEOUT_MS) {
  const sequences = shortcuts.map((shortcut) => ({ id: shortcut.id, steps: shortcut.keys.map((chord) => chord.join('+')) }))
  let pending: string[] = []
  let pendingAt = 0

  const lookup = (steps: string[]): MatchResult => {
    const ids = sequences.filter((s) => s.steps.length === steps.length && s.steps.every((step, i) => step === steps[i])).map((s) => s.id)
    if (ids.length > 0) {
      return { kind: 'match', ids }
    }
    const prefix = sequences.some((s) => s.steps.length > steps.length && steps.every((step, i) => s.steps[i] === step))
    return prefix ? { kind: 'pending' } : { kind: 'none' }
  }

  return {
    press(chord: string, now: number): MatchResult {
      if (now - pendingAt > timeoutMs) {
        pending = []
      }
      let steps = [...pending, chord]
      let result = lookup(steps)
      // A key that does not continue the sequence starts over on its own.
      if (result.kind === 'none' && pending.length > 0) {
        steps = [chord]
        result = lookup(steps)
      }
      pending = result.kind === 'pending' ? steps : []
      pendingAt = now
      return result
    },
    reset() {
      pending = []
    },
  }
}
