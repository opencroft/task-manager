// The forge links in the project's database: the saved connection and its
// cursor, the pull requests read, and which task numbers each one mentions.
// Reads join on the task number, so the task side needs no bookkeeping.

import type { ForgeConnection, ForgeStatus } from '../../shared/forge.ts'
import type { LinkedPullRequest, PullRequestCounts, PullRequestState } from '../../shared/types.ts'
import { type Db, transaction } from '../db.ts'
import type { Scope } from '../service.ts'

/** A pull request as the sync writes it. */
export interface PullRequestInput {
  repo: string
  number: number
  title: string
  state: PullRequestState
  author: string
  url: string
  /** Null when the forge no longer reports a branch (deleted after a merge). */
  branch: string | null
  updatedAt: string
  /** Task numbers mentioned in the title or body. The branch's are added by `writePullRequests`, from the branch it keeps. */
  mentions: number[]
}

/** The task numbers with an open pull request mentioning them, as SQL for `IN (…)`. */
export const OPEN_PR_NUMBERS = `SELECT m.number FROM pull_request_mention m JOIN pull_request pr ON pr.id = m.pr_id WHERE pr.state = 'open'`

/** A row's comma-separated states as counts. */
export function countPullRequests(states: string | null): PullRequestCounts {
  const counts: PullRequestCounts = { open: 0, merged: 0, closed: 0 }
  for (const state of states ? states.split(',') : []) {
    if (state === 'open' || state === 'merged' || state === 'closed') {
      counts[state]++
    }
  }
  return counts
}

interface PullRequestRow {
  id: number
  repo: string
  number: number
  title: string
  state: PullRequestState
  author: string
  url: string
  branch: string | null
  updated_at: string
}

const toLinked = (row: PullRequestRow): LinkedPullRequest => ({
  repo: row.repo,
  number: row.number,
  title: row.title,
  state: row.state,
  author: row.author,
  url: row.url,
  branch: row.branch,
  updatedAt: row.updated_at,
})

/** The pull requests mentioning task number `number`: open ones first, then the most recently updated. */
export function pullRequestsOf(scope: Scope, number: number): LinkedPullRequest[] {
  const rows = scope.db
    .prepare(
      `SELECT pr.* FROM pull_request_mention m JOIN pull_request pr ON pr.id = m.pr_id WHERE m.number = ?
       ORDER BY pr.state = 'open' DESC, pr.updated_at DESC, pr.repo, pr.number DESC`,
    )
    .all(number) as unknown as PullRequestRow[]
  return rows.map(toLinked)
}

interface ConnectionRow {
  url: string
  owner: string
  secret_key: string
  cursor: string | null
  last_sync_at: string | null
  last_error: string | null
}

function connectionRow(db: Db): ConnectionRow | undefined {
  return db.prepare('SELECT * FROM forge_connection WHERE id = 1').get() as ConnectionRow | undefined
}

export function readConnection(db: Db): (ForgeConnection & { cursor: string | null }) | null {
  const row = connectionRow(db)
  return row ? { url: row.url, owner: row.owner, secretKey: row.secret_key, cursor: row.cursor } : null
}

