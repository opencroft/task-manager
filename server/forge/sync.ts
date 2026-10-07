// One read of the forge for one project: which repositories had pull
// requests change since the cursor, those pull requests, the task keys each
// one mentions, and the links written. Run by the poller once a minute, and
// at once when a person connects.

import type { PullRequestState } from '../../shared/types.ts'
import type { Db } from '../db.ts'
import type { ForgeClient, ForgePull } from './api.ts'
import { type PullRequestInput, existingNumbers, readConnection, recordSync, writePullRequests } from './store.ts'

// The cursor is set back this far on each read, so a pull request updated
// while the previous read ran, or stamped by a forge clock a little behind
// ours, is read again rather than missed. Writing one twice changes nothing.
const OVERLAP_MS = 2 * 60 * 1000

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const keyPattern = (projectKey: string, flags: string) => new RegExp(`(?<![A-Za-z0-9])${escape(projectKey)}-(\\d+)(?!\\d)`, flags)

const numbersIn = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => Number(match[1]))

/** The task numbers in a branch name, whatever its case (`fix-demo-12-dates`). */
export function branchNumbers(projectKey: string, branch: string): number[] {
  return branch.startsWith('refs/pull/') ? [] : numbersIn(branch, keyPattern(projectKey, 'gi'))
}

/** The task numbers a pull request mentions: `<KEY>-<n>` in its title or body as written, and in its branch in any case. */
export function mentionedNumbers(projectKey: string, pull: Pick<ForgePull, 'title' | 'body' | 'headRef'>): number[] {
  const inText = keyPattern(projectKey, 'g')
  const numbers = new Set([...numbersIn(pull.title, inText), ...numbersIn(pull.body, inText), ...branchNumbers(projectKey, pull.headRef)])
  return [...numbers].sort((a, b) => a - b)
}

export function pullState(pull: Pick<ForgePull, 'state' | 'merged'>): PullRequestState {
  return pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed'
}

export interface SyncResult {
  /** Pull requests read in this pass. */
  read: number
  /** Numbers of existing tasks whose links changed. */
  changed: number[]
}

/** One read. Throws on a forge failure after recording it; the cursor then stays where it was. */
export async function syncOnce(db: Db, projectKey: string, client: ForgeClient, now: () => Date = () => new Date()): Promise<SyncResult> {
  const connection = readConnection(db)
  if (!connection) {
    return { read: 0, changed: [] }
  }
  const startedAt = now()
  const since = connection.cursor
  try {
    const repos = await client.changedRepos(connection.owner, since)
    const found: PullRequestInput[] = []
    for (const repo of repos) {
      for (const pull of await client.pulls(repo, since)) {
        found.push({
          repo,
          number: pull.number,
          title: pull.title,
          state: pullState(pull),
          author: pull.author,
          url: pull.url,
          branch: pull.headRef && !pull.headRef.startsWith('refs/pull/') ? pull.headRef : null,
          updatedAt: pull.updatedAt,
          mentions: mentionedNumbers(projectKey, { ...pull, headRef: '' }),
        })
      }
    }
    const touched = writePullRequests(db, found, (branch) => branchNumbers(projectKey, branch))
    recordSync(db, { at: now().toISOString(), cursor: new Date(startedAt.getTime() - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z') })
    return { read: found.length, changed: existingNumbers(db, touched) }
  } catch (error) {
    recordSync(db, { at: now().toISOString(), error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
