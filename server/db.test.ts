import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { coreMigrations, type Migration, migrate } from './db.ts'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

test('migrate applies core migrations once and records them', () => {
  const db = fresh()
  assert.deepEqual(migrate(db, coreMigrations), ['core-0001-init'])
  assert.deepEqual(migrate(db, coreMigrations), [])
  const statuses = db.prepare('SELECT name, category FROM status ORDER BY position').all()
  assert.equal(statuses.length, 5)
  assert.equal(
    (db.prepare("SELECT value FROM project_meta WHERE key = 'next_number'").get() as { value: string }).value,
    '1',
  )
})

test('a failing migration rolls back and is not recorded', () => {
  const db = fresh()
  const broken: Migration = {
    id: 'test-0001-broken',
    up(d) {
      d.exec('CREATE TABLE half (x)')
      throw new Error('boom')
    },
  }
  assert.throws(() => migrate(db, [...coreMigrations, broken]), /boom/)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'").get()?.n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id = 'test-0001-broken'").get()?.n, 0)
})

test('task table enforces both-or-neither dates and end >= start', () => {
  const db = fresh()
  migrate(db, coreMigrations)
  const insert = db.prepare(
    `INSERT INTO task (number, summary, status_id, reporter_kind, reporter_name, rank, start_date, end_date, created_at, updated_at)
     VALUES (?, 's', 1, 'person', 'user', 'a', ?, ?, 'now', 'now')`,
  )
  insert.run(1, '2026-01-01', '2026-01-03')
  assert.throws(() => insert.run(2, '2026-01-01', null), /CHECK constraint failed/)
  assert.throws(() => insert.run(3, '2026-01-05', '2026-01-03'), /CHECK constraint failed/)
})

test('fts index follows inserts, updates and cascaded deletes', () => {
  const db = fresh()
  migrate(db, coreMigrations)
  const insert = db.prepare(
    `INSERT INTO task (number, summary, status_id, reporter_kind, reporter_name, rank, parent_id, created_at, updated_at)
     VALUES (?, ?, 1, 'person', 'user', 'a', ?, 'now', 'now')`,
  )
  const parent = insert.run(1, 'Parent about kanban', null).lastInsertRowid
  insert.run(2, 'Child about timeline', parent)
  const search = (q: string) =>
    (db.prepare('SELECT count(*) AS n FROM task_fts WHERE task_fts MATCH ?').get(q) as { n: number }).n
  assert.equal(search('"imeli"'), 1)
  db.prepare("UPDATE task SET summary = 'Child about board' WHERE number = 2").run()
  assert.equal(search('"imeli"'), 0)
  assert.equal(search('"boar"'), 1)
  db.prepare('DELETE FROM task WHERE id = ?').run(parent)
  assert.equal((db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 0)
  assert.equal(search('"boar"'), 0)
})

test('an open instance database picks up migrations added after it was opened', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { instanceDb, closeInstanceDb } = await import('./db.ts')
  const { workflowMigrations } = await import('./workflows/migrations.ts')
  const dir = mkdtempSync(join(tmpdir(), 'tasks-db-'))
  const db = instanceDb('late-migration', dir)
  const added: Migration = { id: 'test-9999-late', up: (d) => d.exec('CREATE TABLE late_table (x)') }
  workflowMigrations.push(added)
  try {
    assert.equal(instanceDb('late-migration', dir), db)
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'late_table'").get() as { n: number }).n,
      1,
    )
  } finally {
    workflowMigrations.splice(workflowMigrations.indexOf(added), 1)
    closeInstanceDb('late-migration')
    rmSync(dir, { recursive: true, force: true })
  }
})
