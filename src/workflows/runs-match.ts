// The runs one statistic counted, as the Workflows page carries them in its
// address: the Stats tab writes them when a count is clicked and the Runs tab
// reads them back, so the scoped list is a link and survives a reload.

import {
  COULDNT_START_REASONS,
  type CouldntStartKey,
  RUN_EXITS,
  type RunExit,
  type RunsMatch,
  STATS_RANGES,
  type StatsRange,
} from '../../shared/workflows'

type RunsMatchParam = 'range' | 'step' | 'exit' | 'transition' | 'rounds' | 'couldntStart'

/**
 * A match as query parameters. Every parameter is present, the unused ones as
 * null, so writing them replaces whatever an earlier match set; `null` clears
 * them all.
 */
export function runsMatchParams(match: RunsMatch | null): Record<RunsMatchParam, string | null> {
  return {
    range: match?.range ?? null,
    step: match?.step ?? null,
    exit: match?.exit ?? null,
    transition: match?.transition ?? null,
    rounds: match?.rounds ? String(match.rounds) : null,
    couldntStart: match?.couldntStart ?? null,
  }
}

const COULDNT_START_KEYS: readonly string[] = [...COULDNT_START_REASONS, 'unrecorded']
const ROUNDS = ['1', '2', '3', '4']

/**
 * The match an address carries, or null when it names no step. A criterion
 * with a value this version does not know is left out, as the label built
 * from the match then says.
 */
export function runsMatchOf(query: URLSearchParams): RunsMatch | null {
  const step = query.get('step')
  if (!step) {
    return null
  }
  const range = query.get('range') ?? ''
  const exit = query.get('exit') ?? ''
  const transition = query.get('transition')
  const rounds = query.get('rounds') ?? ''
  const couldntStart = query.get('couldntStart') ?? ''
  return {
    range: (STATS_RANGES as readonly string[]).includes(range) ? (range as StatsRange) : '30d',
    step,
    ...((RUN_EXITS as readonly string[]).includes(exit) ? { exit: exit as RunExit } : {}),
    ...(exit === 'sent_back' && transition ? { transition } : {}),
    ...(ROUNDS.includes(rounds) ? { rounds: Number(rounds) as RunsMatch['rounds'] } : {}),
    ...(COULDNT_START_KEYS.includes(couldntStart) ? { couldntStart: couldntStart as CouldntStartKey } : {}),
  }
}
