import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TASK_MANAGER_SHORTCUTS } from '../src/components/ui/navigation/keyboard-shortcuts-dialog'
import { SEQUENCE_TIMEOUT_MS, chordOf, createKeyMatcher, keyName } from '../src/app/key-sequences'

const SET = TASK_MANAGER_SHORTCUTS.flatMap((group) => group.shortcuts)

function press(key: string, extra: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) {
  const code = extra.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '')
  return { key, code, ctrlKey: false, metaKey: false, altKey: false, ...extra }
}

describe('keyName', () => {
  it('upper-cases letters and names Escape as the set does', () => {
    assert.equal(keyName(press('j')), 'J')
    assert.equal(keyName(press('Escape')), 'Esc')
    assert.equal(keyName(press('Enter')), 'Enter')
    assert.equal(keyName(press('?', { code: 'Slash' })), '?')
  })

  it('reads a letter from its physical key on a non-Latin layout', () => {
    assert.equal(keyName(press('о', { code: 'KeyJ' })), 'J')
  })
})

describe('chordOf', () => {
  it('reads mod as Cmd on a Mac and Ctrl elsewhere', () => {
    assert.equal(chordOf(press('k', { metaKey: true }), true), 'mod+K')
    assert.equal(chordOf(press('k', { ctrlKey: true }), false), 'mod+K')
  })

  it('keeps the other modifier apart, so plain-key shortcuts stay quiet under it', () => {
    assert.equal(chordOf(press('k', { ctrlKey: true }), true), 'ctrl+K')
    assert.equal(chordOf(press('c', { metaKey: true }), false), 'ctrl+C')
    assert.equal(chordOf(press('c', { altKey: true }), false), 'alt+C')
  })
})

describe('createKeyMatcher over the kit set', () => {
  it('matches single keys, naming every page meaning a key has', () => {
    const matcher = createKeyMatcher(SET)
    assert.deepEqual(matcher.press('mod+K', 0), { kind: 'match', ids: ['command-palette'] })
    assert.deepEqual(matcher.press('?', 10), { kind: 'match', ids: ['shortcuts'] })
    assert.deepEqual(matcher.press('J', 20), { kind: 'match', ids: ['select-next'] })
    assert.deepEqual(matcher.press('E', 30), { kind: 'match', ids: ['edit-summary', 'details-edit-summary'] })
    assert.deepEqual(matcher.press('Esc', 40), { kind: 'match', ids: ['escape', 'details-back'] })
  })

  it('matches G then a page key as a sequence', () => {
    const matcher = createKeyMatcher(SET)
    assert.deepEqual(matcher.press('G', 0), { kind: 'pending' })
    assert.deepEqual(matcher.press('T', 100), { kind: 'match', ids: ['go-tasks'] })
    assert.deepEqual(matcher.press('G', 200), { kind: 'pending' })
    assert.deepEqual(matcher.press('L', 300), { kind: 'match', ids: ['go-timeline'] })
  })

  it('forgets a half-typed sequence after the timeout', () => {
    const matcher = createKeyMatcher(SET)
    matcher.press('G', 0)
    assert.deepEqual(matcher.press('T', SEQUENCE_TIMEOUT_MS + 1), { kind: 'none' })
  })

  it('lets a key that does not continue the sequence act on its own', () => {
    const matcher = createKeyMatcher(SET)
    matcher.press('G', 0)
    assert.deepEqual(matcher.press('J', 100), { kind: 'match', ids: ['select-next'] })
    assert.deepEqual(matcher.press('T', 200), { kind: 'none' })
  })

  it('starts over after reset', () => {
    const matcher = createKeyMatcher(SET)
    matcher.press('G', 0)
    matcher.reset()
    assert.deepEqual(matcher.press('T', 100), { kind: 'none' })
  })

  it('answers none for keys outside the set', () => {
    const matcher = createKeyMatcher(SET)
    assert.deepEqual(matcher.press('X', 0), { kind: 'none' })
    assert.deepEqual(matcher.press('ctrl+C', 10), { kind: 'none' })
  })
})