export function readStatus(db: Db): ForgeStatus {
  const row = connectionRow(db)
  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM pull_request) AS total,
         (SELECT count(DISTINCT m.pr_id) FROM pull_request_mention m JOIN task t ON t.number = m.number) AS linked`,
    )
    .get() as { total: number; linked: number }
  return {
    connection: row ? { url: row.url, owner: row.owner, secretKey: row.secret_key } : null,
    lastSyncAt: row?.last_sync_at ?? null,
    lastError: row?.last_error ?? null,
    pullRequests: counts.total,
    linked: counts.linked,
  }
}

/**
 * Save the connection. A different address or owner starts over: the pull
 * requests read from the old one go, and the cursor with them.
 */
export function saveConnection(db: Db, connection: ForgeConnection): void {
  transaction(db, () => {
    const before = connectionRow(db)
    const same = before && before.url === connection.url && before.owner === connection.owner
    if (!same) {
      db.exec('DELETE FROM pull_request')
    }
    db.prepare(
      `INSERT INTO forge_connection (id, url, owner, secret_key, cursor, last_sync_at, last_error) VALUES (1, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, owner = excluded.owner, secret_key = excluded.secret_key,
         cursor = excluded.cursor, last_sync_at = excluded.last_sync_at, last_error = NULL`,
    ).run(
      connection.url,
      connection.owner,
      connection.secretKey,
      same ? before.cursor : null,
      same ? before.last_sync_at : null,
    )
  })
}

/** Forget the connection and everything read through it. */
export function deleteConnection(db: Db): void {
  transaction(db, () => {
    db.exec('DELETE FROM forge_connection')
    db.exec('DELETE FROM pull_request')
  })
}

/** Record how a read went; the cursor moves only on success. */
export function recordSync(db: Db, outcome: { at: string; cursor?: string; error?: string }): void {
  db.prepare(
    'UPDATE forge_connection SET last_sync_at = ?, last_error = ?, cursor = coalesce(?, cursor) WHERE id = 1',
  ).run(outcome.at, outcome.error ?? null, outcome.cursor ?? null)
}

/**
 * Write what a read found, in one transaction. A pull request whose branch
 * the forge no longer reports keeps the one read while it was open, and the
 * task numbers in it: `branchMentions` reads them from whichever branch is
 * kept. Returns the task numbers whose links changed: mentioned before or now
 * by a pull request that is new, or whose title, state, author, branch or
 * mentions changed.
 */
export function writePullRequests(
  db: Db,
  prs: PullRequestInput[],
  branchMentions: (branch: string) => number[],
): number[] {
  const touched = new Set<number>()
  transaction(db, () => {
    const find = db.prepare('SELECT * FROM pull_request WHERE repo = ? AND number = ?')
    const mentionsOf = db.prepare('SELECT number FROM pull_request_mention WHERE pr_id = ? ORDER BY number')
    const insert = db.prepare(
      'INSERT INTO pull_request (repo, number, title, state, author, url, branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const update = db.prepare(
      'UPDATE pull_request SET title = ?, state = ?, author = ?, url = ?, branch = ?, updated_at = ? WHERE id = ?',
    )
    const clearMentions = db.prepare('DELETE FROM pull_request_mention WHERE pr_id = ?')
    const addMention = db.prepare('INSERT OR IGNORE INTO pull_request_mention (pr_id, number) VALUES (?, ?)')
    for (const pr of prs) {
      const before = find.get(pr.repo, pr.number) as PullRequestRow | undefined
      const branch = pr.branch ?? before?.branch ?? null
      const mentions = [...new Set([...pr.mentions, ...(branch ? branchMentions(branch) : [])])].sort((a, b) => a - b)
      let id: number
      let changed: boolean
      let old: number[] = []
      if (before) {
        id = before.id
        old = (mentionsOf.all(id) as Array<{ number: number }>).map((row) => row.number)
        changed =
          before.title !== pr.title ||
          before.state !== pr.state ||
          before.author !== pr.author ||
          before.branch !== branch ||
          old.join(',') !== mentions.join(',')
        update.run(pr.title, pr.state, pr.author, pr.url, branch, pr.updatedAt, id)
      } else {
        id = Number(
          insert.run(pr.repo, pr.number, pr.title, pr.state, pr.author, pr.url, branch, pr.updatedAt).lastInsertRowid,
        )
        changed = mentions.length > 0
      }
      if (!changed) {
        continue
      }
      clearMentions.run(id)
      for (const number of mentions) {
        addMention.run(id, number)
      }
      for (const number of [...old, ...mentions]) {
        touched.add(number)
      }
    }
  })
  return [...touched].sort((a, b) => a - b)
}

/** The task numbers that exist among `numbers`. */
export function existingNumbers(db: Db, numbers: number[]): number[] {
  if (numbers.length === 0) {
    return []
  }
  const rows = db
    .prepare(`SELECT number FROM task WHERE number IN (${numbers.map(() => '?').join(',')})`)
    .all(...numbers) as Array<{ number: number }>
  return rows.map((row) => row.number)
}
