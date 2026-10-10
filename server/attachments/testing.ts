// Shared by the attachment tests: a scope over an in-memory database with a
// real data directory, so files are written where the server writes them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { TasksEvent } from '../../shared/types.ts'
import { allMigrations, migrate } from '../db.ts'
import type { Scope } from '../service.ts'
import { attachmentsDir } from './files.ts'

export interface TestScope extends Scope {
  dataDir: string
  events: Array<{ keys: string[]; kind: TasksEvent['kind'] }>
}

/** A fresh data directory, removed when the test process exits. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-pipelines-attachments-'))
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The files in `attachments/`, not counting the `incoming/` directory. */
export function storedFiles(dataDir: string): string[] {
  return fs.existsSync(attachmentsDir(dataDir))
    ? fs.readdirSync(attachmentsDir(dataDir)).filter((name) => name !== 'incoming')
    : []
}

export function makeScope(actor: Scope['inv']['actor'] = { kind: 'agent', name: 'Ace (QA)' }): TestScope {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const dataDir = tempDataDir()
  migrate(db, allMigrations(), { dataDir })
  const events: TestScope['events'] = []
  return {
    db,
    dataDir,
    instanceId: 'inst-1',
    projectKey: 'TASK',
    inv: { ctx: {} as never, actor },
    notify: (keys, kind) => events.push({ keys, kind }),
    agents: async () => [],
    people: async () => [],
    events,
  }
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
